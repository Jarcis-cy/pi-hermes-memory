import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupExpertModelRouting, resolveExpertModel } from "../../src/handlers/expert-model-routing.js";

const date = "2026-01-01T00:00:00Z";
const now = Date.parse("2026-02-01T00:00:00Z");
function budget() { return { version: 1 as const, preference: "auto" as const, accounts: Object.fromEntries(["gpt", "glm", "deepseek"].map(p => [p, { status: "available", updatedAt: date, plan: "keep" }])) } as any; }
const models = [
  ["openai-codex", "gpt-6-luna"], ["openai-codex", "gpt-6.1-terra"], ["openai-codex", "gpt-6.1-sol"],
  ["zai-coding-cn", "glm-5.3-flash"], ["zai-coding-cn", "glm-5.3"], ["newapi-upstream", "deepseek-flash"],
].map(([provider, id]) => ({ provider, id, reasoning: true, thinkingLevelMap: { max: "high" } }));
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

test("no config: no hooks or tool registered", () => { const f = fixture(false); try { assert.deepEqual(f.hooks, {}); assert.equal(f.tool, undefined); } finally { f.cleanup(); } });
test("prompt sections, default and explicit classification; parent and unrelated tools unchanged", async () => {
  const f = fixture(); try {
    const event = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
    await f.hooks.before_agent_start(event, f.ctx);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /Long-term rules/);
    assert.match(event.systemPromptOptions.sections.expert_model_routing, /research=zai-coding-cn/);
    const input: Record<string, unknown> = {}; assert.equal(await call(f, input), undefined); assert.equal(input.model, "zai-coding-cn/glm-5.3-flash:high");
    const expert: Record<string, unknown> = { subagent_type: "backend-rnd" }; await call(f, expert); assert.equal(expert.model, "openai-codex/gpt-6.1-sol:medium");
    const oracle: Record<string, unknown> = { subagent_type: "oracle", model: "auto" }; await call(f, oracle); assert.equal(oracle.model, "openai-codex/gpt-6.1-sol:high");
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
  b.accounts.gpt.status = "exhausted"; assert.match(resolve("auto:critical").error!, /No eligible/);
});
test("levels are never clamped, unknown model and ambiguous native ID blocked", () => {
  const b = budget();
  assert.match(resolveExpertModel(b, models, "auto:nonsense", now).error!, /Unknown/);
  assert.match(resolveExpertModel(b, models, "openai-codex/absent:high", now).error!, /not available/);
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna", now).error!, /complete/);
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna:max", now).model!, /:max/);
  const restricted = models.map(m => ({ ...m, thinkingLevelMap: { high: null } }));
  assert.match(resolveExpertModel(b, restricted, "openai-codex/gpt-6-luna:high", now).error!, /does not support/);
  assert.match(resolveExpertModel(b, restricted, "openai-codex/gpt-6-luna:max", now).error!, /does not support/);
  const collision = [...models, { provider: "openai-codex", id: "gpt-6-luna:medium", reasoning: true, thinkingLevelMap: { max: "high" } }];
  assert.match(resolveExpertModel(b, models, "openai-codex/gpt-6-luna:medium", now, collision).error!, /Ambiguous/);
});
test("resume never rewritten; invalid and removed configuration fail closed", async () => {
  const f = fixture(); try {
    const resume = { resume: "session" }; assert.equal(await call(f, resume), undefined); assert.deepEqual(resume, { resume: "session" });
    assert.equal((await call(f, { resume: "session", model: "auto:research" })).block, true);
    const blank: Record<string, unknown> = { resume: " " }; await call(f, blank); assert.equal(blank.model, "zai-coding-cn/glm-5.3-flash:high", "blank resume is a new call, as in the host runtime");
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
