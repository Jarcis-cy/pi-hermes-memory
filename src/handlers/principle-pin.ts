/**
 * /memory-principle-pin — the only writer of the causal-efficacy register.
 *
 * A pinned principle is injected in every run regardless of relevance. That is a
 * strong power (it can push real content out of the budget), so it is user-only:
 * the concretion loop, review, and consolidation have no path to set `pinned`.
 * Keeping it a slash command makes model self-promotion structurally impossible
 * rather than merely forbidden by prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DatabaseManager } from "../store/db.js";
import { getActivePrinciples, type AdaptivePrinciple } from "../store/event-memory-store.js";

const USAGE = [
  "  /memory-principle-pin               list pinned principles",
  "  /memory-principle-pin <id>          pin one (id as shown in [P<id>/<scope>])",
  "  /memory-principle-pin remove <id>   unpin one",
].join("\n");

function excerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 96 ? `${flat.slice(0, 93)}...` : flat;
}

function renderList(principles: AdaptivePrinciple[]): string[] {
  const pinned = principles.filter((principle) => principle.pinned);
  const lines = [
    "",
    "  ╔══════════════════════════════════════════════╗",
    "  ║     📌 Pinned Principles (always injected)    ║",
    "  ╚══════════════════════════════════════════════╝",
    "",
  ];
  if (pinned.length === 0) {
    lines.push("  (none pinned — every principle competes for the budget)");
  } else {
    for (const principle of pinned) {
      const scope = principle.scope === "project" ? `project:${principle.project ?? ""}` : principle.scope;
      lines.push(`  · [P${principle.id}/${scope}] ${excerpt(principle.content)}`);
    }
  }
  lines.push("", USAGE, "");
  return lines;
}

export function registerPrinciplePinCommand(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  projectName: () => string | null,
): void {
  pi.registerCommand("memory-principle-pin", {
    description: "Pin an adaptive principle so it is injected every run (safety/authorization invariants)",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const view = () => getActivePrinciples(dbManager, projectName());
      const fail = (message: string) => {
        ctx.ui.notify(message, "warning");
      };

      if (tokens.length === 0) {
        ctx.ui.notify(renderList(view()).join("\n"), "info");
        return;
      }

      const removing = tokens[0] === "remove";
      const idToken = removing ? tokens[1] : tokens[0];
      const id = Number(idToken);
      if (!Number.isSafeInteger(id) || id <= 0) {
        fail(`Expected a principle id.\n\n${USAGE}`);
        return;
      }
      const target = view().find((principle) => principle.id === id);
      if (!target) {
        fail(`P${id} is not an active principle in this view. Run /memory-insights or memory_search to find the id.`);
        return;
      }
      dbManager.getDb()
        .prepare("UPDATE principles SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'")
        .run(removing ? 0 : 1, new Date().toISOString(), id);
      ctx.ui.notify(
        `${removing ? "Unpinned" : "Pinned"} [P${id}]: ${excerpt(target.content)}\n`
          + (removing
            ? "It now competes for the budget like every other principle."
            : "It is now injected in every run, even when it does not look relevant."),
        "info",
      );
    },
  });
}
