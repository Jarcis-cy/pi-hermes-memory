import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { DatabaseManager } from "./store/db.js";
import { renderAdaptivePrinciples, renderAdaptivePrinciplesFromSnapshot } from "./store/event-memory-store.js";
import type { StandingInstructions } from "./store/standing-instructions.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

/**
 * Standing instructions are appended in *every* mode, including policy-only
 * and policy style "none". That is the whole point of the store: a rule the
 * user pinned must not depend on the model choosing to run memory_search
 * before the action it forbids (#121). They go last so they read as the
 * operative directive rather than as recalled context.
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText"> & { principleCharLimit?: number },
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
  standing: StandingInstructions | null = null,
  forChild = false,
  dbManager: DatabaseManager | null = null,
  principleInjectionEnabled = true,
  principlesDir: string | null = null,
): Promise<string> {
  const standingBlock = standing?.formatForSystemPrompt() ?? "";
  let principleBlock = "";
  if (principleInjectionEnabled && !forChild) {
    if (dbManager) {
      try {
        principleBlock = renderAdaptivePrinciples(dbManager, projectName || null, true, config.principleCharLimit);
      } catch {
        // Persistent-memory availability must not block an otherwise healthy agent run.
      }
    } else if (principlesDir) {
      // Lazy sessions render from the file snapshot so generic conversation
      // never opens SQLite just to build the prompt.
      try {
        principleBlock = await renderAdaptivePrinciplesFromSnapshot(principlesDir, projectName || null);
      } catch {
        // Snapshot is best-effort; absence just means no principles this run.
      }
    }
  }

  if (config.memoryMode === "policy-only") {
    // Children run with only the memory write tools, so the policy would advertise
    // tools they cannot call (memory_search, session_search, skill_manage).
    // Principles target the main agent's behavior; children get standing only.
    if (forChild) return standingBlock;
    return [resolveMemoryPolicyPrompt(config), principleBlock, standingBlock].filter(Boolean).join("\n\n");
  }

  // Legacy blocks are memory data, not policy, so children keep them.
  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);
  if (principleBlock) parts.push(principleBlock);
  if (standingBlock) parts.push(standingBlock);

  return parts.join("\n\n");
}
