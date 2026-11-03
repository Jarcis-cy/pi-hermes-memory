/**
 * /expert — scaffold a domain expert on demand ("拉一个 XX 专家进来").
 *
 * An expert is the domain-memory profile from 领域记忆实例.md: a working
 * directory whose AGENTS.md is the identity charter (auto-loaded by pi when a
 * session runs there), STATE/LOG/DECISIONS as the human-readable memory files,
 * and a pi agent definition so any session can dispatch it BY NAME (pi's agent
 * directory IS the expert registry — no separate index).
 *
 * Lookup-first contract: `create` refuses when the agent definition already
 * exists (the steward should dispatch the existing expert instead of breeding
 * near-duplicates), and repairs the expert directory when it is missing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DatabaseManager } from "../store/db.js";
import { captureMemoryEvents } from "../store/event-memory-store.js";

/** Expert names double as directory names and Matrix @-handles: keep them
 * flat, lowercase, and free of path syntax so no scaffold can escape base. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** STATE.md soft cap in lines; the charter tells the expert to surface to the
 * user when approaching it instead of silently dropping content. */
export const STATE_SOFT_CAP_LINES = 80;

export interface ExpertPaths {
  expertBaseDir: string;
  agentsDir: string;
}

export function expertPathsFor(root: string, configExpertBaseDir?: string): ExpertPaths {
  return {
    expertBaseDir: configExpertBaseDir ?? path.join(root, "experts"),
    agentsDir: path.join(root, "agents"),
  };
}

function charter(name: string, description: string): string {
  return [
    `# ${name} 专家`,
    "",
    `> 领域：${description}`,
    "> 本文件是你的身份底座，在此目录工作的会话每轮自动加载它。",
    "",
    "## 三条铁律",
    "1. 开工先读 `STATE.md`（当前状态，一页）。",
    "2. 收工更新 `STATE.md`，并往 `LOG.md` 追加一行（日期 + 做了什么 + 结论）。",
    `3. \`STATE.md\` 接近 ${STATE_SOFT_CAP_LINES} 行时，提醒用户决策哪些内容合并或淘汰——不自行丢弃。`,
    "",
    "## 工作方式",
    "- 汇报：大白话中文，先结论；用户追问再展开细节。",
    "- 细节与依据在 `refs/`、`LOG.md`，以及群记忆（memory_search 可检索本领域沉淀）。",
    "- 决策类结论写进 `DECISIONS.md`，每条带来源（LOG 日期或任务编号）。",
    "",
    "## 记忆文件",
    "| 文件 | 作用 |",
    "|---|---|",
    "| `STATE.md` | 当前状态，每次必读，收工更新 |",
    "| `LOG.md` | 流水账，只追加，永不注入 |",
    "| `DECISIONS.md` | 蒸馏出的决策与理由，带来源 |",
    "| `refs/` | 详细报告与数据，按需读 |",
    "",
  ].join("\n");
}

function stateTemplate(name: string): string {
  return [
    `# ${name} 当前状态`,
    "",
    "（首次收工时更新；保持一页以内）",
    "",
    "## 现状",
    "- 尚无记录",
    "",
    "## 指针区（被挤出的内容在这里留一行去向）",
    "- （空）",
    "",
  ].join("\n");
}

function agentDefinition(name: string, description: string, expertDir: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}（领域专家，工作目录 ${expertDir}）`,
    "tools: read, grep, find, ls, bash",
    "---",
    "",
    `你是「${name}」领域专家。身份与规则见工作目录的 AGENTS.md；开工先读 STATE.md。`,
    "",
  ].join("\n");
}

function writeFileIfMissing(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return true;
}

export interface CreateExpertResult {
  ok: boolean;
  message: string;
  expertDir?: string;
  agentPath?: string;
}

/**
 * Scaffold one expert. Contract: never overwrites an existing file; refuses
 * when the agent name is taken (lookup-first) or the name is unsafe. Touches
 * nothing outside expertBaseDir / agentsDir.
 */
export function createExpert(paths: ExpertPaths, name: string, description: string): CreateExpertResult {
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message: `无效名字 "${name}"：小写字母/数字/连字符，≤40 字符。`,
    };
  }
  const expertDir = path.join(paths.expertBaseDir, name);
  const agentPath = path.join(paths.agentsDir, `${name}.md`);
  if (fs.existsSync(agentPath)) {
    const hasDir = fs.existsSync(path.join(expertDir, "AGENTS.md"));
    return {
      ok: false,
      message: hasDir
        ? `专家 ${name} 已存在（目录 ${expertDir}），直接使用即可，不要重复创建。`
        : `Agent 名 ${name} 已被占用（${agentPath}），但它没有专家目录——若要按专家补齐目录请换名或先处理该 Agent。`,
    };
  }
  const created: string[] = [];
  if (writeFileIfMissing(path.join(expertDir, "AGENTS.md"), charter(name, description))) created.push("AGENTS.md");
  if (writeFileIfMissing(path.join(expertDir, "STATE.md"), stateTemplate(name))) created.push("STATE.md");
  if (writeFileIfMissing(path.join(expertDir, "LOG.md"), `# ${name} 流水账（追加式，一条一行：日期 + 做了什么 + 结论）\n\n`)) created.push("LOG.md");
  if (writeFileIfMissing(path.join(expertDir, "DECISIONS.md"), `# ${name} 决策记录（蒸馏自 LOG；每条带来源）\n\n`)) created.push("DECISIONS.md");
  if (writeFileIfMissing(path.join(expertDir, "refs", ".gitkeep"), "")) created.push("refs/");
  if (writeFileIfMissing(agentPath, agentDefinition(name, description, expertDir))) created.push("agents 定义");
  return {
    ok: true,
    message: `专家 ${name} 已就绪：目录 ${expertDir}（${created.join("、")}），Agent 定义 ${agentPath}。任意会话可按名派它；在其目录启动会话即成为它。`,
    expertDir,
    agentPath,
  };
}

export function listExperts(paths: ExpertPaths): string {
  if (!fs.existsSync(paths.expertBaseDir)) return "（尚无专家；用 /expert create <名> <领域描述> 创建）";
  const entries = fs.readdirSync(paths.expertBaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(paths.expertBaseDir, name, "AGENTS.md")))
    .sort();
  if (!entries.length) return "（尚无专家）";
  const lines = ["已就绪的领域专家："];
  for (const name of entries) {
    const statePath = path.join(paths.expertBaseDir, name, "STATE.md");
    const stateLines = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf-8").split("\n").length : 0;
    const fill = Math.min(100, Math.round((stateLines / STATE_SOFT_CAP_LINES) * 100));
    lines.push(`  · ${name}（STATE ${fill}%${fill >= 90 ? " ⚠️ 接近上限" : ""}）`);
  }
  return lines.join("\n");
}

export function expertStatus(paths: ExpertPaths, name: string): string {
  if (!NAME_PATTERN.test(name)) return `无效名字 "${name}"。`;
  const expertDir = path.join(paths.expertBaseDir, name);
  if (!fs.existsSync(path.join(expertDir, "AGENTS.md"))) {
    return `没有专家 ${name}（目录不存在）。`;
  }
  const describe = (file: string): string => {
    const filePath = path.join(expertDir, file);
    if (!fs.existsSync(filePath)) return `${file}: 缺失`;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").length;
    return `${file}: ${lines} 行`;
  };
  const agentPath = path.join(paths.agentsDir, `${name}.md`);
  return [
    `专家 ${name}`,
    `  目录: ${expertDir}`,
    `  ${describe("STATE.md")} · ${describe("LOG.md")} · ${describe("DECISIONS.md")}`,
    `  Agent 定义: ${fs.existsSync(agentPath) ? `已就绪（${agentPath}）` : `缺失（${agentPath}）`}`,
    `  记忆作用域: 本目录（会话在此目录工作即绑定此域；上层自动继承全局与用户域）`,
  ].join("\n");
}

export function registerExpertCommand(
  pi: ExtensionAPI,
  paths: ExpertPaths,
  dbManager: DatabaseManager | null,
): void {
  pi.registerCommand("expert", {
    description: "Create or inspect domain experts (scaffold charter + memory files + agent definition)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const createMatch = trimmed.match(/^create\s+([a-z0-9][a-z0-9-]{0,39})\s+([\s\S]+)$/i);
      if (createMatch) {
        const name = createMatch[1]!.toLowerCase();
        const description = createMatch[2]!.trim().replace(/\s+/g, " ");
        const result = createExpert(paths, name, description);
        if (result.ok && dbManager) {
          // 记录在案: expert creation is an auditable decision, not chat noise.
          try {
            captureMemoryEvents(dbManager, [{
              scope: "global",
              kind: "decision",
              content: `创建领域专家 ${name}：${description}。目录 ${result.expertDir}，Agent 定义 ${result.agentPath}。`,
              evidenceQuote: trimmed,
            }], { source: "manual" });
          } catch {
            // audit is best-effort; never block the scaffold on it
          }
        }
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
        return;
      }
      const statusMatch = trimmed.match(/^status\s+([a-z0-9][a-z0-9-]{0,39})$/i);
      if (statusMatch) {
        ctx.ui.notify(expertStatus(paths, statusMatch[1]!.toLowerCase()), "info");
        return;
      }
      if (/^list$/i.test(trimmed)) {
        ctx.ui.notify(listExperts(paths), "info");
        return;
      }
      ctx.ui.notify([
        "用法：",
        "  /expert create <名> <领域描述>   创建专家（查无此人时才建；重名会拒绝）",
        "  /expert list                    列出已有专家（含 STATE 占用）",
        "  /expert status <名>             查看单个专家的记忆文件状态",
      ].join("\n"), trimmed ? "warning" : "info");
    },
  });
}
