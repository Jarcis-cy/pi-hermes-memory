/**
 * Text similarity for the adaptive-principles layer.
 *
 * Two uses, one tokenizer so they cannot drift apart:
 * - retrieval scoring: how much of the query a principle actually covers;
 * - encoding gate: whether a new principle merely re-enacts an active one
 *   ("the many become one, and are increased with one" — a re-enactment adds
 *   no occasion, so it must reinforce the existing trace instead of minting a
 *   near-duplicate row).
 *
 * Deliberately lexical: deterministic, dependency-free, and cheap enough to run
 * over every active principle on a write. Semantic paraphrase detection is a
 * different (embedding) problem and is not attempted here.
 */

/** Words shorter than this carry too little signal to count as a match token. */
const MIN_WORD_LENGTH = 3;
/** CJK runs are tokenized as overlapping bigrams: 窗口索引 -> 窗口, 口索, 索引. */
const CJK_RANGE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Minimal, deterministic suffix folding so that a query and a principle meet on
 * the same token despite inflection ("restart" vs "restarting", "task" vs
 * "tasks"). No full stemmer: only the four suffixes that actually differ between
 * a user's query and how a principle is phrased.
 */
function stemWord(word: string): string {
  // A fold is only accepted when the stem itself still carries meaning (>= 4
  // chars), so short words are not mangled into unusable fragments.
  const fold = (suffix: string): string | null => {
    const stem = word.slice(0, -suffix.length);
    return stem.length >= 4 ? stem : null;
  };
  if (word.endsWith("ing")) {
    const stem = fold("ing");
    if (stem) return stem;
  }
  if (word.endsWith("ed")) {
    const stem = fold("ed");
    if (stem) return stem;
  }
  if (word.endsWith("es")) {
    const stem = fold("es");
    if (stem) return stem;
  }
  if (word.endsWith("s") && !word.endsWith("ss")) {
    const stem = fold("s");
    if (stem) return stem;
  }
  return word;
}

/**
 * Normalize and split text into match tokens: lowercase ASCII/digit words of at
 * least MIN_WORD_LENGTH characters, plus CJK character bigrams (unigrams for a
 * single-character run). Punctuation, markdown, and metadata are dropped, so a
 * principle and its restatement compare on content words only.
 */
export function tokenizeForMatch(text: string): string[] {
  if (!text) return [];
  const normalized = text.toLowerCase();
  const tokens: string[] = [];
  let word = "";
  let cjkRun = "";

  const flushWord = () => {
    if (word.length >= MIN_WORD_LENGTH) tokens.push(stemWord(word));
    word = "";
  };
  const flushCjk = () => {
    if (!cjkRun) return;
    if (cjkRun.length === 1) tokens.push(cjkRun);
    else {
      for (let i = 0; i + 1 < cjkRun.length; i++) tokens.push(cjkRun.slice(i, i + 2));
    }
    cjkRun = "";
  };

  for (const char of normalized) {
    if (CJK_RANGE.test(char)) {
      flushWord();
      cjkRun += char;
      continue;
    }
    flushCjk();
    if ((char >= "a" && char <= "z") || (char >= "0" && char <= "9")) {
      word += char;
      continue;
    }
    flushWord();
  }
  flushWord();
  flushCjk();
  return tokens;
}

/**
 * Jaccard similarity of the two token sets: |A∩B| / |A∪B| in [0, 1].
 * Set-based, so word order and repetition do not matter — the right shape for
 * "is this the same rule stated twice".
 */
export function tokenSetSimilarity(left: string, right: string): number {
  const a = new Set(tokenizeForMatch(left));
  const b = new Set(tokenizeForMatch(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Coverage of a query by a candidate text in [0, 1]: the share of distinct query
 * tokens the text contains. Used for retrieval, where a short query should not be
 * penalized for not containing most of a long principle.
 */
export function queryCoverage(query: string, text: string): number {
  const queryTokens = new Set(tokenizeForMatch(query));
  if (queryTokens.size === 0) return 0;
  const textTokens = new Set(tokenizeForMatch(text));
  let matched = 0;
  for (const token of queryTokens) if (textTokens.has(token)) matched++;
  return matched / queryTokens.size;
}
