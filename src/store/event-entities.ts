/** Cap per event: enough to index the actors that matter, small enough to keep
 * the facet column and its LIKE probe cheap. */
const MAX_EVENT_ENTITIES = 8;

/** Deterministic facet derivation — no extra LLM call. Tickets, repo/package
 * slugs, and dotted/path-like identifiers are the entities that make "find the
 * ticket" or "find the repo" recall work without a semantic query. */
export function deriveEventEntities(...texts: Array<string | null | undefined>): string[] {
  const joined = texts.filter((text): text is string => typeof text === "string" && text.length > 0).join("\n");
  if (!joined) return [];
  const found = new Set<string>();
  const add = (value: string) => {
    const tag = value.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (tag.length >= 2 && tag.length <= 120) found.add(tag);
  };

  // Tickets: an uppercase project key plus digits (ABC-123, OPS-7).
  for (const match of joined.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)) add(match[1]!);
  // Repo/package slugs and relative paths: owner/repo, pkg/sub, a.b/c.d.
  for (const match of joined.matchAll(/(?:^|[\s(\[`"'])([\w.-]+\/[\w./-]{2,})/g)) add(match[1]!);
  // Dotted identifiers (files, packages, domains): foo.ts, @scope/pkg, api.x.io.
  for (const match of joined.matchAll(/\b([\w@-]+(?:\.[\w-]+){1,4})\b/g)) {
    const value = match[1]!;
    if (/\d+\.\d+/.test(value) && !/[a-z]/i.test(value.replace(/[\d.]/g, ""))) continue; // versions skip
    add(value);
  }

  return [...found].slice(0, MAX_EVENT_ENTITIES);
}
