import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupExpertModelRouting, resolveExpertModel } from "../../src/handlers/expert-model-routing.js";
import { loadConfig } from "../../src/config.js";
import { expertPathsFor } from "../../src/handlers/expert.js";

const date = "2026-01-01T00:00:00Z";
const now = Date.parse("2026-02-01T00:00:00Z");
function budget() { return { version: 1 as const, preference: "auto" as const, accounts: Object.fromEntries(["gpt", "glm", "deepseek"].map(p => [p, { status: "available", updatedAt: date, plan: "keep" }])) } as any; }
const models = [
  ["openai-codex", "gpt-6-luna"], ["openai-codex", "gpt-6.1-terra"], ["openai-codex", "gpt-6.1-sol"],
  ["zai-coding-cn", "glm-5.4"],
  ["zai-coding-cn", "glm-5.3-flash"], ["zai-coding-cn", "glm-5.3"], ["newapi-upstream", "deepseek-flash"],
].map(([provider, id]) => ({ provider, id, reasoning: true, thinkingLevelMap: { max: "max" } }));
function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "expert-routing-")), dir = join(root, "_shared"), file = join(dir, "model-budget.json");
  mkdirSync(dir); if (enabled) writeFileSync(file, JSON.stringify(budget()));
  writeFileSync(join(dir, "MODEL-ROUTING.md"), "Long-term rules");
  const hooks: Record<string, Function> = {}; let tool: any; let active = ["Agent"];
  const pi = { on: (name: string, fn: Function) => { hooks[name] = fn; }, registerTool: (t: any) => { tool = t; }, getActiveTools: () => active };
  setupExpertModelRouting(pi as never, root);
  const ctx = { model: { id: "parent" }, modelRegistry: { getAvailable: () => models, getAll: () => models } };
  return { root, file, hooks, ctx, tool, setActive: (a: string[]) => { active = a; }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function call(f: ReturnType<typeof fixture>, input: Record<string, unknown>, name = "Agent") { return f.hooks.tool_call({ toolName: name, input }, f.ctx); }
async function action(f: ReturnType<typeof fixture>, params: object) { return f.tool.execute("id", params); }

test("Luna extract uses max and rejects weaker explicit levels without clamping", () => {
  const b = budget(); b.preference = "gpt";
  assert.equal(resolveExpertModel(b, models, "auto:extract", now).model, "openai-codex/gpt-6-luna:max");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.match(resolveExpertModel(b, models, `openai-codex/gpt-6-luna:${level}`, now).error!, /Luna.*max/i);
  }
  assert.equal(resolveExpertModel(b, models, "openai-codex/gpt-6-luna:max", now).model, "openai-codex/gpt-6-luna:max");
  const noMax = models.map(m => m.id === "gpt-6-luna" ? { ...m, thinkingLevelMap: {} } : m);
  b.accounts.glm.status = "disabled"; b.accounts.deepseek.status = "disabled";
  assert.match(resolveExpertModel(b, noMax, "openai-codex/gpt-6-luna:max", now).error!, /does not support thinking level max/);
  assert.match(resolveExpertModel(b, noMax, "auto:extract", now).error!, /does not support thinking level max/);
});

test("GLM-5.4 is first for all categories under glm and auto; unavailable pools fall back", () => {
  const b = budget();
  for (const preference of ["glm", "auto"]) {
    b.preference = preference;
    for (const category of ["extract", "research", "implement", "agentic", "critical"]) {
      const request = `auto:${category}`;
      assert.equal(resolveExpertModel(b, models, request, now).model, "zai-coding-cn/glm-5.4:max");
      for (const status of ["exhausted", "disabled"]) {
        b.accounts.glm.status = status;
        assert.match(resolveExpertModel(b, models, request, now).model!, /^openai-codex\//);
      }
      b.accounts.glm.status = "available"; b.accounts.glm.expiresAt = date;
      assert.match(resolveExpertModel(b, models, request, now).model!, /^openai-codex\//);
      b.accounts.glm.expiresAt = null;
    }
  }
  b.accounts.glm.status = "exhausted"; b.accounts.gpt.status = "disabled";
  assert.equal(resolveExpertModel(b, models, "auto:implement", now).model, "newapi-upstream/deepseek-flash:max");
  assert.match(resolveExpertModel(b, models, "auto:critical", now).error!, /No eligible/);
});

test("GLM-5.4 is max-only and never downgrades when max is missing", () => {
  const b = budget();
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.match(resolveExpertModel(b, models, `zai-coding-cn/glm-5.4:${level}`, now).error!, /GLM-5\.4.*max/);
  }
  for (const max of [null, undefined]) {
    const noMax = models.map(m => m.id === "glm-5.4" ? { ...m, thinkingLevelMap: { low: "low", high: "high", max } } : m);
    assert.match(resolveExpertModel(b, noMax, "zai-coding-cn/glm-5.4:max", now).error!, /does not support thinking level max/);
    assert.equal(resolveExpertModel(b, noMax, "auto:extract", now).model, "openai-codex/gpt-6-luna:max");
    b.accounts.gpt.status = "disabled"; b.accounts.deepseek.status = "disabled";
    assert.match(resolveExpertModel(b, noMax, "auto:critical", now).error!, /does not support thinking level max/);
    b.accounts.gpt.status = "available"; b.accounts.deepseek.status = "available";
  }
});

test("GLM-5.3-Flash remains max-only for explicit requests", () => {
  const b = budget();
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.match(resolveExpertModel(b, models, `zai-coding-cn/glm-5.3-flash:${level}`, now).error!, /GLM-5\.3-Flash.*max/);
  }
  assert.equal(resolveExpertModel(b, models, "zai-coding-cn/glm-5.3-flash:max", now).model, "zai-coding-cn/glm-5.3-flash:max");
  const aliased = [...models, { provider: "neibu", id: "glm-5.3-flash", reasoning: true, thinkingLevelMap: { high: "high", max: "max" } }];
  assert.match(resolveExpertModel(b, aliased, "neibu/glm-5.3-flash:high", now).error!, /GLM-5\.3-Flash.*max/);
  assert.equal(resolveExpertModel(b, aliased, "neibu/glm-5.3-flash:max", now).model, "neibu/glm-5.3-flash:max");
  const noFlashMax = models.map(m => m.id === "glm-5.3-flash" ? { ...m, thinkingLevelMap: { low: "low", high: "high" } } : m);
  assert.match(resolveExpertModel(b, noFlashMax, "zai-coding-cn/glm-5.3-flash:max", now).error!, /does not support thinking level max/);
});

test("expert extract keeps task classification and injection describes progressive first pass", async () => {
  const f = fixture(); try {
    const b = budget(); b.preference = "gpt"; writeFileSync(f.file, JSON.stringify(b));
    const input: Record<string, unknown> = { subagent_type: "backend-rnd", model: "auto:extract" };
    assert.equal(await call(f, input), undefined);
    assert.equal(input.model, "openai-codex/gpt-6-luna:max");
    const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
    await f.hooks.before_agent_start(event, f.ctx);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /progressive first pass/i);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /reuse existing materials.*concise conclusions.*identify gaps/i);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /Luna max reasoning does not expand report depth/i);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /GLM-5\.3-Flash is the mechanical\/simple base tier.*max effort only/i);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /Routing v3/);
    assert.match((await action(f, { action: "status" })).content[0].text, /routing=v3; Luna=max; Flash=max/);
  } finally { f.cleanup(); }
});

test("no config: no hooks or tool registered", () => { const f = fixture(false); try { assert.deepEqual(f.hooks, {}); assert.equal(f.tool, undefined); } finally { f.cleanup(); } });
test("prompt sections, default and explicit classification; parent and unrelated tools unchanged", async () => {
  const f = fixture(); try {
    const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
    await f.hooks.before_agent_start(event, f.ctx);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /Long-term rules/);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /research=zai-coding-cn/);
    const input: Record<string, unknown> = { model: "auto:research" }; assert.equal(await call(f, input), undefined); assert.equal(input.model, "zai-coding-cn/glm-5.4:max");
    const expert: Record<string, unknown> = { subagent_type: "backend-rnd", model: "auto:agentic" }; await call(f, expert); assert.equal(expert.model, "zai-coding-cn/glm-5.4:max");
    const oracle: Record<string, unknown> = { subagent_type: "oracle", model: "auto:critical" }; await call(f, oracle); assert.equal(oracle.model, "zai-coding-cn/glm-5.4:max");
    const other: Record<string, unknown> = {}; await call(f, other, "bash"); assert.deepEqual(other, {}); assert.equal(f.ctx.model.id, "parent");
    const old = await f.hooks.before_agent_start({ systemPrompt: "base" }, f.ctx); assert.match(old.systemPrompt, /^base\n\nLong-term rules/);
    f.setActive([]); const noAgent = { systemPrompt: "base", systemPromptOptions: { sections: {} } }; assert.equal(await f.hooks.before_agent_start(noAgent, f.ctx), undefined); assert.deepEqual(noAgent.systemPromptOptions.sections, {});
  } finally { f.cleanup(); }
});
test("pool states, expiry, reset recheck and preference", () => {
  const b = budget(); const resolve = (r = "auto:research") => resolveExpertModel(b, models, r, now);
  assert.match(resolve().model!, /^zai/);
  b.accounts.glm.status = "exhausted"; b.accounts.glm.nextResetAt = date; assert.match(resolve().model!, /^openai/);
  assert.match(resolve("zai-coding-cn/glm-5.3-flash:high").error!, /recheck/);
  b.accounts.glm.status = "available"; assert.match(resolve().model!, /^zai/);
  b.accounts.glm.expiresAt = "2026-02-01T00:00:00Z"; assert.match(resolve().model!, /^openai/); assert.match(resolve("zai-coding-cn/glm-5.3-flash:high").error!, /expired/);
  b.accounts.glm.expiresAt = null; b.preference = "deepseek"; assert.match(resolve().model!, /^newapi/);
  b.preference = "gpt"; assert.match(resolve().model!, /^openai/);
  b.accounts.gpt.status = "constrained"; assert.match(resolve().model!, /^zai/); assert.match(resolve("auto:critical").model!, /gpt-6.1-sol:high/);
  b.accounts.gpt.status = "exhausted"; assert.equal(resolve("auto:critical").model, "zai-coding-cn/glm-5.4:max");
});
test("levels are never clamped, unknown model and ambiguous native ID blocked", () => {
  const b = budget();
  assert.match(resolveExpertModel(b, models, "auto:nonsense", now).error!, /Unknown/);
  assert.match(resolveExpertModel(b, models, "openai-codex/absent:high", now).error!, /not available/);
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna", now).error!, /complete/);
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna:max", now).model!, /:max/);
  const restricted = models.map(m => ({ ...m, thinkingLevelMap: { high: null } }));
  assert.match(resolveExpertModel(b, restricted, "openai-codex/gpt-6.1-terra:high", now).error!, /does not support/);
  assert.match(resolveExpertModel(b, restricted, "openai-codex/gpt-6-luna:max", now).error!, /does not support/);
  const collision = [...models, { provider: "openai-codex", id: "gpt-6-luna:medium", reasoning: true, thinkingLevelMap: { max: "high" } }];
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna:medium", now, collision).error!, /Ambiguous/);
});
test("resume never rewritten; invalid and removed configuration fail closed", async () => {
  const f = fixture(); try {
    const resume = { resume: "session", description: "[continue] same investigation" }; assert.equal(await call(f, resume), undefined); assert.deepEqual(resume, { resume: "session", description: "[continue] same investigation" });
    assert.equal((await call(f, { resume: "session", model: "auto:research" })).block, true);
    const blank: Record<string, unknown> = { resume: " ", model: "auto:research" }; await call(f, blank); assert.equal(blank.model, "zai-coding-cn/glm-5.4:max", "blank resume is a new call, as in the host runtime");
    for (const bad of ["{", JSON.stringify({ ...budget(), version: 2 }), JSON.stringify({ ...budget(), accounts: { ...budget().accounts, glm: { status: "bogus", updatedAt: date } } })]) {
      writeFileSync(f.file, bad); assert.equal((await call(f, {})).block, true);
    }
    rmSync(f.file); assert.equal((await call(f, {})).block, true);
  } finally { f.cleanup(); }
});
test("budget actions preserve fields, enforce lock and parent authorization", async () => {
  const f = fixture(); try {
    assert.match((await action(f, { action: "status" })).content[0].text, /preference=auto/);
    assert.equal((await action(f, { action: "prefer", preference: "deepseek" })).isError, undefined);
    assert.equal((await action(f, { action: "account", pool: "glm", status: "exhausted", note: "user reported quota", nextResetAt: date })).isError, undefined);
    let b = JSON.parse(readFileSync(f.file, "utf8")); assert.equal(b.preference, "deepseek"); assert.equal(b.accounts.glm.plan, "keep"); assert.equal(b.accounts.glm.nextResetAt, date); assert.notEqual(b.accounts.glm.updatedAt, date);
    await action(f, { action: "account", pool: "glm", status: "available", note: "user confirmed", nextResetAt: null });
    b = JSON.parse(readFileSync(f.file, "utf8")); assert.equal(b.accounts.glm.nextResetAt, null);
    writeFileSync(`${f.file}.lock`, "foreign"); assert.match((await action(f, { action: "prefer", preference: "gpt" })).content[0].text, /busy/); assert.equal(readFileSync(`${f.file}.lock`, "utf8"), "foreign");
    f.setActive([]); assert.equal((await action(f, { action: "account", pool: "gpt", status: "disabled", note: "user" })).isError, true);
    assert.equal(JSON.parse(readFileSync(f.file, "utf8")).accounts.gpt.status, "available");
  } finally { f.cleanup(); }
});

test("new work requires classification regardless of profile; retired GPT models are rejected", async () => {
  const f = fixture(); try {
    for (const subagent_type of [undefined, "utility", "backend-rnd", "oracle"]) {
      for (const model of [undefined, "auto", "", " "]) {
        const input = { subagent_type, model };
        assert.match((await call(f, input)).reason, /classif/i);
        assert.equal(input.model, model, "missing classification must not guess from role");
      }
    }
    const expert: Record<string, unknown> = { subagent_type: "backend-rnd", model: "auto:extract" };
    await call(f, expert); assert.equal(expert.model, "zai-coding-cn/glm-5.4:max");
    const retired = [...models, ...["luna", "terra", "sol"].map(name => ({ ...models[0], id: `gpt-5.6-${name}` }))];
    for (const name of ["luna", "terra", "sol"]) {
      assert.match(resolveExpertModel(budget(), retired, `openai-codex/gpt-5.6-${name}:medium`, now).error!, /GPT.*6/i);
    }
    const b = budget(); b.preference = "gpt";
    for (const [category, model] of [["extract", "gpt-6-luna:max"], ["research", "gpt-6.1-terra:medium"], ["implement", "gpt-6.1-terra:high"], ["agentic", "gpt-6.1-sol:medium"], ["critical", "gpt-6.1-sol:high"]]) {
      assert.equal(resolveExpertModel(b, models, `auto:${category}`, now).model, `openai-codex/${model}`);
    }
    b.accounts.glm.status = "exhausted"; b.accounts.deepseek.status = "disabled";
    assert.match(resolveExpertModel(b, retired.filter(m => !m.id.startsWith("gpt-6")), "auto:extract", now).error!, /No eligible/);
  } finally { f.cleanup(); }
});

test("resume requires conscious same-task declaration; independent tail work starts a classified child", async () => {
  const f = fixture(); try {
    assert.match((await call(f, { resume: "existing", description: "update issue comment" })).reason, /\[continue\]/);
    assert.equal(await call(f, { resume: "existing", description: "[continue] fix the same failing regression" }), undefined);
    assert.equal((await call(f, { resume: "existing", description: "[continue] same fix", model: "auto:implement" })).block, true);
    const independent: Record<string, unknown> = { subagent_type: "utility", model: "auto:extract", description: "batch issue readbacks" };
    await call(f, independent); assert.equal(independent.model, "zai-coding-cn/glm-5.4:max");
  } finally { f.cleanup(); }
});

test("config file to expert paths to hook follows the configured root, not the host default", async () => {
  const f = fixture(); try {
    const configPath = join(f.root, "host-config.json");
    writeFileSync(configPath, JSON.stringify({ expertBaseDir: f.root }));
    const paths = expertPathsFor(join(f.root, "different-agent-root"), loadConfig(configPath).expertBaseDir);
    const hooks: Record<string, Function> = {}; const names: string[] = [];
    setupExpertModelRouting({ on: (name: string, fn: Function) => { hooks[name] = fn; }, getActiveTools: () => ["Agent"], registerTool: (t: any) => { names.push(t.name); } } as never, paths.expertBaseDir);
    assert.ok(names.includes("model_budget"));
    const input = { model: "auto:research" };
    assert.equal(await hooks.tool_call({ toolName: "Agent", input }, f.ctx), undefined);
    assert.equal(input.model, "zai-coding-cn/glm-5.4:max");
  } finally { f.cleanup(); }
});
