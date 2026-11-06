import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseManager } from "../../src/store/db.js";
import { EVENT_ENTITIES_VERSION, deriveEventEntities } from "../../src/store/event-entities.js";
import { captureMemoryEvents } from "../../src/store/event-memory-store.js";

describe("deriveEventEntities", () => {
  it("tags tickets and repo-relative paths", () => {
    assert.deepEqual(
      deriveEventEntities("IAR-1839 regression: internal/agent/runtime transport broke"),
      ["iar-1839", "internal/agent/runtime"],
    );
  });

  it("tags ports, because a port is how people name an environment", () => {
    const tags = deriveEventEntities("dev 后端 :28080 起来了，vite :25173 还在起");
    assert.ok(tags.includes("port-28080"), tags.join(","));
    assert.ok(tags.includes("port-25173"), tags.join(","));
  });

  it("tags multi-segment container and unit shapes", () => {
    const tags = deriveEventEntities("容器 code-audit-dev-postgres 正常，pi-web.service 也是");
    assert.ok(tags.includes("code-audit-dev-postgres"), tags.join(","));
    assert.ok(tags.includes("pi-web.service"), tags.join(","));
  });

  it("drops abbreviations and measurements that only look like identifiers", () => {
    assert.deepEqual(deriveEventEntities("重启后 (e.g. 旧进程) 0.00s 就退出"), []);
    assert.deepEqual(deriveEventEntities("took 1.2.3 seconds, 3.5ms later, vs. before"), []);
  });

  it("is deterministic, lowercased, de-duplicated, and capped", () => {
    const once = deriveEventEntities("IAR-1839 iar-1839 :28080 port-28080");
    assert.deepEqual(once, [...new Set(once)]);
    assert.ok(once.every((tag) => tag === tag.toLowerCase()));
    assert.ok(once.length <= 8);
  });
});

describe("entity backfill", () => {
  const openDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "entities-"));

  it("re-derives the whole ledger when the derivation version changes", () => {
    const dir = openDir();
    let manager = new DatabaseManager(dir);
    captureMemoryEvents(manager, [{
      scope: "global",
      kind: "insight",
      content: "dev 栈 :28080 挂了 (e.g. 旧进程)",
    }], { captureId: "entity-backfill", source: "manual" });

    // Simulate a ledger written by the previous derivation: stale tags, and no
    // version marker, so the next open must rebuild everything.
    const db = manager.getDb();
    db.prepare("UPDATE memory_events SET entities = '|e.g|'").run();
    db.prepare("DELETE FROM extension_metadata WHERE key = 'event_entities_version'").run();
    manager.close();

    manager = new DatabaseManager(dir);
    const row = manager.getDb().prepare(
      "SELECT entities FROM memory_events WHERE capture_id = 'entity-backfill'",
    ).get() as { entities: string } | undefined;
    assert.ok(row?.entities.includes("port-28080"), `expected a port tag, got ${row?.entities}`);
    assert.ok(!row?.entities.includes("|e.g|"), "the old false positive must be gone");

    const version = manager.getDb().prepare(
      "SELECT value FROM extension_metadata WHERE key = 'event_entities_version'",
    ).get() as { value: string } | undefined;
    assert.equal(version?.value, EVENT_ENTITIES_VERSION);

    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
