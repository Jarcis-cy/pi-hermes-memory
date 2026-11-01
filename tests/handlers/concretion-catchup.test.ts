import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { captureMemoryEvents } from "../../src/store/event-memory-store.js";
import {
  CONCRETION_BACKLOG_ALERT_THRESHOLD,
  CONCRETION_CATCHUP_MAX_RUNS,
  drainConcretionQueue,
  shouldRunAutomaticConcretion,
} from "../../src/handlers/concretion.js";
import type { MemoryConfig } from "../../src/types.js";

describe("automatic concretion trigger", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concretion-trigger-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = { concretionReviewThreshold: 10 } as MemoryConfig;

  it("counts pending events from every source, not only background-review captures", () => {
    // legacy-import events never incremented the old capture counter and sat
    // queued forever; the trigger must see them.
    for (let i = 0; i < 10; i++) {
      captureMemoryEvents(dbManager, [{
        scope: "global",
        kind: "fact",
        content: `legacy fact ${i}`,
        evidenceQuote: "quote",
      }], { source: "legacy-import" as never });
    }
    assert.equal(shouldRunAutomaticConcretion(dbManager, config), true);
  });

  it("stays quiet below the threshold", () => {
    for (let i = 0; i < 9; i++) {
      captureMemoryEvents(dbManager, [{
        scope: "global",
        kind: "fact",
        content: `fact ${i}`,
        evidenceQuote: "quote",
      }], { source: "background-review" });
    }
    assert.equal(shouldRunAutomaticConcretion(dbManager, config), false);
  });
});

describe("bounded catch-up drain", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concretion-catchup-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const config = {} as MemoryConfig;
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      captureMemoryEvents(dbManager, [{
        scope: "global",
        kind: "fact",
        content: `fact ${i}`,
        evidenceQuote: "quote",
      }], { source: "background-review" });
    }
  };

  /** Mock distillation run: marks the 40 oldest pending events concreted. */
  const mockRun = (() => {
    const calls: number[] = [];
    const fn = async () => {
      dbManager.getDb().prepare(
        "UPDATE memory_events SET concreted_at = ? WHERE id IN"
        + " (SELECT id FROM memory_events WHERE concreted_at IS NULL ORDER BY id ASC LIMIT 40)",
      ).run(new Date().toISOString());
      calls.push(1);
      return { ok: true as const, eventCount: 40, added: 1, reinforced: 0, refined: 0, merged: 0, conflicts: 0, ignored: 0, skipped: 0, unclassified: 0 };
    };
    return { fn, callCount: () => calls.length };
  });

  it("drains a moderate shock to zero in one pass (multiple runs)", async () => {
    seed(100);
    const mock = mockRun();
    const result = await drainConcretionQueue({} as never, {} as never, dbManager, tmpDir, config, {}, { runConcretion: mock.fn as never });
    assert.equal(mock.callCount(), 3, "100 events at 40/run needs 3 runs");
    assert.equal(result.runs, 3);
    assert.equal(result.pendingAfter, 0);
    assert.equal(result.failure, undefined);
  });

  it("caps runs per pass on a huge backlog and reports what remains", async () => {
    seed(500);
    const mock = mockRun();
    const result = await drainConcretionQueue({} as never, {} as never, dbManager, tmpDir, config, {}, { runConcretion: mock.fn as never });
    assert.equal(result.runs, CONCRETION_CATCHUP_MAX_RUNS);
    assert.equal(result.pendingAfter, 500 - 40 * CONCRETION_CATCHUP_MAX_RUNS);
    assert.ok(result.pendingAfter >= CONCRETION_BACKLOG_ALERT_THRESHOLD, "remaining backlog must trip the alert threshold");
  });

  it("a failed run stops the pass instead of retrying in place", async () => {
    seed(200);
    const errors: string[] = [];
    let attempts = 0;
    const result = await drainConcretionQueue({} as never, {} as never, dbManager, tmpDir, config, {
      onRunError: (e) => errors.push(e),
    }, {
      runConcretion: (async () => {
        attempts++;
        return { ok: false as const, eventCount: 40, error: "provider flake" };
      }) as never,
    });
    assert.equal(attempts, 1, "failure must break the loop; the next review retries");
    assert.equal(result.failure, "provider flake");
    assert.deepEqual(errors, ["provider flake"]);
  });

  it("runs nothing in steady state below the trigger threshold", async () => {
    seed(5);
    const mock = mockRun();
    const result = await drainConcretionQueue({} as never, {} as never, dbManager, tmpDir, config, {}, { runConcretion: mock.fn as never });
    assert.equal(mock.callCount(), 0);
    assert.equal(result.runs, 0);
  });

  it("honours cancellation before the first run", async () => {
    seed(200);
    const mock = mockRun();
    const result = await drainConcretionQueue({} as never, {} as never, dbManager, tmpDir, config, {
      isCancelled: () => true,
    }, { runConcretion: mock.fn as never });
    assert.equal(mock.callCount(), 0);
    assert.equal(result.runs, 0);
  });
});
