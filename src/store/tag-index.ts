/**
 * tag-index.ts — the key space of the forward tag index (memory_event_tags).
 *
 * One event's semantic tags expand into several searchable keys so a query can
 * reach it without scanning the '|a|b|' column:
 *
 *   tag 'world-map'  ->  'worldmap'  (whole tag, hyphens removed: one concept)
 *                        'world'     (first part: a single query word reaches it)
 *                        'map'       (last part)
 *
 * The two spellings the tagger emits for one concept ('world-map' and
 * 'worldmap') collapse onto the same key, and a one-word query still matches a
 * compound tag. Heavy keys ('code', 'test') are bounded downstream by the
 * document-frequency gate in the lookup, not here.
 */

/** Minimum key length. Shorter keys would match nothing useful and would make
 * the index noisier than the tags it describes. */
const MIN_KEY_LENGTH = 3;

/** tagIndexKeys expands one normalized tag into its index keys (deduplicated).
 *
 * Contract: pure and deterministic; returns an empty array for empty input.
 * Keys are lowercase because tags are normalized to lowercase at write time. */
export function tagIndexKeys(tags: string[]): string[] {
  const keys: string[] = [];
  const push = (key: string): void => {
    if (key.length < MIN_KEY_LENGTH) return;
    if (!keys.includes(key)) keys.push(key);
  };
  for (const rawTag of tags) {
    const tag = rawTag.trim().toLowerCase();
    if (!tag) continue;
    const parts = tag.split(/[-_]/).filter(Boolean);
    if (parts.length === 0) continue;
    push(parts.join(""));
    if (parts.length > 1) {
      push(parts[0]!);
      push(parts[parts.length - 1]!);
    }
  }
  return keys;
}

/** indexKeysForEventTags is tagIndexKeys for an already-split tag list coming
 * out of the '|a|b|' storage form. Kept separate so callers do not re-implement
 * the split (and can pass the raw column value). */
export function indexKeysForStoredTags(stored: string | null): string[] {
  if (!stored) return [];
  return tagIndexKeys(stored.split("|").filter(Boolean));
}
