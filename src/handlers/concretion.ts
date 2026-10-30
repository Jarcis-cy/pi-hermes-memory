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
import { DEFAULT_PRINCIPLE_CHAR_LIMIT, PRINCIPLES_FILE } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { execChildPrompt } from "./pi-child-process.js";
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
  return [
    "--- Pending Events (JSONL) ---",
    ...eventLines,
    "",
    "--- Active Principles (JSONL) ---",
    ...(principleLines.length ? principleLines : ["(none)"]),
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

function emptyResult(overrides: Partial<ConcretionResult> = {}): ConcretionResult {
  return { ok: true, eventCount: 0, added: 0, reinforced: 0, refined: 0, merged: 0, conflicts: 0, ignored: 0, ...overrides };
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
    const userPrompt = buildConcretionUserPrompt(
      lockedEvents,
      completePrinciples,
      getPrincipleUsageSignals(dbManager),
      {
        used: completePrinciples.reduce((sum, principle) => sum + principle.content.length, 0),
        limit: principleCharLimit,
      },
    );
    const runDirect = deps.runDirectJsonCompletion ?? runDirectJsonCompletion;
    const runChild = deps.execChildPrompt ?? execChildPrompt;
    let candidates: ConcretionCandidate[] | null = null;

    if (usesDirectTransport(config)) {
      try {
        const direct = await runDirect(ctx, {
          systemPrompt: CONCRETION_SYSTEM_PROMPT,
          userPrompt,
          config,
          timeoutMs: config.consolidationTimeoutMs,
        });
        if (direct.ok) candidates = parseConcretionResponse(direct.text);
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
      if (child.code !== 0) throw new Error(`Concretion subprocess exited with code ${child.code}.`);
      candidates = parseConcretionResponse(child.stdout ?? "");
      if (candidates === null) throw new Error("Concretion returned invalid JSON.");
    }

    const applied = applyConcretionPlan(dbManager, runId, lockedEvents, candidates, {
      charLimit: config.principleCharLimit ?? DEFAULT_PRINCIPLE_CHAR_LIMIT,
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
        `Memory concretion reviewed ${result.eventCount} event(s): ${result.added} added, ${result.refined} refined, ${result.reinforced} reinforced, ${result.conflicts} conflict(s).`,
        result.conflicts > 0 ? "warning" : "info",
      );
    },
  });
}
