import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getActivePrinciples,
  getMemoryEvents,
  renderAdaptivePrinciples,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

/**
 * Task relevance is an *ordering* signal inside the competition register, not a
 * filter: the same rows are present either way, and with no task text the
 * selection must be exactly the pre-relevance one.
 */
describe("principle selection follows the task", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "principle-relevance-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const add = (captureId: string, content: string) => {
    const capture = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: `${captureId} evidence` }], {
      captureId, source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    return applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "add", scope: "global", content, rationale: captureId, sourceEventIds: capture.eventIds, existingPrincipleIds: [],
    }], { charLimit: 20000 });
  };

  /** Only the injected block — the omission index repeats omitted entries. */
  const injected = (rendered: string): string => {
    const start = rendered.indexOf("<adaptive-principles>");
    const end = rendered.indexOf("</adaptive-principles>");
    return start >= 0 && end > start ? rendered.slice(start, end) : "";
  };

  it("promotes a relevant older principle over a newer irrelevant one when the budget fits only one", () => {
    const older = "IAR-2000 sidecar pool cap must be layered before permits are counted by the pool.";
    const newer = "Marketing site pricing tables should keep the legacy zebra striping pattern.";
    assert.equal(add("rel-older", older).added, 1);
    assert.equal(add("rel-newer", newer).added, 1);

    const budget = 700;
    // No task text: strength and id decide, so the newer entry wins the only slot.
    const withoutTask = injected(renderAdaptivePrinciples(dbManager, null, false, budget));
    assert.match(withoutTask, /Marketing site pricing/, "default order is unchanged without a task");

    // With the task, the matching older entry takes the slot.
    const withTask = injected(renderAdaptivePrinciples(dbManager, null, false, budget, "IAR-2000 sidecar pool cap 到底怎么算的？"));
    assert.match(withTask, /sidecar pool cap/);
    assert.doesNotMatch(withTask, /Marketing site pricing/);
    assert.equal(getActivePrinciples(dbManager).length, 2, "ordering never deletes");
  });

  it("keeps the pre-relevance order when the task shares no terms", () => {
    add("rel-a", "Alpha rule about the release checklist for production deploys.");
    add("rel-b", "Beta rule about the release checklist for production deploys.");

    const budget = 700;
    assert.equal(
      injected(renderAdaptivePrinciples(dbManager, null, false, budget, "完全无关的一句话")),
      injected(renderAdaptivePrinciples(dbManager, null, false, budget)),
      "an unmatched task text must not reshuffle the registers",
    );
  });

  it("still injects pinned principles first regardless of relevance", () => {
    add("rel-pinned", "Never force-push a shared branch; rebase and retry instead.");
    add("rel-task", "IAR-2000 sidecar pool cap layering notes.");
    const pinnedId = getActivePrinciples(dbManager).find((principle) => principle.content.startsWith("Never force-push"))!.id;
    dbManager.getDb().prepare("UPDATE principles SET pinned = 1 WHERE id = ?").run(pinnedId);

    const block = injected(renderAdaptivePrinciples(dbManager, null, false, 700, "IAR-2000 sidecar pool cap 怎么算？"));
    assert.match(block, /Never force-push/, "the safety register must not be displaced by relevance");
  });
});
