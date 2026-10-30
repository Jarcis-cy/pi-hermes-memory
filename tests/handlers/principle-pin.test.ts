import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { registerPrinciplePinCommand } from "../../src/handlers/principle-pin.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getActivePrinciples,
  getMemoryEvents,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

describe("principle pin command", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;
  let command: { handler: (args: string, ctx: unknown) => Promise<void> };
  let notices: Array<{ text: string; level: string }>;

  const ctx = () => ({ ui: { notify: (text: string, level: string) => notices.push({ text, level }) } });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "principle-pin-"));
    dbManager = new DatabaseManager(tmpDir);
    notices = [];
    registerPrinciplePinCommand(
      { registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { command = def; } } as never,
      dbManager,
      () => null,
    );
    const capture = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: "evidence" }], {
      captureId: "pin-evidence",
      source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "add",
      scope: "global",
      content: "Never persist credential values or secret material in durable memory.",
      rationale: "safety",
      sourceEventIds: capture.eventIds,
      existingPrincipleIds: [],
    }], { charLimit: 20000 });
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pins, lists and unpins an active principle", async () => {
    const [principle] = getActivePrinciples(dbManager);
    await command.handler(String(principle!.id), ctx());
    assert.equal(notices.at(-1)!.level, "info");
    assert.match(notices.at(-1)!.text, /Pinned \[P\d+\]/);
    assert.equal(getActivePrinciples(dbManager)[0]!.pinned, true);

    await command.handler("", ctx());
    assert.match(notices.at(-1)!.text, /always injected/);
    assert.match(notices.at(-1)!.text, /Never persist credential/);

    await command.handler(`remove ${principle!.id}`, ctx());
    assert.match(notices.at(-1)!.text, /Unpinned/);
    assert.equal(getActivePrinciples(dbManager)[0]!.pinned, false);
  });

  it("rejects unknown ids and malformed input without touching the store", async () => {
    await command.handler("999", ctx());
    assert.equal(notices.at(-1)!.level, "warning");
    assert.match(notices.at(-1)!.text, /not an active principle/);

    notices = [];
    await command.handler("abc", ctx());
    assert.match(notices.at(-1)!.text, /Expected a principle id/);

    assert.equal(getActivePrinciples(dbManager)[0]!.pinned, false);
  });
});
