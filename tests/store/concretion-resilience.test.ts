import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { DEFAULT_CONCRETION_EVENT_BATCH_SIZE } from "../../src/constants.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getActivePrinciples,
  getMemoryEvents,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

describe("concretion resilience", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concretion-resilience-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps a batch alive when the model under-classifies", () => {
    const classified = captureMemoryEvents(dbManager, [{ scope: "global", kind: "failure", content: "One failure." }], {
      captureId: "res-1", source: "background-review",
    });
    const orphaned = captureMemoryEvents(dbManager, [{ scope: "global", kind: "outcome", content: "One outcome." }], {
      captureId: "res-2", source: "background-review",
    });
    const events = getMemoryEvents(dbManager, { pendingOnly: true });
    const runId = startConcretionRun(dbManager, "manual", events.length);

    const applied = applyConcretionPlan(dbManager, runId, events, [{
      action: "add",
      scope: "global",
      content: "Verify the work stopped before declaring the cancellation complete.",
      sourceEventIds: classified.eventIds,
      existingPrincipleIds: [],
    }], { charLimit: 20000 });

    assert.equal(applied.added, 1);
    assert.equal(applied.unclassified, 1);
    assert.deepEqual(getMemoryEvents(dbManager, { pendingOnly: true }).map((event) => event.id), orphaned.eventIds);
    const run = dbManager.getDb().prepare("SELECT status FROM concretion_runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "completed", "an under-classified plan must not mark the run failed");
  });

  it("skips unusable candidates and applies the usable ones in the same batch", () => {
    const good = captureMemoryEvents(dbManager, [{ scope: "global", kind: "failure", content: "Good evidence." }], {
      captureId: "res-3", source: "background-review",
    });
    const events = getMemoryEvents(dbManager, { pendingOnly: true });
    const runId = startConcretionRun(dbManager, "manual", events.length);

    const applied = applyConcretionPlan(dbManager, runId, events, [{
      action: "reinforce", // 没有 existing id → 跳过
      sourceEventIds: good.eventIds,
    }, {
      action: "add",
      scope: "global",
      content: "Distill only from evidence that is actually in the batch.",
      sourceEventIds: good.eventIds,
      existingPrincipleIds: [],
    }], { charLimit: 20000 });

    assert.equal(applied.skipped, 1);
    assert.equal(applied.added, 1);
    assert.equal(getActivePrinciples(dbManager).length, 1);
  });

  it("keeps the default batch small enough to avoid subprocess timeouts", () => {
    assert.ok(DEFAULT_CONCRETION_EVENT_BATCH_SIZE <= 40, "large batches timed out the concretion subprocess");
  });
});
