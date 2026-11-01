import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { DEFAULT_PRINCIPLE_CHAR_LIMIT, DEFAULT_PRINCIPLE_STORE_CHAR_LIMIT } from "../../src/constants.js";
import {
  applyConcretionPlan,
  captureMemoryEvents,
  getActivePrinciples,
  getMemoryEvents,
  renderAdaptivePrinciples,
  startConcretionRun,
} from "../../src/store/event-memory-store.js";

describe("injection budget vs storage budget", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budgets-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const add = (cid: string, content: string, charLimit: number) => {
    const capture = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: `${cid} evidence` }], {
      captureId: cid, source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    return applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "add", scope: "global", content, rationale: cid, sourceEventIds: capture.eventIds, existingPrincipleIds: [],
    }], { charLimit });
  };

  it("keeps accepting additions when the store is larger than the injection budget", () => {
    // 注入预算 120 字符、存储预算 2000：第一条就超过注入预算，但库是空的
    const first = add("budget-1", "First durable rule that fits the store easily.", 2000);
    assert.equal(first.added, 1, "a store budget larger than the injection budget must admit the rule");
    assert.equal(first.conflicts, 0);

    // 注入渲染受注入预算约束：超出的条目被省略并进入索引
    const rendered = renderAdaptivePrinciples(dbManager, null, false, 120);
    const block = rendered.slice(rendered.indexOf("<adaptive-principles>"), rendered.indexOf("</adaptive-principles>"));
    assert.match(block, /are not shown in this run/);
    assert.match(rendered, /<principle-index>/);
    assert.equal(getActivePrinciples(dbManager).length, 1, "omission never deletes");
  });

  it("still refuses an addition that would exceed the store budget", () => {
    const first = add("budget-2", "A".repeat(1500), 2000);
    assert.equal(first.added, 1);
    const second = add("budget-3", "B".repeat(1500), 2000);
    assert.equal(second.added, 0, "storage is still bounded");
    assert.equal(second.conflicts, 1, "the candidate is parked rather than dropped");
  });

  it("ships a store default that leaves room above the injection default", () => {
    assert.ok(
      DEFAULT_PRINCIPLE_STORE_CHAR_LIMIT > DEFAULT_PRINCIPLE_CHAR_LIMIT,
      "the two budgets must not be the same number",
    );
  });
});

describe("store budget sizing", () => {
  let tmpDir: string;
  let dbManager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budgets-sizing-"));
    dbManager = new DatabaseManager(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const add = (cid: string, content: string, charLimit: number) => {
    const capture = captureMemoryEvents(dbManager, [{ scope: "global", kind: "insight", content: `${cid} evidence` }], {
      captureId: cid, source: "manual",
    });
    const run = startConcretionRun(dbManager, "manual", 1);
    return applyConcretionPlan(dbManager, run, getMemoryEvents(dbManager, { pendingOnly: true }), [{
      action: "add", scope: "global", content, rationale: cid, sourceEventIds: capture.eventIds, existingPrincipleIds: [],
    }], { charLimit });
  };

  it("defaults to a store budget sized for months of full-load distillation (200k, not 48k)", () => {
    // Two days of real full-load work produced ~60k chars of distinct principles
    // and re-deadlocked the layer at 48k. The default must clear that comfortably.
    assert.equal(DEFAULT_PRINCIPLE_STORE_CHAR_LIMIT, 200000);
  });

  it("admits a store far beyond the old 48k cap while still bounding growth at 200k", () => {
    assert.equal(add("a", "x".repeat(30000), 200000).added, 1);
    assert.equal(add("b", "y".repeat(30000), 200000).added, 1, "60k store is a normal mid-life state, not over capacity");
    assert.equal(add("c", "z".repeat(150000), 200000).added, 0, "210k exceeds the store budget and becomes a conflict");
  });
});
