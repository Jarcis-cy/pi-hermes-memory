import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getAllActivePrinciples,
  getMemoryEvents,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";
import { extractAndCaptureEvents } from "../../src/handlers/event-extraction.js";

describe("extraction principle feedback accounting", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "extraction-feedback-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const addPrinciple = (content: string) => {
    const capture = captureMemoryEvents(dbManager, [{
      scope: "global",
      kind: "insight",
      content: `${content.slice(0, 40)} evidence`,
      evidenceQuote: "quote",
    }], { source: "manual" });
    const events = getMemoryEvents(dbManager, { pendingOnly: true });
    const run = startConcretionRun(dbManager, "manual", events.length);
    return applyConcretionPlan(dbManager, run, events, [{
      action: "add",
      scope: "global",
      content,
      rationale: null,
      sourceEventIds: capture.eventIds,
      existingPrincipleIds: [],
    }], { charLimit: 5000 });
  };

  const runExtraction = async (text: string) => extractAndCaptureEvents(
    {} as never,
    {} as never,
    dbManager,
    { reviewTransport: "direct" },
    {
      parts: ["[USER] run the migration", "[ASSISTANT] backed up, then migrated"],
      projectName: null,
      source: "background-review",
      principleIndex: ["P1 [global] Back up data before any bulk write to a datastore."],
    },
    {},
    { runDirectJsonCompletion: (async () => ({ ok: true, text })) as never },
  );

  it("records applied/violated ids from the extractor and drops ids the prompt never offered", async () => {
    addPrinciple("Back up data before any bulk write to a datastore.");
    const result = await runExtraction(JSON.stringify({
      events: [{
        scope: "global",
        kind: "insight",
        content: "Backup completed before the bulk migration.",
        evidence_quote: "backed up first",
      }],
      principle_feedback: { applied: [1], violated: [999] },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.inserted, 1);
    const principle = getAllActivePrinciples(dbManager).find((p) => p.id === 1);
    assert.ok(principle, "principle P1 exists");
    assert.equal(principle.appliedCount, 1, "offered id is accounted");
    assert.equal(principle.violatedCount, 0, "hallucinated id 999 must not pollute accounting");
  });

  it("records nothing when the model omits the feedback key", async () => {
    addPrinciple("Back up data before any bulk write to a datastore.");
    const result = await runExtraction(JSON.stringify({
      events: [{
        scope: "global",
        kind: "insight",
        content: "Backup completed before the bulk migration.",
        evidence_quote: "backed up first",
      }],
    }));
    assert.equal(result.ok, true);
    const principle = getAllActivePrinciples(dbManager).find((p) => p.id === 1);
    assert.equal(principle?.appliedCount ?? 0, 0);
    assert.equal(principle?.violatedCount ?? 0, 0);
  });
});
