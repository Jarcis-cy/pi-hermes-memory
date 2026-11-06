/**
 * Task-term extraction and relevance scoring.
 *
 * The principle selector and the task prefetch both need the same answer to one
 * question: which parts of the user's prompt are worth matching against stored
 * text? They share this module so the two layers cannot drift into two private
 * notions of "relevant".
 *
 * Why terms instead of embeddings: both stores are already searched through
 * SQLite FTS5, and a live prompt is available on every run. A deterministic term
 * match buys most of the benefit with no model call, no index rebuild, and no
 * new persisted state — and it degrades into "no signal" instead of into a wrong
 * answer, which is what lets callers keep their existing ordering as a fallback.
 *
 * Stated limit: stored principles and events are mostly written in English while
 * prompts are mixed Chinese/English. Chinese terms therefore only match stored
 * Chinese text; cross-lingual weight is carried by ASCII identifiers (repo names,
 * ports, ticket ids, file names). A zero score means "no signal", never
 * "irrelevant".
 */

/** Upper bound on extracted terms; scoring runs once per stored row, so the
 * term list must stay small enough to keep a full principle scan cheap. */
export const MAX_TASK_TERMS = 48;

/** Score at which a principle counts as a strong match for the current task.
 * Weighted ASCII identifiers score 2 each, so this means "two real identifiers"
 * or "one identifier plus shared domain wording". */
export const TASK_RELEVANCE_STRONG = 4;

/** ASCII identifier-ish words. Ports (`25434`), ids (`iar-2000`), paths and
 * file names all survive this shape; prose words do too and are filtered by the
 * stop lists below. */
const ASCII_TERM_PATTERN = /[a-z0-9][a-z0-9._\-/]{2,}/g;

/** CJK runs, used for 2-gram scoring and 3-gram FTS queries. */
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/** English function words: never discriminating in this corpus. */
const ASCII_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "these", "those", "from", "into",
  "have", "has", "had", "was", "were", "are", "not", "but", "you", "your", "can",
  "could", "should", "would", "will", "shall", "may", "might", "must", "what",
  "which", "when", "where", "why", "how", "all", "any", "each", "every", "some",
  "such", "than", "then", "there", "here", "they", "them", "their", "its", "our",
  "out", "off", "over", "under", "again", "still", "just", "only", "also", "very",
  "more", "most", "much", "many", "does", "did", "doing", "done", "been", "being",
  "because", "before", "after", "while", "about", "above", "below", "between",
  "please", "thanks", "thank", "okay", "sure", "want", "need", "needs", "like",
  "let", "lets", "make", "makes", "get", "gets", "got", "see", "look", "looks",
  "now", "new", "old", "one", "two", "three", "yes", "no", "via", "per", "etc",
]);

/** Dev words common enough in this corpus to carry little signal; they keep a
 * non-zero weight (they are still evidence) but must not outrank an identifier. */
const ASCII_GENERIC = new Set([
  "code", "codes", "file", "files", "line", "lines", "test", "tests", "build",
  "run", "runs", "check", "checks", "fix", "fixes", "add", "adds", "use", "used",
  "uses", "using", "data", "work", "works", "task", "tasks", "step", "steps",
  "case", "cases", "way", "thing", "things", "time", "times", "value", "values",
  "name", "names", "path", "paths", "list", "lists", "show", "shows", "state",
  "function", "functions", "method", "methods", "call", "calls", "return",
  "returns", "read", "write", "writes", "user", "users", "system", "systems",
]);

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  if (value.length === 0 || seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

/**
 * Extract match terms from a prompt or a document.
 *
 * Contracts:
 * - Deterministic and side-effect free; safe to call for every stored row.
 * - ASCII terms come first so the caller's cap keeps the cross-lingual signal.
 * - CJK runs shorter than 2 characters are dropped; longer runs yield 2-grams
 *   (single characters are too common to discriminate).
 * - The result is capped at `MAX_TASK_TERMS` and de-duplicated in insertion
 *   order; it is never longer than the cap even for a huge prompt.
 *
 * @param text Prompt or stored content. Empty/whitespace returns `[]`.
 */
export function extractTaskTerms(text: string): string[] {
  if (!text) return [];
  const ascii: string[] = [];
  const cjk: string[] = [];
  const asciiSeen = new Set<string>();
  const cjkSeen = new Set<string>();

  for (const match of text.toLowerCase().matchAll(ASCII_TERM_PATTERN)) {
    const term = match[0];
    if (ASCII_STOPWORDS.has(term)) continue;
    pushUnique(ascii, asciiSeen, term);
    if (ascii.length >= MAX_TASK_TERMS) break;
  }

  for (const match of text.matchAll(CJK_RUN_PATTERN)) {
    const run = match[0];
    if (run.length < 2) continue;
    if (run.length === 2) pushUnique(cjk, cjkSeen, run);
    else {
      for (let index = 0; index + 2 <= run.length; index += 1) {
        pushUnique(cjk, cjkSeen, run.slice(index, index + 2));
        if (cjk.length >= MAX_TASK_TERMS) break;
      }
    }
    if (cjk.length >= MAX_TASK_TERMS) break;
  }

  return [...ascii, ...cjk].slice(0, MAX_TASK_TERMS);
}

function termWeight(term: string): number {
  // ASCII chars win the ambiguity: a term with any ASCII letter or digit came
  // from the identifier pattern, which is the cross-lingual signal.
  if (/[a-z0-9]/.test(term)) return ASCII_GENERIC.has(term) ? 1 : 2;
  return 1;
}

/**
 * Score how much of the task vocabulary appears in a stored text.
 *
 * Contracts:
 * - Case-insensitive substring matching; no tokenization of the stored text.
 * - Returns 0 when `terms` is empty, which callers must read as "no signal" and
 *   handle by falling back to their own ordering.
 * - Bounded work: one lowercase copy of `text` per call, one scan per term.
 * - Not a probability and not comparable across different term sets; only the
 *   ranking it induces within a single call site is meaningful.
 */
export function scoreTaskRelevance(text: string, terms: readonly string[]): number {
  if (terms.length === 0 || !text) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += termWeight(term);
  }
  return score;
}

/**
 * Build an FTS5 OR query from a task prompt.
 *
 * The trigram tokenizer needs at least 3 characters per term, so CJK runs are
 * narrowed to 3-grams while ASCII identifiers are used as-is. Terms are quoted,
 * so a prompt containing FTS5 syntax cannot change the query shape.
 *
 * Returns `""` when nothing usable was extracted; callers must skip the search
 * rather than run an empty MATCH.
 */
export function buildTaskSearchQuery(text: string, maxTerms = 8): string {
  const terms = extractTaskTerms(text);
  const ascii = terms.filter((term) => /[a-z0-9]/.test(term));
  const cjk = terms.filter((term) => !/[a-z0-9]/.test(term));
  const picked: string[] = [];

  for (const term of ascii) {
    if (picked.length >= maxTerms) break;
    picked.push(term);
  }
  for (const gram of cjk) {
    if (picked.length >= maxTerms) break;
    // Merge overlapping 2-grams back into 3-char windows the trigram index has.
    if (gram.length !== 2) continue;
    const widened = cjk.find((candidate) => candidate !== gram && candidate.startsWith(gram));
    if (widened) {
      picked.push(widened);
      continue;
    }
    const widenedBack = cjk.find((candidate) => candidate !== gram && candidate.endsWith(gram));
    if (widenedBack) picked.push(widenedBack.slice(-3));
  }

  const unique = [...new Set(picked.filter((term) => term.length >= 3))].slice(0, maxTerms);
  if (unique.length === 0) return "";
  return unique.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

/** Whether a term looks machine-generated: a digit, a path or dot separator, or a
 * long single word. Prose ("web", "dev") is not one.
 *
 * The ledger is mostly English while prompts are mixed, so a Chinese-only prompt
 * can reach the ledger only through borrowed English words — a bridge that
 * reliably produces confident noise instead of recall. Identifier terms are the
 * dependable part of the prompt, and nearly every work prompt has one (repo,
 * port, service, ticket id). */
export function isIdentifierTerm(term: string): boolean {
  if (!/[a-z0-9]/.test(term)) return false;
  return /[0-9._\-/]/.test(term) || term.length >= 6;
}

/**
 * Session-scoped task anchor.
 *
 * Relevance is decided once per task, not once per message: the injected blocks
 * are part of the system prompt, so re-deciding them on every turn changes the
 * prompt prefix and defeats provider prompt caching for the rest of the session.
 *
 * Keeping the first prompt as the anchor would go stale when a session moves on
 * to a new task, so the anchor moves when the prompt introduces a machine
 * identifier the anchor does not already contain (a new ticket, repo, port or
 * service). Ordinary follow-ups ("那 IAR-2000 的 7 是怎么算的？") keep the anchor.
 *
 * Contract: one instance per session, `reset()` on session start/shutdown.
 * Deterministic and free of I/O; safe to call for every prompt.
 */
export class TaskAnchor {
  private text = "";
  private identifiers = new Set<string>();

  /** Forget the current task, e.g. when a session starts or ends. */
  reset(): void {
    this.text = "";
    this.identifiers.clear();
  }

  /** The task text to score against for this prompt. */
  resolve(prompt: string): string {
    const trimmed = (prompt ?? "").trim();
    if (trimmed.length === 0) return this.text;
    const promptIdentifiers = extractTaskTerms(trimmed).filter(isIdentifierTerm);
    const isNewTask = this.text.length === 0
      || promptIdentifiers.some((term) => !this.identifiers.has(term));
    if (isNewTask) {
      this.text = trimmed;
      this.identifiers = new Set(promptIdentifiers);
    }
    return this.text;
  }
}
