import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import type { DatabaseManager } from "../store/db.js";
import {
  applyConcretionPlan,
  failConcretionRun,
  getAllActivePrinciples,
  getMemoryEvents,
  getPrincipleUsageSignals,
  getPendingConcretionStats,
  startConcretionRun,
  writePrinciplesSnapshot,
  type ConcretionCandidate,
  type ConcretionCandidateAction,
  type ConcretionTrigger,
  type EventScope,
} from "../store/event-memory-store.js";
import { DEFAULT_PRINCIPLE_CHAR_LIMIT, DEFAULT_PRINCIPLE_STORE_CHAR_LIMIT, PRINCIPLES_FILE } from "../constants.js";
import { tokenizeForMatch } from "../store/text-similarity.js";
import type { MemoryConfig } from "../types.js";
import { execChildPrompt, cleanChildStderr } from "./pi-child-process.js";
import {
  extractPayloadWithArrayKeys,
  runDirectJsonCompletion,
  usesDirectTransport,
} from "./review-memory-ops.js";

const CANDIDATE_ACTIONS = new Set<ConcretionCandidateAction>(["add", "reinforce", "refine", "merge", "conflict", "none"]);
const SCOPES = new Set<EventScope>(["global", "user", "project"]);
const LOCK_STALE_MS = 180_000;

export const CONCRETION_SYSTEM_PROMPT = `You perform a bounded reflection over episodic memory and the agent's current adaptive principles.

Your task is to decide whether the supplied concrete events justify generalized, event-independent lessons that should guide future behavior. The output is not a summary of events. It is a conservative proposal for durable behavioral defaults.

A good adaptive principle:
- applies beyond one named task, file, person, version, or incident;
- would prevent repeated mistakes, reduce risk, or encode a stable user preference;
- remains useful even if the source event is later forgotten;
- states a behavior, decision rule, or diagnostic habit, with necessary conditions;
- is concise and falsifiable enough to be revised by future evidence.

Do not promote one-off status, paths, IDs, benchmark numbers, completed outcomes, or isolated wording corrections unless they support a broader lesson. Do not infer more than the events support.

Compare every candidate with the active principles:
- add: genuinely new and compatible principle;
- reinforce: same principle, new supporting evidence; do not rewrite it;
- refine: compatible improvement of exactly one existing principle; supply its id;
- merge: several near-duplicate or over-specific existing principles become ONE shorter
  principle; supply every superseded id in existing_principle_ids (at least two) and put the
  merged wording in content. A merge is the ONLY way to shrink a store that is over budget,
  so prefer it whenever the budget note below says the set is full or nearly full;
- conflict: incompatible, ambiguous, or tradeoff-bearing candidate; never decide silently;

Self-reference warning: sessions that operate ON the memory system (merging principles,
resolving conflicts, tuning budgets) produce events that describe principles already in
force. When an event reports the agent applying, renaming, merging, or testing an existing
principle, classify it as reinforce of that principle — or as none — never as a new
principle that restates what is already in force. The same applies to any event quoting
text that is already an active principle.
- none: no principle should be formed from those events.

Every supplied event MUST appear in at least one candidate's source_event_ids. Group related events in one candidate when appropriate. If an event does not support any principle, include it in an action "none" candidate. Every non-none candidate MUST cite valid source_event_ids from the supplied batch. A project-scoped principle must cite events from exactly one project. Existing principle IDs must be copied exactly. Do not call tools or modify storage.

Respond with JSON only:
{
  "candidates": [
    {
      "action": "merge",
      "scope": "global",
      "content": "Merged, shorter wording of the two principles",
      "rationale": "Both principles describe the same rule at different levels of detail",
      "source_event_ids": [1],
      "existing_principle_ids": [4, 9],
      "conflict_reason": ""
    },
    {
      "action": "add",
      "scope": "global",
      "content": "Generalized behavioral principle",
      "rationale": "Why the cited events support it",
      "source_event_ids": [1],
      "existing_principle_ids": [],
      "conflict_reason": ""
    }
  ]
}

If the whole batch warrants no principle, return {"candidates":[]}. If only some events warrant a principle, classify the remaining event IDs with action "none".`;

export interface ConcretionDeps {
  runDirectJsonCompletion?: typeof runDirectJsonCompletion;
  execChildPrompt?: typeof execChildPrompt;
}

export interface ConcretionResult {
  ok: boolean;
  deferred?: boolean;
  eventCount: number;
  added: number;
  reinforced: number;
  refined: number;
  merged: number;
  conflicts: number;
  ignored: number;
  /** Candidates the model produced that could not be applied (dropped, not fatal). */
  skipped: number;
  /** Batch events left pending because no candidate classified them. */
  unclassified: number;
  error?: string;
}

function parsePositiveIntegerArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(Number);
  if (parsed.some((id) => !Number.isSafeInteger(id) || id <= 0)) return null;
  return [...new Set(parsed)];
}

export function parseConcretionResponse(text: string): ConcretionCandidate[] | null {
  const payload = extractPayloadWithArrayKeys(text, ['candidates']);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rawCandidates = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(rawCandidates)) return null;
  const candidates: ConcretionCandidate[] = [];
  for (const raw of rawCandidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const action = item.action as ConcretionCandidateAction;
    if (!CANDIDATE_ACTIONS.has(action)) return null;
    const sourceEventIds = parsePositiveIntegerArray(item.source_event_ids);
    const existingPrincipleIds = parsePositiveIntegerArray(item.existing_principle_ids);
    if (sourceEventIds === null || existingPrincipleIds === null || sourceEventIds.length === 0) return null;

    const scope = SCOPES.has(item.scope as EventScope) ? item.scope as EventScope : undefined;
    const content = typeof item.content === "string" ? item.content.trim() : undefined;
    const rationale = typeof item.rationale === "string" ? item.rationale.trim() : undefined;
    const conflictReason = typeof item.conflict_reason === "string" ? item.conflict_reason.trim() : undefined;
    if (action === "reinforce" && existingPrincipleIds.length !== 1) return null;
    if (action === "refine" && existingPrincipleIds.length !== 1) return null;
    if (action !== "reinforce" && action !== "none" && (!scope || !content)) return null;

    candidates.push({ action, scope, content, rationale, sourceEventIds, existingPrincipleIds, conflictReason });
  }
  return candidates;
}

export function buildConcretionUserPrompt(
  events: ReturnType<typeof getMemoryEvents>,
  principles: ReturnType<typeof getAllActivePrinciples>,
  usageSignals: ReturnType<typeof getPrincipleUsageSignals> | null = null,
  budgetUsage: { used: number; limit: number } | null = null,
): string {
  const eventLines = events.map((event) => JSON.stringify({
    id: event.id,
    scope: event.scope,
    project: event.project,
    kind: event.kind,
    content: event.content,
    evidence_quote: event.evidenceQuote,
    occurred_at: event.occurredAt,
  }));
  const principleLines = principles.map((principle) => JSON.stringify({
    id: principle.id,
    scope: principle.scope,
    project: principle.project,
    content: principle.content,
    rationale: principle.rationale,
    source_event_ids: principle.sourceEventIds,
  }));
  const budgetLines: string[] = [];
  if (budgetUsage) {
    const pct = budgetUsage.limit > 0 ? Math.floor((budgetUsage.used / budgetUsage.limit) * 100) : 0;
    budgetLines.push(
      `Active principles use ${budgetUsage.used} of ${budgetUsage.limit} characters (${pct}%).`,
      budgetUsage.used >= budgetUsage.limit
        ? "The set is OVER budget: additions and refinements will be recorded as conflicts instead of activating. Use merge to combine near-duplicate principles and bring the store back under budget."
        : "Prefer merge over add when two existing principles already say substantially the same thing.",
    );
  }
  const signalLines: string[] = [];
  if (usageSignals && usageSignals.size > 0) {
    for (const principle of principles) {
      const signal = usageSignals.get(principle.id);
      if (!signal) continue;
      const lastRecall = signal.lastHitAt ?? "never";
      signalLines.push(
        `- P${principle.id}: ${signal.sourceEventCount} source event(s), recalled ${signal.totalHits}× total, last recalled ${lastRecall}`,
      );
    }
  }
  const mergeLines = suggestMergePairs(principles);
  return [
    "--- Pending Events (JSONL) ---",
    ...eventLines,
    "",
    "--- Active Principles (JSONL) ---",
    ...(principleLines.length ? principleLines : ["(none)"]),
    ...(mergeLines.length
      ? [
        "",
        "--- Pre-computed Merge Candidates ---",
        "These pairs of active principles are lexically the most alike (the system computed",
        "them for you). To merge a pair, copy BOTH ids into existing_principle_ids of a merge",
        "candidate; never invent ids, and never merge principles that govern different rules.",
        ...mergeLines,
      ]
      : []),
    ...(budgetLines.length ? ["", "--- Principle Budget ---", ...budgetLines] : []),
    ...(signalLines.length
      ? [
        "",
        "--- Principle Usage Signals ---",
        "Recall counts show which principles' evidence is actually exercised in real work.",
        "A principle whose evidence has never been recalled is a weaker keep candidate when merging",
        "near-duplicates; one with frequent recall is load-bearing and must not be dropped.",
        ...signalLines,
      ]
      : []),
  ].join("\n");
}

/** Minimum lexical similarity for a pair to be offered as a merge candidate. */
export const MERGE_SUGGESTION_MIN_SIMILARITY = 0.5;
/** At most this many suggested pairs per prompt: enough to act on, small enough
 * not to crowd out events in the batch. */
export const MERGE_SUGGESTION_MAX_PAIRS = 8;

/**
 * Pre-computed near-duplicate pairs for the concretion prompt.
 *
 * Contract: pure function over the supplied principle list; touches no storage.
 * The model repeatedly failed to name merge targets on its own (30 malformed
 * merge attempts in two days), so the ids it needs are supplied instead of
 * inferred. Only same-scope pairs are offered — a merge must stay in scope —
 * and pairs are ranked by Jaccard similarity over the same tokenizer the
 * rest of the system uses.
 */
export function suggestMergePairs(
  principles: ReturnType<typeof getAllActivePrinciples>,
): string[] {
  if (principles.length < 2) return [];
  const tokens = new Map<number, Set<string>>();
  for (const principle of principles) {
    tokens.set(principle.id, new Set(tokenizeForMatch(principle.content)));
  }
  const pairs: Array<{ a: number; b: number; similarity: number; text: string }> = [];
  for (let i = 0; i < principles.length; i++) {
    for (let j = i + 1; j < principles.length; j++) {
      const left = principles[i]!;
      const right = principles[j]!;
      if (left.scope !== right.scope) continue;
      if (left.scope === "project" && left.project !== right.project) continue;
      const a = tokens.get(left.id)!;
      const b = tokens.get(right.id)!;
      if (a.size === 0 || b.size === 0) continue;
      let shared = 0;
      for (const token of a) if (b.has(token)) shared++;
      const similarity = shared / (a.size + b.size - shared);
      if (similarity < MERGE_SUGGESTION_MIN_SIMILARITY) continue;
      pairs.push({
        a: left.id,
        b: right.id,
        similarity,
        text: `- P${left.id} ↔ P${right.id} (${similarity.toFixed(2)}): ${left.content.slice(0, 60)} … | ${right.content.slice(0, 60)} …`,
      });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs.slice(0, MERGE_SUGGESTION_MAX_PAIRS).map((pair) => pair.text);
}

function emptyResult(overrides: Partial<ConcretionResult> = {}): ConcretionResult {
  return { ok: true, eventCount: 0, added: 0, reinforced: 0, refined: 0, merged: 0, conflicts: 0, ignored: 0, skipped: 0, unclassified: 0, ...overrides };
}

export async function runConcretion(
  pi: Pick<ExtensionAPI, "exec">,
  ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  dbManager: DatabaseManager,
  globalDir: string,
  config: MemoryConfig,
  trigger: ConcretionTrigger,
  deps: ConcretionDeps = {},
): Promise<ConcretionResult> {
  if (config.concretionEnabled === false) return emptyResult();
  const batchSize = Math.max(1, Math.min(config.concretionEventBatchSize ?? 100, 1000));
  const events = getMemoryEvents(dbManager, { pendingOnly: true, limit: batchSize });
  if (!events.length) return emptyResult();

  const coordinator = AtomicLockCoordinator.shared(path.join(globalDir, ".concretion-locks.sqlite"));
  const lease = coordinator.tryAcquire("adaptive-principles", { staleMs: LOCK_STALE_MS });
  if (!lease) return emptyResult({ ok: false, deferred: true, eventCount: events.length, error: "Concretion is already running in another session." });
  const heartbeat = setInterval(() => { try { lease.renew(); } catch {} }, 15_000);
  heartbeat.unref?.();
  let runId: number | null = null;
  try {
    // Re-read after acquiring the cross-process lock so a prior owner cannot make
    // us reflect over a stale batch.
    const lockedEvents = getMemoryEvents(dbManager, { pendingOnly: true, limit: batchSize });
    if (!lockedEvents.length) return emptyResult();
    const completePrinciples = getAllActivePrinciples(dbManager);

    runId = startConcretionRun(dbManager, trigger, lockedEvents.length);
    const principleCharLimit = config.principleCharLimit ?? DEFAULT_PRINCIPLE_CHAR_LIMIT;
    const storeCharLimit = config.principleStoreCharLimit ?? DEFAULT_PRINCIPLE_STORE_CHAR_LIMIT;
    const userPrompt = buildConcretionUserPrompt(
      lockedEvents,
      completePrinciples,
      getPrincipleUsageSignals(dbManager),
      {
        // The budget note must speak about the STORE limit: the model decides
        // adds/merges against storage capacity, not the per-run injection
        // budget. Feeding it the injection limit made every run after the
        // store crossed 16k beg for merges the model could not name targets
        // for (30 malformed merge attempts in two days).
        used: completePrinciples.reduce((sum, principle) => sum + principle.content.length, 0),
        limit: storeCharLimit,
      },
    );
    const runDirect = deps.runDirectJsonCompletion ?? runDirectJsonCompletion;
    const runChild = deps.execChildPrompt ?? execChildPrompt;
    let candidates: ConcretionCandidate[] | null = null;
    let directParseExcerpt: string | undefined;

    if (usesDirectTransport(config)) {
      try {
        const direct = await runDirect(ctx, {
          systemPrompt: CONCRETION_SYSTEM_PROMPT,
          userPrompt,
          config,
          timeoutMs: config.consolidationTimeoutMs,
        });
        if (direct.ok) {
          candidates = parseConcretionResponse(direct.text);
          // Keep an excerpt: if the fallback also fails, the error must say WHAT
          // the model actually returned, not just that it was unparsable.
          if (candidates === null) {
            directParseExcerpt = (direct.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || "(empty)";
          }
        }
      } catch {
        // Fall through to isolated subprocess.
      }
    }

    if (candidates === null) {
      const child = await runChild(
        pi,
        [CONCRETION_SYSTEM_PROMPT, "", userPrompt].join("\n"),
        config,
        { timeoutMs: config.consolidationTimeoutMs, jsonOnly: true },
      );
      if (child.code !== 0) {
        // Surface the child's own stderr: "exited with code 1" alone hid the
        // real cause (provider errors, auth, config) for 22 runs in two days.
        const detail = cleanChildStderr(child.stderr);
        throw new Error(
          `Concretion subprocess exited with code ${child.code}${detail ? `: ${detail}` : "."}`,
        );
      }
      candidates = parseConcretionResponse(child.stdout ?? "");
      if (candidates === null) {
        const excerpt = (child.stdout ?? "").replace(/\s+/g, " ").trim().slice(0, 400) || directParseExcerpt || "(empty)";
        throw new Error(`Concretion returned invalid JSON. Raw (truncated): ${excerpt}`);
      }
    }

    // The model occasionally cites source-event ids from outside this locked
    // batch (older runs, or invented). Provenance beyond the batch is not worth
    // failing a whole run: keep the in-batch ids, drop the rest, and drop
    // candidates that end up with none. Coverage of the batch is still enforced
    // by applyConcretionPlan, so an unclassified event remains a hard failure.
    const batchIds = new Set(lockedEvents.map((event) => event.id));
    candidates = candidates
      .map((candidate) => ({
        ...candidate,
        sourceEventIds: [...new Set(candidate.sourceEventIds.filter((id) => batchIds.has(id)))],
      }))
      .filter((candidate) => candidate.action === "none" || candidate.sourceEventIds.length > 0);

    const applied = applyConcretionPlan(dbManager, runId, lockedEvents, candidates, {
      charLimit: storeCharLimit,
    });
    await writePrinciplesSnapshot(dbManager, path.join(globalDir, PRINCIPLES_FILE), principleCharLimit);
    return {
      ok: true,
      eventCount: lockedEvents.length,
      added: applied.added,
      reinforced: applied.reinforced,
      refined: applied.refined,
      merged: applied.merged,
      conflicts: applied.conflicts,
      ignored: applied.ignored,
      skipped: applied.skipped,
      unclassified: applied.unclassified,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId !== null) {
      try { failConcretionRun(dbManager, runId, message); } catch {}
    }
    return emptyResult({ ok: false, eventCount: events.length, error: message });
  } finally {
    clearInterval(heartbeat);
    lease.release();
    AtomicLockCoordinator.closeShared(path.join(globalDir, ".concretion-locks.sqlite"));
  }
}

export function shouldRunAutomaticConcretion(dbManager: DatabaseManager, config: MemoryConfig): boolean {
  if (config.concretionEnabled === false) return false;
  const threshold = Math.max(1, config.concretionReviewThreshold ?? 10);
  return getPendingConcretionStats(dbManager).backgroundReviewCaptures >= threshold;
}

export function registerConcretionCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  globalDir: string,
  config: MemoryConfig,
  deps: ConcretionDeps = {},
): void {
  pi.registerCommand("memory-concretize", {
    description: "Reflect on pending episodic memories and update adaptive principles",
    handler: async (_args, ctx) => {
      const result = await runConcretion(pi, ctx, dbManager, globalDir, config, "manual", deps);
      if (result.deferred) {
        ctx.ui.notify(result.error ?? "Concretion is already running.", "warning");
        return;
      }
      if (!result.ok) {
        ctx.ui.notify(`Memory concretion failed: ${result.error ?? "unknown error"}`, "error");
        return;
      }
      ctx.ui.notify(
        `Memory concretion reviewed ${result.eventCount} event(s): ${result.added} added, ${result.refined} refined, ${result.reinforced} reinforced, ${result.merged} merged, ${result.conflicts} conflict(s), ${result.ignored} classified as needing no principle, ${result.skipped} skipped, ${result.unclassified} left pending.`,
        result.conflicts > 0 ? "warning" : "info",
      );
    },
  });
}
