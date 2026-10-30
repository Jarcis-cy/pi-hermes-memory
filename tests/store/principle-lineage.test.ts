import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  countUnlinkedSuperseded,
  findOrphanedLineage,
  getActivePrinciples,
  getMemoryEvents,
  retirePrinciple,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

describe("principle lineage safety", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const addPrinciple = (captureId: string, content: string) => {
    const capture = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: `${captureId} evidence` }], {
      captureId, source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "add", scope: "global", content, rationale: captureId, sourceEventIds: capture.eventIds, existingPrincipleIds: [],
    }], { charLimit: 20000 });
    const created = getActivePrinciples(dbManager).find((principle) => principle.content === content)!;
    return { id: created.id, eventIds: capture.eventIds };
  };

  const mergeInto = (ids: number[], content: string, sourceEventIds: number[]) => {
    const run = startConcretionRun(dbManager, "manual", ids.length);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "merge", scope: "global", content, rationale: "merge", sourceEventIds, existingPrincipleIds: ids,
    }], { charLimit: 20000 });
    return getActivePrinciples(dbManager).find((principle) => principle.content === content)!;
  };

  it("records every merged id and restores them all when the carrier is retired", () => {
    const a = addPrinciple("lin-1", "Verify producer output before wiring a boundary.");
    const b = addPrinciple("lin-2", "Read a record back after any mutation.");
    const c = addPrinciple("lin-3", "Classify lint failures against the commit range first.");

    const extra = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: "merge evidence" }], {
      captureId: "lin-merge", source: "manual",
    });
    const merged = mergeInto([a.id, b.id, c.id], "Verify both sides of a contract before and after changing it.", extra.eventIds);

    const lineage = dbManager.getDb()
      .prepare("SELECT supersedes_id, superseded_ids FROM principles WHERE id = ?")
      .get(merged.id) as { supersedes_id: number; superseded_ids: string };
    assert.equal(lineage.supersedes_id, a.id, "legacy pointer keeps the first id");
    assert.deepEqual(JSON.parse(lineage.superseded_ids).sort(), [a.id, b.id, c.id].sort(), "full lineage is stored");

    // 退役这条合并载体 → 三条前驱必须全部恢复
    const result = retirePrinciple(dbManager, merged.id, "retiring the merge carrier");
    assert.equal(result.retired, merged.id);
    assert.deepEqual(result.restored.sort((x, y) => x - y), [a.id, b.id, c.id].sort((x, y) => x - y));

    const activeIds = getActivePrinciples(dbManager).map((principle) => principle.id).sort((x, y) => x - y);
    assert.deepEqual(activeIds, [a.id, b.id, c.id].sort((x, y) => x - y), "no principle is lost");
    assert.equal(findOrphanedLineage(dbManager).length, 0, "lineage is clean after a safe retire");
  });

  it("leaves a predecessor superseded when another active carrier still holds it", () => {
    const a = addPrinciple("lin-4", "Sample real utilization before raising a limit.");
    const extra = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: "refine evidence" }], {
      captureId: "lin-carrier", source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "refine", scope: "global", content: "Sample real utilization over an hour before raising a limit.",
      rationale: "refined", sourceEventIds: extra.eventIds, existingPrincipleIds: [a.id],
    }], { charLimit: 20000 });
    const carrier = getActivePrinciples(dbManager).find((principle) => principle.supersedesId === a.id)!;

    // 第二个活跃载体也声称承载同一条前驱（模拟并发/人工写入）
    dbManager.getDb().prepare(
      "INSERT INTO principles (scope, project, content, status, supersedes_id, superseded_ids, created_at, updated_at) VALUES ('global', NULL, ?, 'active', ?, ?, ?, ?)",
    ).run("Alternative carrier of the same rule.", a.id, JSON.stringify([a.id]), new Date().toISOString(), new Date().toISOString());

    const result = retirePrinciple(dbManager, carrier.id, "retire one of two carriers");
    assert.deepEqual(result.restored, [], "the predecessor still has an active carrier, so it stays superseded");
    const predecessor = dbManager.getDb().prepare("SELECT status FROM principles WHERE id = ?").get(a.id) as { status: string };
    assert.equal(predecessor.status, "superseded");
    assert.equal(findOrphanedLineage(dbManager).length, 0);
  });

  it("refuses to retire a row that is not active", () => {
    const a = addPrinciple("lin-5", "Instrument before optimizing.");
    const result = retirePrinciple(dbManager, a.id, "first retire");
    assert.equal(result.retired, a.id);
    const again = retirePrinciple(dbManager, a.id, "second retire");
    assert.ok(again.error, "a second retire reports the row is no longer active");
    assert.equal(findOrphanedLineage(dbManager).length, 0);
  });

  it("reports an orphaned chain left by a naive retirement", () => {
    const a = addPrinciple("lin-6", "Check the migration order before backfilling.");
    const extra = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: "refine evidence" }], {
      captureId: "lin-refine", source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "refine", scope: "global", content: "Check the migration order before any backfill runs.",
      rationale: "refined", sourceEventIds: extra.eventIds, existingPrincipleIds: [a.id],
    }], { charLimit: 20000 });
    const successor = getActivePrinciples(dbManager).find((principle) => principle.supersedesId === a.id)!;

    // 模拟"绕过命令直接退役"造成的断链
    dbManager.getDb().prepare("UPDATE principles SET status = 'rejected' WHERE id = ?").run(successor.id);
    const orphans = findOrphanedLineage(dbManager);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.predecessorId, a.id);
    assert.deepEqual(orphans[0]!.retiredSuccessors, [successor.id]);
  });
  it("separates a broken chain from a legacy row with no recorded predecessor link", () => {
    const a = addPrinciple("lin-7", "Verify the producer emits the field before wiring it.");
    const extra = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: "refine evidence 2" }], {
      captureId: "lin-refine-2", source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "refine", scope: "global", content: "Verify the producer emits the field and route before wiring it.",
      rationale: "refined", sourceEventIds: extra.eventIds, existingPrincipleIds: [a.id],
    }], { charLimit: 20000 });
    const carrier = getActivePrinciples(dbManager).find((principle) => principle.supersedesId === a.id)!;

    // 模拟历史缺口：一个 superseded 行，没有任何行声称承载它
    const orphanRowId = dbManager.getDb().prepare(
      "INSERT INTO principles (scope, project, content, status, created_at, updated_at) VALUES ('global', NULL, ?, 'superseded', ?, ?)",
    ).run("Legacy row with no back-link.", new Date().toISOString(), new Date().toISOString()).lastInsertRowid;

    assert.equal(countUnlinkedSuperseded(dbManager), 1, "the legacy row is counted as a provenance gap");
    assert.equal(findOrphanedLineage(dbManager).length, 0, "and it is NOT reported as a broken chain");

    // 真正断链：承载者被直接退役
    dbManager.getDb().prepare("UPDATE principles SET status = 'rejected' WHERE id = ?").run(carrier.id);
    const broken = findOrphanedLineage(dbManager);
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.predecessorId, a.id);
    assert.ok(orphanRowId);
  });
});
