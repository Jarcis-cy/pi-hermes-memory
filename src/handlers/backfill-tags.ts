/**
 * /memory-backfill-tags — one-shot semantic-topic backfill over the episodic
 * ledger.
 *
 * Every event whose `semantic_tags` is NULL gets model-emitted topic tags
 * (components, failure classes, themes — the keys the lexical ladder cannot
 * match, which is what makes the entity second hop able to bridge at all).
 * Batches run through the direct review transport; rows are claimed with
 * `WHERE semantic_tags IS NULL`, so the command is naturally resumable: a
 * re-run continues where the previous one stopped. Rows the model leaves
 * untagged are marked with an empty string (processed, zero tags) instead of
 * NULL so they are not retried forever.
 *
 * Run it in a session whose active model is cheap and fast (the tagger prompt
 * is small); the model choice follows the same resolution as background
 * review (llmModelOverride, else the session model).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseManager } from "../store/db.js";
import type { MemoryConfig } from "../types.js";
import { normalizeSemanticTags } from "../store/event-memory-store.js";
import { extractPayloadWithArrayKeys, runDirectJsonCompletion } from "./review-memory-ops.js";

/** Events per model call. Small enough to keep the prompt focused, large
 * enough that 31k events cost minutes, not hours. */
const BACKFILL_BATCH_SIZE = 20;

/** Default cap when the command is invoked without an explicit limit — a
 * sample big enough to judge tag quality before committing to the full run. */
const BACKFILL_DEFAULT_LIMIT = 200;

export const BACKFILL_TAGGER_SYSTEM_PROMPT = `You tag episodic memory events for later recall.

For each event you receive (id, kind, content, evidence quote), emit 0-4 topic
tags naming what the event is ABOUT: the component or system, the tool, the
failure class, the theme. Examples: "postgres-connection", "docker-daemon",
"release-gate", "flaky-test", "youtrack-api", "memory-injection-budget".

Rules:
- Lowercase, hyphenated, in the words the event itself uses; stay canonical
  and boring — prefer the component's plain name over synonyms.
- Do NOT list ticket ids, ports, file paths, URLs, or dates; those are indexed
  separately.
- Do NOT invent topics the event does not support; an empty list is a valid
  answer for a vague event.
- Keep to at most 4 tags per event.

Respond with JSON only:
{"tagged": [{"id": 123, "topics": ["sample-tag"]}]}`;

interface BackfillRow {
  id: number;
  kind: string;
  content: string;
  evidence_quote: string | null;
}

/** parseBackfillResponse maps a tagger response onto batch rows. Unknown ids
 * and non-string entries are dropped; tag normalization happens at write.
 * Returns null when the payload is not usable at all. */
export function parseBackfillResponse(text: string, batchIds: Set<number>): Map<number, string[]> {
  const payload = extractPayloadWithArrayKeys(text, ["tagged"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return new Map();
  const raw = (payload as { tagged?: unknown }).tagged;
  if (!Array.isArray(raw)) return new Map();
  const result = new Map<number, string[]>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as { id?: unknown; topics?: unknown };
    const id = Number(entry.id);
    if (!Number.isInteger(id) || !batchIds.has(id)) continue;
    // A malformed topics field is a skipped row, not a zero-tag answer — the
    // caller marks unmentioned rows as processed-zero either way.
    if (!Array.isArray(entry.topics)) continue;
    result.set(id, entry.topics.filter((t): t is string => typeof t === "string"));
  }
  return result;
}

/** registerBackfillTagsCommand wires /memory-backfill-tags [limit]. */
export function registerBackfillTagsCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  dbManager: DatabaseManager | null,
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">,
): void {
  pi.registerCommand("memory-backfill-tags", {
    description: "Backfill semantic topic tags on untagged ledger events (default 200; resumable)",
    handler: async (args, ctx) => {
      if (!dbManager) {
        ctx.ui.notify("memory-backfill-tags: memory database is not initialized", "error");
        return;
      }
      const limit = Math.max(1, Math.min(Number.parseInt(args.trim(), 10) || BACKFILL_DEFAULT_LIMIT, 50_000));
      const db = dbManager.getDb();
      const select = db.prepare(
        "SELECT id, kind, content, evidence_quote FROM memory_events WHERE semantic_tags IS NULL ORDER BY id ASC LIMIT ?",
      );
      const write = db.prepare(
        "UPDATE memory_events SET semantic_tags = ? WHERE id = ? AND semantic_tags IS NULL",
      );

      const started = Date.now();
      let processed = 0;
      let tagged = 0;
      let zeroTag = 0;
      let batches = 0;
      let failures = 0;

      while (processed < limit) {
        const rows = select.all(Math.min(BACKFILL_BATCH_SIZE, limit - processed)) as unknown as BackfillRow[];
        if (rows.length === 0) break;
        const batchIds = new Set(rows.map((row) => row.id));
        const userPrompt = [
          "Tag these events. Respond with JSON only:",
          ...rows.map((row) => JSON.stringify({
            id: row.id,
            kind: row.kind,
            content: row.content,
            evidence: row.evidence_quote ?? "",
          })),
        ].join("\n");

        const response = await runDirectJsonCompletion(ctx, { systemPrompt: BACKFILL_TAGGER_SYSTEM_PROMPT, userPrompt, config });
        if (!response.ok || !response.text) {
          failures++;
          if (failures >= 3) {
            ctx.ui.notify(`memory-backfill-tags: stopping after ${failures} transport failures (last: ${response.error ?? response.fallbackReason ?? "empty"})`, "error");
            break;
          }
          continue;
        }

        const parsed = parseBackfillResponse(response.text, batchIds);
        const transaction = db.transaction?.(() => {
          for (const row of rows) {
            const topics = parsed.get(row.id);
            // Unmentioned rows get the processed marker ('') so a re-run does
            // not retry them; mentioned-but-empty is the same answer.
            const normalized = topics === undefined ? [] : normalizeSemanticTags(topics);
            const serialized = normalized.length > 0 ? `|${normalized.join("|")}|` : "";
            write.run(serialized, row.id);
            if (normalized.length > 0) tagged++;
            else zeroTag++;
          }
        });
        if (transaction) transaction();
        else {
          for (const row of rows) {
            const topics = parsed.get(row.id);
            const normalized = topics === undefined ? [] : normalizeSemanticTags(topics);
            write.run(normalized.length > 0 ? `|${normalized.join("|")}|` : "", row.id);
            if (normalized.length > 0) tagged++;
            else zeroTag++;
          }
        }

        processed += rows.length;
        batches++;
        if (batches % 5 === 0) {
          ctx.ui.notify(`memory-backfill-tags: ${processed}/${limit} events (${tagged} tagged, ${zeroTag} zero-tag)`, "info");
        }
      }

      const remaining = (db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE semantic_tags IS NULL").get() as unknown as { n: number }).n;
      ctx.ui.notify(
        `memory-backfill-tags: done — ${processed} events in ${batches} batches (${tagged} tagged, ${zeroTag} zero-tag, ${failures} failed batches), ${((Date.now() - started) / 1000).toFixed(1)}s, ${remaining} still untagged`,
        processed > 0 ? "info" : "warning",
      );
    },
  });
}
