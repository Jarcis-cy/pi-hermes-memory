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
/** STATE.md soft cap in lines; the charter tells the expert to self-distill
 * when approaching it (decisions→DECISIONS.md, evidence→refs/, cross-project
 * lessons→CRAFT.md, maybes→one pointer line) — nothing is dropped without a
 * trace, so no user decision is required. */
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
    "> 本文件是身份底座，在此目录工作的会话每轮自动加载它。",
    "",
    "## 记忆分两层",
    "- **手艺（CRAFT.md，本目录）**：跨项目的经验蒸馏，到哪儿都带着。",
    "- **项目层（projects/<本项目>/）**：本项目名 = 当前工作目录名。开工先读",
    "  `projects/<本项目>/STATE.md`——不存在就初始化一套（STATE/LOG/DECISIONS/refs）。",
    "  换了项目目录，自动用另一套，绝不混。",
    "",
    "## 三条铁律",
    "1. 开工先读本项目 STATE.md（当前状态，一页）。",
    "2. 收工更新本项目 `STATE.md`，往本项目 `LOG.md` 追加一行（日期 + 做了什么 + 结论）；",
    "   其中可跨项目复用的经验，另起一行记入 `CRAFT.md`（标注来源项目）。",
    `3. 本项目 \`STATE.md\` 接近 ${STATE_SOFT_CAP_LINES} 行时自行蒸馏收页，不问用户：决策结论入 \`DECISIONS.md\`、细节依据入 \`refs/\`、`,
    `   跨项目经验入 \`CRAFT.md\`、仍有效的旧现状并入「当前基线」，拿不准去留的压成一行进「指针区」——`,
    "   一律不无痕删除，蒸馏后往 `LOG.md` 记一行去向。",
    "",
    "## 工作方式",
    "- 汇报：大白话中文，先结论；用户追问再展开细节。",
    "- 细节与依据在本项目 `refs/`、本项目 `LOG.md`，以及群记忆（memory_search 可检索）。",
    "- 本项目的决策类结论写进本项目 `DECISIONS.md`，每条带来源。",
    "",
  ].join("\n");
}

function projectStateTemplate(name: string): string {
  return [
    `# ${name} 当前状态`,
    "",
    `（首次收工时更新；保持一页以内——接近 ${STATE_SOFT_CAP_LINES} 行按铁律 3 自行蒸馏收页）`,
    "",
    "## 现状",
    "- 尚无记录",
    "",
    "## 指针区（被挤出的内容在这里留一行去向）",
    "- （空）",
    "",
    "## 当前基线（长期事实与待办候选；蒸馏后仍有效的旧现状并入这里）",
    "- （空）",
    "",
  ].join("\n");
}

function agentDefinition(name: string, description: string, expertDir: string): string {
  // The Chinese display name is the description's leading segment before the
  // first colon ("存储治理：..."), quoted so multi-line values can never
  // break the YAML frontmatter (observed: an unquoted wrapped description
  // silently killed display_name parsing).
  const display = description.split(/[：:]/)[0]!.trim().slice(0, 24) || name;
  return [
    "---",
    `display_name: "${display.replace(/"/g, "")}"`,
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
  if (writeFileIfMissing(path.join(expertDir, "CRAFT.md"), `# ${name} 手艺（跨项目经验，蒸馏自各项目；每条一行并标注来源项目）\n\n`)) created.push("CRAFT.md");
  if (writeFileIfMissing(path.join(expertDir, "projects", ".gitkeep"), "")) created.push("projects/");
  if (writeFileIfMissing(agentPath, agentDefinition(name, description, expertDir))) created.push("agents 定义");
  return {
    ok: true,
    message: `专家 ${name} 已就绪：目录 ${expertDir}（${created.join("、")}），Agent 定义 ${agentPath}。任意会话可按名派它；在其目录启动会话即成为它。`,
    expertDir,
    agentPath,
  };
}


/** Per-project memory set under projects/<name>/; created on demand by the
 * expert itself (charter rule) or via this helper. Never mixes projects. */
export function ensureProjectZone(expertDir: string, projectName: string, expertName: string): string {
  const zone = path.join(expertDir, "projects", projectName);
  writeFileIfMissing(path.join(zone, "STATE.md"), projectStateTemplate(expertName));
  writeFileIfMissing(path.join(zone, "LOG.md"), `# ${projectName} 流水账（追加式，一条一行：日期 + 做了什么 + 结论）\n\n`);
  writeFileIfMissing(path.join(zone, "DECISIONS.md"), `# ${projectName} 决策记录（带来源）\n\n`);
  writeFileIfMissing(path.join(zone, "refs", ".gitkeep"), "");
  return zone;
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
    const dir = path.join(paths.expertBaseDir, name);
    const projectsDir = path.join(dir, "projects");
    const projects = fs.existsSync(projectsDir)
      ? fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [];
    const craft = fs.existsSync(path.join(dir, "CRAFT.md"))
      ? fs.readFileSync(path.join(dir, "CRAFT.md"), "utf-8").split("\n").filter((l) => l.startsWith("- ")).length
      : 0;
    lines.push(`  · ${name}（手艺 ${craft} 条 · 项目层：${projects.length ? projects.join("、") : "（未开张）"}）`);
  }
  return lines.join("\n");
}

export function expertStatus(paths: ExpertPaths, name: string): string {
  if (!NAME_PATTERN.test(name)) return `无效名字 "${name}"。`;
  const expertDir = path.join(paths.expertBaseDir, name);
  if (!fs.existsSync(path.join(expertDir, "AGENTS.md"))) {
    return `没有专家 ${name}（目录不存在）。`;
  }
  const lines = [`专家 ${name}`, `  目录: ${expertDir}`];
  const craftPath = path.join(expertDir, "CRAFT.md");
  if (fs.existsSync(craftPath)) {
    const craft = fs.readFileSync(craftPath, "utf-8").split("\n").filter((l) => l.startsWith("- ")).length;
    lines.push(`  手艺（跨项目）: ${craft} 条`);
  }
  const projectsDir = path.join(expertDir, "projects");
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (projects.length) {
      lines.push("  项目层:");
      for (const project of projects) {
        const zone = path.join(projectsDir, project.name);
        const stateLines = fs.existsSync(path.join(zone, "STATE.md"))
          ? fs.readFileSync(path.join(zone, "STATE.md"), "utf-8").split("\n").length : 0;
        const fill = Math.min(100, Math.round((stateLines / STATE_SOFT_CAP_LINES) * 100));
        lines.push(`    · ${project.name}（STATE ${fill}%${fill >= 90 ? " ⚠️ 接近上限" : ""}）`);
      }
    }
  }
  const legacyState = path.join(expertDir, "STATE.md");
  if (fs.existsSync(legacyState)) lines.push(`  （旧单层布局：根 STATE.md ${fs.readFileSync(legacyState, "utf-8").split("\n").length} 行）`);
  const agentPath = path.join(paths.agentsDir, `${name}.md`);
  lines.push(`  Agent 定义: ${fs.existsSync(agentPath) ? `已就绪（${agentPath}）` : `缺失（${agentPath}）`}`);
  return lines.join("\n");
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
