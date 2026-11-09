/**
 * scripts/backfill-tags-sample.ts — quality gate for the semantic-tag backfill.
 *
 * Copies the live ledger to a temp database (sqlite3 .backup — never touches
 * the live file), tags a sample of untagged events through `pi -p` child
 * processes (same subprocess transport shape the extension's fallback uses),
 * writes the tags to the COPY, and prints the tag histogram plus sample rows
 * so a human can judge quality before the real /memory-backfill-tags run.
 *
 * Usage: npx tsx scripts/backfill-tags-sample.ts [--n 200]
 * Never writes to the live ledger; never prints secrets.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { loadBetterSqlite3 } from "../src/store/sqlite-native.js";
import { normalizeSemanticTags } from "../src/store/event-memory-store.js";
import { BACKFILL_TAGGER_SYSTEM_PROMPT, parseBackfillResponse } from "../src/handlers/backfill-tags.js";

const LIVE_DB = path.join(os.homedir(), ".pi/agent/pi-hermes-memory/sessions.db");
const BATCH = 20;

function spawnTagger(userPrompt: string): string {
  const stdout = execFileSync("pi", ["-p", "--no-session", "--no-extensions", `${BACKFILL_TAGGER_SYSTEM_PROMPT}\n\n${userPrompt}`], {
    encoding: "utf-8",
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function main(): void {
  const nArg = process.argv.indexOf("--n");
  const target = nArg >= 0 ? Math.max(1, Number(process.argv[nArg + 1]) || 200) : 200;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tag-sample-"));
  const copyPath = path.join(tmpDir, "sessions.db");
  execFileSync("sqlite3", [LIVE_DB, `.backup ${copyPath}`], { timeout: 120_000 });

  const requireImpl = createRequire(import.meta.url);
  const Database = loadBetterSqlite3({ requireImpl }) as any;
  const db = new Database(copyPath);
  // The live ledger gets this column from the extension migration on first
  // open with the new code; a fresh copy made before that needs it added
  // here. Throwaway copy, so a bare guarded ALTER is fine.
  const cols = db.prepare("PRAGMA table_info(memory_events)").all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === "semantic_tags")) {
    db.exec("ALTER TABLE memory_events ADD COLUMN semantic_tags TEXT");
  }
  const rows = db.prepare(
    "SELECT id, kind, content, evidence_quote FROM memory_events WHERE semantic_tags IS NULL ORDER BY id ASC LIMIT ?",
  ).all(target) as Array<{ id: number; kind: string; content: string; evidence_quote: string | null }>;
  const write = db.prepare("UPDATE memory_events SET semantic_tags = ? WHERE id = ?");

  const histogram = new Map<string, number>();
  const samples: Array<{ id: number; content: string; tags: string[] }> = [];
  let tagged = 0;
  let zeroTag = 0;
  let failedBatches = 0;
  const started = Date.now();

  for (let offset = 0; offset < rows.length; offset += BATCH) {
    const batch = rows.slice(offset, offset + BATCH);
    const ids = new Set(batch.map((row) => row.id));
    const userPrompt = [
      "Tag these events. Respond with JSON only:",
      ...batch.map((row) => JSON.stringify({ id: row.id, kind: row.kind, content: row.content, evidence: row.evidence_quote ?? "" })),
    ].join("\n");
    let text = "";
    try {
      text = spawnTagger(userPrompt);
    } catch (error) {
      failedBatches++;
      console.error(`batch at offset ${offset} failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parsed = parseBackfillResponse(text, ids);
    for (const row of batch) {
      const topics = parsed.get(row.id);
      const tags = topics === undefined ? [] : normalizeSemanticTags(topics);
      write.run(tags.length ? `|${tags.join("|")}|` : "", row.id);
      if (tags.length) {
        tagged++;
        for (const tag of tags) histogram.set(tag, (histogram.get(tag) ?? 0) + 1);
        if (samples.length < 15) samples.push({ id: row.id, content: row.content, tags });
      } else zeroTag++;
    }
    process.stdout.write(`.${Math.min(offset + BATCH, rows.length)}`);
  }

  console.log(`\n\nsample: ${rows.length} events | tagged ${tagged} | zero-tag ${zeroTag} | failed batches ${failedBatches} | ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const totalTaggedEvents = Math.max(1, tagged);
  const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log(`\nunique tags: ${histogram.size} | avg tags/tagged event: ${(tagged === 0 ? 0 : [...histogram.values()].reduce((s, v) => s + v, 0) / totalTaggedEvents).toFixed(2)}`);
  console.log("\ntop tags:");
  for (const [tag, count] of top) console.log(`  ${String(count).padStart(4)}  ${tag}`);
  console.log("\nsample rows:");
  for (const sample of samples) {
    console.log(`  E${sample.id} [${sample.tags.join(", ")}] ${sample.content.slice(0, 90)}`);
  }
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main();
