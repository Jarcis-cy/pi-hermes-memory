import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createExpert,
  expertPathsFor,
  expertStatus,
  listExperts,
} from "../../src/handlers/expert.js";

describe("expert scaffolding", () => {
  let root: string;
  let paths: ReturnType<typeof expertPathsFor>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "expert-test-"));
    paths = expertPathsFor(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scaffolds charter, craft layer, project layer root, and agent definition", () => {
    const result = createExpert(paths, "vuln-review", "漏洞审核：对扫描发现做人工级复核与定级");
    assert.equal(result.ok, true);
    const dir = result.expertDir!;
    assert.ok(fs.existsSync(path.join(dir, "AGENTS.md")), "charter created");
    assert.ok(fs.existsSync(path.join(dir, "CRAFT.md")), "cross-project craft file created");
    assert.ok(fs.existsSync(path.join(dir, "projects", ".gitkeep")), "projects/ root created");
    const charter = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    assert.match(charter, /projects\/<本项目>\/STATE\.md/);
    assert.match(charter, /CRAFT\.md/);
    assert.match(charter, /漏洞审核/, "charter carries the domain description");
    const agent = fs.readFileSync(result.agentPath!, "utf-8");
    assert.match(agent, /^name: vuln-review$/m);
    assert.match(agent, /^tools: read, grep, find, ls, bash$/m);
  });

  it("keeps per-project zones isolated and never mixes them", async () => {
    const { ensureProjectZone } = await import("../../src/handlers/expert.js");
    createExpert(paths, "storage", "存储治理");
    const zoneA = ensureProjectZone(path.join(paths.expertBaseDir, "storage"), "code-audit", "storage");
    const zoneB = ensureProjectZone(path.join(paths.expertBaseDir, "storage"), "project-b", "storage");
    assert.notEqual(zoneA, zoneB);
    fs.appendFileSync(path.join(zoneA, "STATE.md"), "- 项目A的存储状态\n", "utf-8");
    const stateB = fs.readFileSync(path.join(zoneB, "STATE.md"), "utf-8");
    assert.ok(!stateB.includes("项目A"), "project B state never inherits project A content");
    for (const file of ["STATE.md", "LOG.md", "DECISIONS.md"]) {
      assert.ok(fs.existsSync(path.join(zoneA, file)), `${file} in zone A`);
    }
  });

  it("refuses duplicate experts lookup-first instead of overwriting", () => {
    assert.equal(createExpert(paths, "qa", "测试治理 A").ok, true);
    const second = createExpert(paths, "qa", "测试治理 B（试图覆盖）");
    assert.equal(second.ok, false);
    assert.match(second.message, /已存在/);
    const charter = fs.readFileSync(path.join(paths.expertBaseDir, "qa", "AGENTS.md"), "utf-8");
    assert.match(charter, /测试治理 A/, "original charter untouched");
  });

  it("refuses unsafe names before touching the filesystem", () => {
    for (const bad of ["../escape", "Up/Case", "a b", ".hidden", "x".repeat(41)]) {
      const result = createExpert(paths, bad, "desc");
      assert.equal(result.ok, false, `${bad} must be rejected`);
      assert.match(result.message, /无效名字/);
    }
    assert.equal(fs.existsSync(paths.expertBaseDir), false, "nothing scaffolded for bad names");
  });

  it("never overwrites files on re-scaffold of a directory-only expert", () => {
    // Simulate a half-created expert: directory exists, agent definition missing.
    fs.mkdirSync(path.join(paths.expertBaseDir, "half"), { recursive: true });
    fs.writeFileSync(path.join(paths.expertBaseDir, "half", "AGENTS.md"), "手工章程", "utf-8");
    const result = createExpert(paths, "half", "补齐");
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(paths.expertBaseDir, "half", "AGENTS.md"), "utf-8"), "手工章程");
    assert.ok(fs.existsSync(path.join(paths.expertBaseDir, "half", "CRAFT.md")), "missing files filled in");
    assert.ok(fs.existsSync(path.join(paths.expertBaseDir, "half", "projects")), "projects/ filled in");
    assert.ok(fs.existsSync(path.join(paths.agentsDir, "half.md")), "agent definition added");
  });

  it("lists experts with STATE fill and reports status", () => {
    createExpert(paths, "alpha", "领域一");
    createExpert(paths, "beta", "领域二");
    const listing = listExperts(paths);
    assert.match(listing, /alpha/);
    assert.match(listing, /beta/);
    assert.match(listing, /手艺 \d+ 条/);
    const status = expertStatus(paths, "alpha");
    assert.match(status, /Agent 定义: 已就绪/);
    assert.match(status, /手艺（跨项目）: 0 条/);
    assert.match(expertStatus(paths, "missing"), /没有专家/);
  });
});

describe("expert display names", () => {
  it("derives a quoted Chinese display name from the description's leading segment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "expert-dn-"));
    const paths = expertPathsFor(root);
    const result = createExpert(paths, "demo", "测试治理：code-audit 的门禁与 flaky");
    const agent = fs.readFileSync(result.agentPath!, "utf-8");
    assert.match(agent, /^display_name: "测试治理"$/m);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
