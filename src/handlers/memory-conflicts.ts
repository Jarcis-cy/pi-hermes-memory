import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PRINCIPLES_FILE } from "../constants.js";
import type { DatabaseManager } from "../store/db.js";
import {
  getAllActivePrinciples,
  getEventById,
  getPendingPrincipleConflicts,
  resolvePrincipleConflict,
  writePrinciplesSnapshot,
  type PrincipleConflict,
} from "../store/event-memory-store.js";
import { tokenSetSimilarity } from "../store/text-similarity.js";

export function formatPrincipleConflicts(
  dbManager: DatabaseManager,
  conflicts: PrincipleConflict[],
): string {
  const principleById = new Map(
    getAllActivePrinciples(dbManager).map((principle) => [principle.id, principle]),
  );
  const lines = ["Pending adaptive-memory conflicts:", ""];

  for (const conflict of conflicts) {
    const project = conflict.candidateProject ? `/${conflict.candidateProject}` : "";
    lines.push(
      `C${conflict.id} candidate [${conflict.candidateScope}${project}]: ${conflict.candidateContent}`,
      `Reason: ${conflict.reason}`,
      "Existing active principle(s):",
    );
    if (conflict.conflictingPrincipleIds.length === 0) {
      lines.push("  (none; this may be a scope, validation, or capacity decision)");
      // Merge-misuse and capacity conflicts carry no opposing ids, which left
      // the human staring at a candidate with no idea what it could merge
      // with or duplicate. Show the lexically nearest active principles so a
      // merge/duplicate decision can be made at a glance.
      const nearest = [...principleById.values()]
        .map((principle) => ({
          principle,
          similarity: tokenSetSimilarity(conflict.candidateContent, principle.content),
        }))
        .filter((entry) => entry.similarity >= 0.3)
        .sort((x, y) => y.similarity - x.similarity)
        .slice(0, 3);
      if (nearest.length) {
        lines.push("Nearest active principle(s):");
        for (const entry of nearest) {
          lines.push(`  P${entry.principle.id} (${entry.similarity.toFixed(2)}): ${entry.principle.content.slice(0, 100)}`);
        }
      }
    } else {
      for (const id of conflict.conflictingPrincipleIds) {
        const principle = principleById.get(id);
        lines.push(`  P${id}: ${principle?.content ?? "(principle is no longer active)"}`);
      }
    }
    lines.push("Source event(s):");
    for (const id of conflict.sourceEventIds) {
      const event = getEventById(dbManager, id);
      if (!event) {
        lines.push(`  E${id}: (event unavailable)`);
        continue;
      }
      const eventProject = event.project ? `/${event.project}` : "";
      lines.push(
        `  E${id} [${event.occurredAt}; ${event.kind}; ${event.scope}${eventProject}]: ${event.content}`,
      );
      if (event.evidenceQuote) lines.push(`    Evidence: "${event.evidenceQuote}"`);
    }
    lines.push("");
  }

  lines.push("Resolve: /memory-conflicts <id> accept|existing|both [optional explanation]");
  return lines.join("\n");
}

export function registerMemoryConflictsCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  globalDir: string,
  principleCharLimit: number,
  principleStoreCharLimit: number,
): void {
  pi.registerCommand("memory-conflicts", {
    description: "List or resolve conflicts between adaptive memory principles",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const conflicts = getPendingPrincipleConflicts(dbManager, 50);
        if (!conflicts.length) {
          ctx.ui.notify("No pending adaptive-memory conflicts.", "info");
          return;
        }
        ctx.ui.notify(formatPrincipleConflicts(dbManager, conflicts), "warning");
        return;
      }

      const match = trimmed.match(/^(\d+)\s+(accept|existing|both)(?:\s+(distinct)(?![a-z]))?(?:\s+([\s\S]+))?$/i);
      if (!match) {
        ctx.ui.notify(
          "Usage: /memory-conflicts <id> accept|existing|both [distinct] [optional explanation]\n"
            + "  distinct — keep this candidate even if it reads like a reworded copy of an active principle",
          "error",
        );
        return;
      }
      const conflictId = Number(match[1]);
      const keyword = match[2].toLowerCase();
      const decision = keyword === "accept"
        ? "accept_candidate"
        : keyword === "both"
          ? "keep_both"
          : "keep_existing";
      const result = resolvePrincipleConflict(
        dbManager,
        conflictId,
        decision,
        principleStoreCharLimit,
        match[4],
        { allowRestatement: (match[3] ?? "").toLowerCase() === "distinct" },
      );
      if (!result.success) {
        ctx.ui.notify(result.message, "error");
        return;
      }
      await writePrinciplesSnapshot(dbManager, path.join(globalDir, PRINCIPLES_FILE), principleCharLimit);
      ctx.ui.notify(result.message, "info");
    },
  });
}
