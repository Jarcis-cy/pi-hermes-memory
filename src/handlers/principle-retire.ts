/**
 * /memory-principle-retire — the only chain-safe way to retire a principle.
 *
 * Retiring is destructive in a subtle way: a refined/merged successor is the only
 * living carrier of the principles it replaced, so retiring it strands them as
 * `superseded` with nothing active carrying the rule. That happened in a live
 * maintenance session (a merge's echo was retired and six real principles silently
 * left the injection set). This command makes the safe behaviour the default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/db.js";
import { findOrphanedLineage, getActivePrinciples, retirePrinciple } from "../store/event-memory-store.js";

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
}

function lineageReport(dbManager: DatabaseManager): string[] {
  const orphans = findOrphanedLineage(dbManager);
  if (orphans.length === 0) return ["  Lineage: no orphaned chains."];
  const lines = [`  Lineage: ${orphans.length} orphaned predecessor(s) — their only carrier was retired`];
  for (const orphan of orphans.slice(0, 10)) {
    const carriers = orphan.retiredSuccessors.map((id) => `P${id}`).join(", ");
    lines.push(`    P${orphan.predecessorId} ← retired carrier(s) ${carriers}`);
  }
  return lines;
}

export function registerPrincipleRetireCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  projectName: () => string | null,
): void {
  pi.registerCommand("memory-principle-retire", {
    description: "Retire an adaptive principle, restoring any predecessors it was the last carrier of",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const view = getActivePrinciples(dbManager, projectName());
        const lines = [
          "",
          "  ╔══════════════════════════════════════════════════╗",
          "  ║        🗑️  Retire / Lineage Health                ║",
          "  ╚══════════════════════════════════════════════════╝",
          "",
          ...lineageReport(dbManager),
          "",
          `  Active principles: ${view.length}`,
          "",
          "  Usage: /memory-principle-retire <id> [reason]",
          "",
        ];
        ctx.ui.notify(lines.join("\n"), findOrphanedLineage(dbManager).length ? "warning" : "info");
        return;
      }

      const [idToken, ...rest] = trimmed.split(/\s+/);
      const id = Number(idToken);
      if (!Number.isSafeInteger(id) || id <= 0) {
        ctx.ui.notify("Usage: /memory-principle-retire <id> [reason]", "error");
        return;
      }
      const target = getActivePrinciples(dbManager, projectName()).find((principle) => principle.id === id)
        ?? getActivePrinciples(dbManager).find((principle) => principle.id === id);
      const result = retirePrinciple(dbManager, id, rest.join(" ") || "Retired by user.");
      if (result.error) {
        ctx.ui.notify(result.error, "error");
        return;
      }
      const restoredNote = result.restored.length
        ? `\nRestored ${result.restored.length} predecessor(s) this row was the last carrier of: ${result.restored.map((pid) => `P${pid}`).join(", ")}.`
        : "";
      ctx.ui.notify(
        `Retired [P${id}]${target ? `: ${excerpt(target.content)}` : ""}.${restoredNote}\n`
          + "Nothing was deleted; the row stays as rejected history.",
        result.restored.length ? "warning" : "info",
      );
    },
  });
}
