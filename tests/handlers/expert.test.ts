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

  it("scaffolds charter, memory files, and a dispatchable agent definition", () => {
    const result = createExpert(paths, "vuln-review", "漏洞审核：对扫描发现做人工级复核与定级");
    assert.equal(result.ok, true);
    const dir = result.expertDir!;
    for (const file of ["AGENTS.md", "STATE.md", "LOG.md", "DECISIONS.md"]) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} created`);
    }
    assert.ok(fs.existsSync(path.join(dir, "refs", ".gitkeep")), "refs/ created");
    const charter = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf-8");
    assert.match(charter, /开工先读 `STATE\.md`/);
    assert.match(charter, /漏洞审核/, "charter carries the domain description");
    const agent = fs.readFileSync(result.agentPath!, "utf-8");
    assert.match(agent, /^name: vuln-review$/m);
    assert.match(agent, /^tools: read, grep, find, ls, bash$/m);
    assert.match(agent, /开工先读 STATE\.md/);
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
    assert.ok(fs.existsSync(path.join(paths.expertBaseDir, "half", "STATE.md")), "missing files filled in");
    assert.ok(fs.existsSync(path.join(paths.agentsDir, "half.md")), "agent definition added");
  });

  it("lists experts with STATE fill and reports status", () => {
    createExpert(paths, "alpha", "领域一");
    createExpert(paths, "beta", "领域二");
    const listing = listExperts(paths);
    assert.match(listing, /alpha/);
    assert.match(listing, /beta/);
    assert.match(listing, /STATE \d+%/);
    const status = expertStatus(paths, "alpha");
    assert.match(status, /Agent 定义: 已就绪/);
    assert.match(status, /记忆作用域/);
    assert.match(expertStatus(paths, "missing"), /没有专家/);
  });
});
