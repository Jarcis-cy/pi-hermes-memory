/**
 * scripts/eval-entity-join.ts — measure what the entity-tag second hop adds
 * on real ledger queries, zero model calls.
 *
 * Provenance of the query set: 60 unique queries actually issued through the
 * memory_search tool, mined from Pi session transcripts (2026-11-09) into
 * scripts/eval-queries.json. Gold labels are deterministic, not hand-annotated:
 * for a query carrying machine identifiers (ticket ids, ports, hosts, repo
 * slugs), gold = every ledger event whose entity tags or content contain that
 * identifier (capped per query). This measures identifier-completeness — "did
 * we surface the events about the thing the query names" — which is exactly
 * the bridging case the second hop exists for: a gold event that shares the
 * identifier but none of the query's other vocabulary.
 *
 * Usage: npx tsx scripts/eval-entity-join.ts [--db <sessions.db>] [--limit 10]
 * Reads the database read-only; never writes, never mutates hit counts.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadBetterSqlite3 } from "../src/store/sqlite-native.js";
import { searchMemoryEventsDetailed } from "../src/store/event-memory-store.js";
import type { DatabaseManager } from "../src/store/db.js";
import { extractTaskTerms, isIdentifierTerm } from "../src/store/task-terms.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(): { db: string; limit: number } {
  const argv = process.argv.slice(2);
  let db = path.join(os.homedir(), ".pi/agent/pi-hermes-memory/sessions.db");
  // 30 matches the memory_search tool default — the join only fires when the
  // primary ladder leaves budget, so evaluating at a smaller limit would
  // understate its firing envelope.
  let limit = 30;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--db" && argv[index + 1]) db = argv[index + 1]!;
    else if (argv[index] === "--limit" && argv[index + 1]) limit = Number(argv[index + 1]);
  }
  return { db, limit };
}

function entityLikePattern(tag: string): string {
  return `%|${tag.replace(/[\\%_]/g, (ch) => `\\${ch}`)}|%`;
}

interface Row {
  id: number;
  content: string;
  entities: string | null;
}

function main(): void {
  const { db: dbPath, limit } = parseArgs();
  if (!fs.existsSync(dbPath)) {
    console.error(`database not found: ${dbPath}`);
    process.exit(1);
  }

  const requireImpl = createRequire(import.meta.url);
  const Database = loadBetterSqlite3({ requireImpl }) as new (p: string, o?: unknown) => {
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[] };
  };
  const db = new Database(dbPath, { readonly: true });
  const adapter = { getDb: () => db } as unknown as DatabaseManager;

  const queries = JSON.parse(fs.readFileSync(path.join(scriptDir, "eval-queries.json"), "utf-8")) as string[];
  const total = db.prepare("SELECT COUNT(*) AS n FROM memory_events").get() as unknown as { n: number };
  console.log(`ledger events: ${total.n} | queries: ${queries.length} | top-k: ${limit}\n`);

  let skippedNoIdentifier = 0;
  let skippedGoldSize = 0;
  const rows: Array<{
    query: string;
    gold: number;
    base: number;
    exp: number;
    joined: number;
    noise: number;
  }> = [];

  for (const query of queries) {
    const identifiers = [...new Set(extractTaskTerms(query).filter(isIdentifierTerm))];
    if (identifiers.length === 0) {
      skippedNoIdentifier += 1;
      continue;
    }

    // Prefer the rarest identifiers: gold from a common tag ("code-audit",
    // df in the hundreds) is a ranking exercise, not a bridging one, and
    // Recall@k against dozens of gold events is meaningless at k=30.
    const dfs = identifiers.map((id) => ({
      id,
      n: (db.prepare(
        "SELECT COUNT(*) AS n FROM memory_events e WHERE e.entities LIKE ? ESCAPE '\\' OR lower(e.content) LIKE ? ESCAPE '\\'",
      ).get(entityLikePattern(id), `%${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) as unknown as { n: number }).n,
    }));
    const usable = dfs.filter((entry) => entry.n > 0 && entry.n <= 20).sort((a, b) => a.n - b.n).slice(0, 3);
    if (usable.length === 0) {
      skippedGoldSize += 1;
      continue;
    }

    const gold = new Set<number>();
    for (const { id } of usable) {
      const like = `%${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const hits = db.prepare(
        "SELECT id FROM memory_events e WHERE e.entities LIKE ? ESCAPE '\\' OR lower(e.content) LIKE ? ESCAPE '\\' LIMIT 21",
      ).all(entityLikePattern(id), like) as unknown as Array<{ id: number }>;
      for (const hit of hits) gold.add(hit.id);
    }
    if (gold.size === 0 || gold.size > 20) {
      skippedGoldSize += 1;
      continue;
    }

    const baseOutcome = searchMemoryEventsDetailed(adapter, query, { limit });
    const expOutcome = searchMemoryEventsDetailed(adapter, query, { limit, expandByEntity: {} });
    const baseIds = new Set(baseOutcome.events.map((event) => event.id));
    const expIds = new Set(expOutcome.events.map((event) => event.id));
    const baseHits = [...gold].filter((id) => baseIds.has(id)).length;
    const expHits = [...gold].filter((id) => expIds.has(id)).length;
    const joinedNotGold = expOutcome.events
      .filter((event) => !baseIds.has(event.id))
      .filter((event) => !gold.has(event.id)).length;

    rows.push({
      query,
      gold: gold.size,
      base: baseHits,
      exp: expHits,
      joined: expOutcome.joinedCount,
      noise: joinedNotGold,
    });
  }

  let goldSum = 0;
  let baseSum = 0;
  let expSum = 0;
  let improved = 0;
  let worsened = 0;
  let joinNoise = 0;
  let joinTotal = 0;
  for (const row of rows) {
    goldSum += row.gold;
    baseSum += row.base;
    expSum += row.exp;
    if (row.exp > row.base) improved += 1;
    if (row.exp < row.base) worsened += 1;
    joinNoise += row.noise;
    joinTotal += row.joined;
  }

  const pct = (hits: number) => ((hits / Math.max(1, goldSum)) * 100).toFixed(1);
  console.log("query".padEnd(64), "gold  base  exp  +join  noise");
  for (const row of rows) {
    const mark = row.exp > row.base ? "+" : row.exp < row.base ? "-" : " ";
    console.log(
      `${mark} ${row.query.slice(0, 62).padEnd(62)}`,
      String(row.gold).padStart(4),
      String(row.base).padStart(5),
      String(row.exp).padStart(4),
      String(row.joined).padStart(6),
      String(row.noise).padStart(6),
    );
  }
  console.log("");
  console.log(`evaluated: ${rows.length} | skipped (no identifier): ${skippedNoIdentifier} | skipped (gold 0 or >20): ${skippedGoldSize}`);
  console.log(`micro recall@${limit}: baseline ${baseSum}/${goldSum} = ${pct(baseSum)}%  ->  expanded ${expSum}/${goldSum} = ${pct(expSum)}%`);
  console.log(`per-query: improved ${improved} | worsened ${worsened} | unchanged ${rows.length - improved - worsened}`);
  console.log(`join volume: ${joinTotal} joined events, ${joinNoise} of them outside deterministic gold (${((joinNoise / Math.max(1, joinTotal)) * 100).toFixed(1)}% unlabeled, not necessarily wrong)`);

  db.close?.();
}

main();
