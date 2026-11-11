import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type Pool = "gpt" | "glm" | "deepseek";
type Status = "available" | "constrained" | "exhausted" | "disabled" | "unknown";
type Preference = Pool | "auto";
type Category = "extract" | "research" | "implement" | "agentic" | "critical";
type Account = { status: Status; updatedAt: string; note?: string; nextResetAt?: string | null; expiresAt?: string | null; plan?: string };
type Budget = { version: 1; preference: Preference; accounts: Record<Pool, Account> };
type AvailableModel = { provider: string; id: string; reasoning: boolean; thinkingLevelMap?: Record<string, unknown> };
const pools: Pool[] = ["gpt", "glm", "deepseek"];
const statuses: Status[] = ["available", "constrained", "exhausted", "disabled", "unknown"];
const preferences: Preference[] = ["glm", "gpt", "deepseek", "auto"];
const categories: Category[] = ["extract", "research", "implement", "agentic", "critical"];
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const candidates: Record<Pool, Partial<Record<Category, string>>> = {
  gpt: { extract: "openai-codex/gpt-6-luna:medium", research: "openai-codex/gpt-6.1-terra:medium", implement: "openai-codex/gpt-6.1-terra:high", agentic: "openai-codex/gpt-6.1-sol:medium", critical: "openai-codex/gpt-6.1-sol:high" },
  glm: { extract: "zai-coding-cn/glm-5.3-flash:high", research: "zai-coding-cn/glm-5.3-flash:high", implement: "zai-coding-cn/glm-5.3:max" },
  deepseek: { extract: "newapi-upstream/deepseek-flash:high", research: "newapi-upstream/deepseek-flash:high", implement: "newapi-upstream/deepseek-flash:max" },
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, y, mo, d, h, min, s, tz] = m;
  const days = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  return +mo >= 1 && +mo <= 12 && +d >= 1 && +d <= days && +h <= 23 && +min <= 59 && +s <= 59 &&
    (tz === "Z" || (+tz.slice(1, 3) <= 23 && +tz.slice(4, 6) <= 59));
}
function parseBudget(text: string): Budget {
  const b = JSON.parse(text) as Budget;
  if (!b || typeof b !== "object" || b.version !== 1 || !preferences.includes(b.preference) || !b.accounts || typeof b.accounts !== "object") throw new Error("invalid budget version, preference or accounts");
  for (const pool of pools) {
    const a = b.accounts[pool];
    if (!a || typeof a !== "object" || !statuses.includes(a.status) || !validDate(a.updatedAt)) throw new Error(`invalid ${pool} account`);
    for (const key of ["expiresAt", "nextResetAt"] as const) if (a[key] != null && !validDate(a[key])) throw new Error(`invalid ${pool}.${key}`);
    for (const key of ["note", "plan"] as const) if (a[key] !== undefined && typeof a[key] !== "string") throw new Error(`invalid ${pool}.${key}`);
  }
  return b;
}
function effective(a: Account, now: number): string {
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return "expired";
  if (a.status === "exhausted" && a.nextResetAt && Date.parse(a.nextResetAt) <= now) return "exhausted (reset passed; recheck required)";
  if (a.status === "unknown") return "unknown (quota unconfirmed)";
  return a.status;
}
function allowed(a: Account, now: number): boolean {
  return !(a.expiresAt && Date.parse(a.expiresAt) <= now) && a.status !== "exhausted" && a.status !== "disabled";
}
function modelKey(m: AvailableModel): string { return `${m.provider}/${m.id}`; }
function poolFor(provider: string): Pool | undefined {
  return provider === "openai-codex" ? "gpt" : provider === "zai-coding-cn" ? "glm" : provider === "newapi-upstream" ? "deepseek" : undefined;
}
function validateModel(ref: string, budget: Budget, models: readonly AvailableModel[], now: number, registered: readonly AvailableModel[]): string | undefined {
  const colon = ref.lastIndexOf(":");
  const level = ref.slice(colon + 1);
  if (colon <= 0 || !levels.includes(level) || !ref.slice(0, colon).includes("/")) return "Use a complete provider/model:level with a valid thinking level";
  if (registered.some(m => modelKey(m) === ref)) return `Ambiguous model ${ref}: the full string is also a registered model ID and would swallow the thinking suffix`;
  const model = models.find(m => modelKey(m) === ref.slice(0, colon));
  if (!model) return `Model ${ref.slice(0, colon)} is not available or authenticated`;
  const gptVersion = /^gpt-(\d+)(?:[.-]|$)/.exec(model.id);
  if (gptVersion && Number(gptVersion[1]) < 6) return "GPT dispatch requires generation 6 or newer; use GPT-6 Luna or GPT-6.1 Terra/Sol, not a 5.x fallback";
  const pool = poolFor(model.provider);
  if (pool && !allowed(budget.accounts[pool], now)) return `${pool} pool is ${effective(budget.accounts[pool], now)}`;
  const mapped = model.thinkingLevelMap?.[level];
  if ((!model.reasoning && level !== "off") || mapped === null || ((level === "xhigh" || level === "max") && mapped === undefined)) return `Model ${modelKey(model)} does not support thinking level ${level}`;
  return undefined;
}

/** Resolve an explicit model or auto category without mutating the parent session. */
export function resolveExpertModel(budget: Budget, models: readonly AvailableModel[], request: string, now = Date.now(), registered: readonly AvailableModel[] = models): { model?: string; error?: string } {
  if (!request.startsWith("auto:")) {
    const error = validateModel(request, budget, models, now, registered);
    return error ? { error } : { model: request };
  }
  const category = request.slice(5) as Category;
  if (!categories.includes(category)) return { error: `Unknown auto category: ${category}` };
  let order: Pool[] = category === "agentic" || category === "critical" ? ["gpt"] :
    budget.preference === "gpt" ? ["gpt", "glm", "deepseek"] : budget.preference === "deepseek" ? ["deepseek", "glm", "gpt"] : ["glm", "gpt", "deepseek"];
  if (order.length > 1 && budget.accounts.gpt.status === "constrained") order = [...order.filter(p => p !== "gpt"), "gpt"];
  const reasons: string[] = [];
  for (const pool of order) {
    const ref = candidates[pool][category];
    if (!ref) continue;
    const error = validateModel(ref, budget, models, now, registered);
    if (!error) return { model: ref };
    reasons.push(error);
  }
  return { error: `No eligible ${category} model: ${reasons.join("; ")}` };
}
function summary(b: Budget, now: number): string {
  return `preference=${b.preference}; ` + pools.map(p => `${p}=${effective(b.accounts[p], now)}`).join("; ");
}

/** Install opt-in routing for new Agent calls using only the supplied expert directory. */
export function setupExpertModelRouting(pi: ExtensionAPI, expertBaseDir: string): void {
  const dir = join(expertBaseDir, "_shared");
  const file = join(dir, "model-budget.json");
  const rulesFile = join(dir, "MODEL-ROUTING.md");
  if (!existsSync(file)) return;
  const active = () => pi.getActiveTools().includes("Agent");
  const load = () => parseBudget(readFileSync(file, "utf8"));
  const rules = () => readFileSync(rulesFile, "utf8");
  const available = (ctx: { modelRegistry: { getAvailable(): unknown[] } }) => ctx.modelRegistry.getAvailable() as AvailableModel[];
  const registered = (ctx: { modelRegistry: { getAll(): unknown[] } }) => ctx.modelRegistry.getAll() as AvailableModel[];
  pi.on("before_agent_start", async (event, ctx) => {
    if (!active()) return;
    let block: string;
    try {
      const b = load(), now = Date.now(), models = available(ctx), all = registered(ctx);
      const mapping = categories.map(c => { const r = resolveExpertModel(b, models, `auto:${c}`, now, all); return `${c}=${r.model ?? `BLOCK (${r.error})`}`; }).join("; ");
      block = `${rules()}\n\n${summary(b, now)}\nAuto: ${mapping}\nRouting v2: classify every new Agent call explicitly using auto:extract|research|implement|agentic|critical; missing classification is blocked regardless of role. GPT must be generation 6 or newer. Resume only the same task with description='[continue] ...'; independent mechanical tail work starts a classified utility child, with related updates batched. If auto resolution fails, report the setup fault instead of falling back to Sol. Unknown quota is unconfirmed; reset does not restore availability. Use model_budget only for user-requested changes based on user or authoritative quota evidence.`;
    } catch {
      block = "Expert model routing configuration is missing or invalid. New Agent calls are blocked until repaired.";
    }
    const options = (event as unknown as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions;
    if (options?.sections) { options.sections.expert_model_routing = block; return; }
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "Agent" || !active()) return;
    const input = event.input as Record<string, unknown>;
    const resuming = typeof input.resume === "string" && input.resume.trim().length > 0;
    if (resuming) {
      if (input.model !== undefined) return { block: true, reason: "model is not permitted when resuming an Agent" };
      if (typeof input.description !== "string" || !input.description.startsWith("[continue] ")) return { block: true, reason: "Resume retains the original model. Use description='[continue] ...' only for the same task's follow-up; independent extraction, issue updates or summaries need a new classified Agent (batch related tail work)." };
      return;
    }
    try {
      const b = load(); rules();
      const request = input.model;
      if (request === undefined || request === "auto" || (typeof request === "string" && !request.trim())) return { block: true, reason: "Classify this task explicitly with model='auto:extract|research|implement|agentic|critical' (choose one), or supply an eligible concrete provider/model:level for an explicit override. Role-based defaults and parent-model inheritance are disabled." };
      if (typeof request !== "string") return { block: true, reason: "Invalid Agent model" };
      const result = resolveExpertModel(b, available(ctx), request, Date.now(), registered(ctx));
      if (!result.model) return { block: true, reason: result.error };
      input.model = result.model;
    } catch { return { block: true, reason: "Expert routing configuration missing or invalid; repair it before starting an Agent" }; }
  });
  const nullableDate = Type.Optional(Type.Union([Type.String(), Type.Null()]));
  pi.registerTool({
    name: "model_budget", label: "Model budget",
    description: "Inspect budget or update preference/account only at the user's request, based on the user or authoritative quota evidence. account requires a short source note.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "prefer", "account"] }),
      preference: Type.Optional(Type.String({ enum: preferences })), pool: Type.Optional(Type.String({ enum: pools })),
      status: Type.Optional(Type.String({ enum: statuses })), note: Type.Optional(Type.String()),
      nextResetAt: nullableDate, expiresAt: nullableDate, plan: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const result = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) });
      if (!active()) return result("model_budget requires an active Agent tool", true);
      if (params.action === "status") {
        try { return result(`routing=v2; classification=required; resume=[continue]; GPT>=6; ${summary(load(), Date.now())}`); } catch { return result("Expert routing configuration missing or invalid", true); }
      }
      if (params.action !== "prefer" && params.action !== "account") return result("Invalid action", true);
      if (params.action === "prefer" && !preferences.includes(params.preference as Preference)) return result("Invalid preference", true);
      if (params.action === "account" && (!pools.includes(params.pool as Pool) || !statuses.includes(params.status as Status) || typeof params.note !== "string" || !params.note.trim() || params.note.length > 300)) return result("account requires pool, status, and a short source note", true);
      for (const v of [params.nextResetAt, params.expiresAt]) if (v !== undefined && v !== null && !validDate(v)) return result("Dates require a valid timestamp with timezone", true);
      const lock = `${file}.lock`, temp = `${file}.${randomUUID()}.tmp`;
      let fd: number;
      try { fd = openSync(lock, "wx", 0o600); } catch (e) { return result((e as NodeJS.ErrnoException).code === "EEXIST" ? "Budget busy; retry later" : "Cannot acquire budget lock", true); }
      let ownsTemp = false;
      try {
        const b = load();
        if (params.action === "prefer") b.preference = params.preference as Preference;
        else {
          const a = b.accounts[params.pool as Pool];
          a.status = params.status as Status; a.note = params.note!.trim(); a.updatedAt = new Date().toISOString();
          if (params.nextResetAt !== undefined) a.nextResetAt = params.nextResetAt;
          if (params.expiresAt !== undefined) a.expiresAt = params.expiresAt;
          if (params.plan !== undefined) a.plan = params.plan;
        }
        const out = `${JSON.stringify(b, null, 2)}\n`;
        parseBudget(out);
        const tempFd = openSync(temp, "wx", 0o600); ownsTemp = true;
        try { writeFileSync(tempFd, out); } finally { closeSync(tempFd); }
        renameSync(temp, file); ownsTemp = false;
        return result(summary(b, Date.now()));
      } catch { return result("Could not update budget; configuration missing or invalid", true); }
      finally { if (ownsTemp) { try { unlinkSync(temp); } catch {} } closeSync(fd); try { unlinkSync(lock); } catch {} }
    },
  });
}
