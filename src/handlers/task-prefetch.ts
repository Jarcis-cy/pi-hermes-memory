/**
 * Task prefetch — recall a few prior events for the prompt that is about to run.
 *
 * The principle layer is a distilled default set; the episodic ledger is where
 * the evidence lives. Until now the ledger was pull-only: the model had to decide
 * to call `memory_search`, which it cannot do reliably because it does not know
 * what it has forgotten. This module turns one cheap FTS query into a handful of
 * dated leads at the start of the run, and says plainly that they are leads.
 *
 * Contracts:
 * - Pure read: never writes to the database, never mutates the prompt.
 * - Best effort: any error (missing table, malformed query, closed database)
 *   returns `""` so a healthy agent run never depends on memory health.
 * - Bounded: at most `limit` entries, each truncated, so the block cannot grow
 *   with history size.
 * - Empty in, empty out: a short prompt, a slash command, or a prompt with no
 *   usable terms yields no block rather than a weakly related one.
 */
import type { DatabaseManager } from "../store/db.js";
import { searchMemoryEvents } from "../store/event-memory-store.js";
import { TASK_RELEVANCE_STRONG, buildTaskSearchQuery, extractTaskTerms, isIdentifierTerm, scoreTaskRelevance } from "../store/task-terms.js";

/** Maximum leads injected per run. Small on purpose: each line competes for the
 * same attention the principles already use. */
export const TASK_PREFETCH_MAX_ENTRIES = 5;

/** Prompts shorter than this are greetings, acknowledgements, or one-word
 * commands; matching them produces noise, not recall. */
export const TASK_PREFETCH_MIN_PROMPT_CHARS = 12;

/** Per-entry content cap. Long enough to recognise the situation, short enough
 * that five lines stay cheap. */
const TASK_PREFETCH_ENTRY_CHARS = 240;

/** Candidates pulled from FTS before relevance ranking. */
const TASK_PREFETCH_CANDIDATES = 24;

function sanitize(text: string): string {
  return text.replace(/<\/?task-prefetch[^>]*>/gi, " ").replace(/\s+/g, " ").trim();
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "undated";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Build the `<task-prefetch>` block for one agent run.
 *
 * @param dbManager Open database manager, or `null` for lazy sessions that must
 *   not touch SQLite; `null` returns `""`.
 * @param prompt The raw prompt Pi is about to answer.
 * @param options `project` biases ranking toward the current project without
 *   excluding shared events; `limit` overrides the entry cap.
 * @returns A prompt block, or `""` when nothing worth recalling was found.
 */
export function buildTaskPrefetchBlock(
  dbManager: DatabaseManager | null,
  prompt: string,
  options: { project?: string | null; limit?: number } = {},
): string {
  if (!dbManager) return "";
  const text = prompt?.trim() ?? "";
  if (text.length < TASK_PREFETCH_MIN_PROMPT_CHARS) return "";
  // Slash commands are control-plane, not work: their arguments are usually a
  // path or an id, and recalling unrelated history only adds noise.
  if (text.startsWith("/")) return "";

  const query = buildTaskSearchQuery(text);
  if (!query) return "";
  const terms = extractTaskTerms(text);
  if (terms.length === 0) return "";
  // No machine identifier in the prompt means no reliable bridge into the
  // ledger; see isIdentifierTerm.
  const identifierTerms = terms.filter(isIdentifierTerm);
  if (identifierTerms.length === 0) return "";

  let candidates;
  try {
    candidates = searchMemoryEvents(dbManager, query, { limit: TASK_PREFETCH_CANDIDATES });
  } catch {
    return "";
  }
  if (candidates.length === 0) return "";

  const project = options.project ?? null;
  const ranked = candidates
    .map((event) => ({
      event,
      score: scoreTaskRelevance(event.content, terms) + (project && event.project === project ? 1 : 0),
    }))
    .filter((entry) => entry.score >= TASK_RELEVANCE_STRONG
      && identifierTerms.some((term) => entry.event.content.toLowerCase().includes(term)))
    .sort((a, b) => (b.score - a.score) || (b.event.occurredAt || b.event.createdAt).localeCompare(a.event.occurredAt || a.event.createdAt));

  const limit = Math.max(1, options.limit ?? TASK_PREFETCH_MAX_ENTRIES);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { event } of ranked) {
    if (lines.length >= limit) break;
    const body = sanitize(event.content);
    const fingerprint = body.slice(0, 60).toLowerCase();
    if (body.length === 0 || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const trimmed = body.length > TASK_PREFETCH_ENTRY_CHARS ? `${body.slice(0, TASK_PREFETCH_ENTRY_CHARS - 3)}...` : body;
    lines.push(`- ${formatDate(event.occurredAt || event.createdAt)} · E${event.id} · ${trimmed}`);
  }
  if (lines.length === 0) return "";

  return [
    "<task-prefetch>",
    "Prior events that matched this prompt. They are leads from the episodic ledger, not current truth:",
    "verify before relying, and treat a contradicting observation as newer than any line here.",
    ...lines,
    "(memory_search finds more; session_search reads the original conversation.)",
    "</task-prefetch>",
  ].join("\n");
}
