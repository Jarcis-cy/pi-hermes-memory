import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatPrincipleConflicts } from "../../src/handlers/memory-conflicts.js";
import { DatabaseManager } from "../../src/store/db.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getMemoryEvents,
  getPendingPrincipleConflicts,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

describe("memory conflict presentation", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-conflicts-test-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("shows candidate, existing principle, source event, and verbatim evidence", () => {
    const oldCapture = captureMemoryEvents(dbManager, [{
      scope: "user",
      kind: "preference",
      content: "User prefers concise answers.",
      evidenceQuote: "Keep answers concise.",
    }], { source: "background-review", captureId: "old" });
    let events = getMemoryEvents(dbManager, { pendingOnly: true });
    let runId = startConcretionRun(dbManager, "manual", events.length);
    applyConcretionPlan(dbManager, runId, events, [{
      action: "add",
      scope: "user",
      content: "Default to concise answers.",
      sourceEventIds: oldCapture.eventIds,
      existingPrincipleIds: [],
    }], { charLimit: 5000 });

    const newCapture = captureMemoryEvents(dbManager, [{
      scope: "user",
      kind: "preference",
      content: "User requested exhaustive answers.",
      evidenceQuote: "Always be exhaustive.",
    }], {
      source: "background-review",
      captureId: "new",
      occurredAt: "2026-07-24T15:00:00.000Z",
    });
    events = getMemoryEvents(dbManager, { pendingOnly: true });
    runId = startConcretionRun(dbManager, "manual", events.length);
    applyConcretionPlan(dbManager, runId, events, [{
      action: "conflict",
      scope: "user",
      content: "Default to exhaustive answers.",
      sourceEventIds: newCapture.eventIds,
      existingPrincipleIds: [1],
      conflictReason: "Answer-length defaults conflict.",
    }], { charLimit: 5000 });

    const output = formatPrincipleConflicts(dbManager, getPendingPrincipleConflicts(dbManager));
    assert.match(output, /candidate \[user\]: Default to exhaustive answers/);
    assert.match(output, /P1: Default to concise answers/);
    assert.match(output, /2026-07-24T15:00:00.000Z/);
    assert.match(output, /User requested exhaustive answers/);
    assert.match(output, /Evidence: "Always be exhaustive\."/);
    assert.match(output, /accept\|existing\|both/);
  });
});
