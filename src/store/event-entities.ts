/** Cap per event: enough to index the actors that matter, small enough to keep
 * the facet column and its LIKE probe cheap. */
const MAX_EVENT_ENTITIES = 8;

/** Bumped whenever the derivation changes, so the ledger is re-derived once.
 * Without this the old tags (and their false positives) stay baked in forever. */
export const EVENT_ENTITIES_VERSION = '2';

/** Abbreviations that look like dotted identifiers but carry no identity. */
const DOTTED_ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "approx", "a.k.a", "u.s"]);

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
  // Ports: ":28080" is the identifier people actually recognise an environment by.
  for (const match of joined.matchAll(/:(\d{2,5})\b/g)) add(`port-${match[1]}`);
  // Container/service shapes with three or more hyphen segments
  // (code-audit-dev-postgres, pi-web.service). Two-segment words are prose.
  for (const match of joined.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+){2,})\b/g)) {
    if (match[1]!.length >= 12) add(match[1]!);
  }
  // Dotted identifiers (files, packages, domains): foo.ts, @scope/pkg, api.x.io.
  for (const match of joined.matchAll(/\b([\w@-]+(?:\.[\w-]+){1,4})\b/g)) {
    const value = match[1]!;
    if (DOTTED_ABBREVIATIONS.has(value.toLowerCase())) continue;
    // Versions and measurements: 1.2.3, 0.00s, 3.5ms.
    if (/^\d+(?:\.\d+)*[a-z]{0,3}$/i.test(value)) continue;
    if (/\d+\.\d+/.test(value) && !/[a-z]/i.test(value.replace(/[\d.]/g, ""))) continue;
    add(value);
  }

  return [...found].slice(0, MAX_EVENT_ENTITIES);
}
