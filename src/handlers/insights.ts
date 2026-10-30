/**
 * Insights command — /memory-insights shows what's stored in persistent memory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { getMemoryUsageSignals, type MemoryUsageSignal } from "../store/sqlite-memory-store.js";
import { resolveProjectName, resolveProjectStore, type ProjectNameRef, type ProjectStoreRef } from "../project-context.js";

/** Entries shown in the usage section's top-recalled list. */
const USAGE_TOP_ENTRIES = 5;
/** Character cap for entry excerpts in the usage section. */
const USAGE_EXCERPT_CHARS = 70;

interface UsageScopeStats {
  total: number;
  tracked: number;
  top: Array<{ content: string; signal: MemoryUsageSignal }>;
}

function usageExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > USAGE_EXCERPT_CHARS
    ? `${flat.slice(0, USAGE_EXCERPT_CHARS - 3)}...`
    : flat;
}

/**
 * Recall stats for one store scope. Fail-open: a null dbManager or any lookup
 * error renders the insights command without the usage section.
 */
function usageScopeStats(dbManager: DatabaseManager | null, target: "memory" | "user" | "failure", project: string | null): UsageScopeStats | null {
  if (!dbManager) return null;
  try {
    const signals = getMemoryUsageSignals(dbManager, { target, project });
    const total = (dbManager.getDb().prepare(
      "SELECT COUNT(*) as count FROM memories WHERE target = ? AND project IS ?",
    ).get(target, project) as { count: number | bigint }).count;
    const top = [...signals.entries()]
      .sort((a, b) => b[1].hits - a[1].hits)
      .slice(0, USAGE_TOP_ENTRIES)
      .map(([content, signal]) => ({ content, signal }));
    const numTotal = typeof total === "bigint" ? Number(total) : total;
    return { total: numTotal, tracked: signals.size, top };
  } catch {
    return null;
  }
}

function renderUsageScope(label: string, stats: UsageScopeStats | null): string[] {
  if (!stats || stats.total === 0) return [];
  const lines = [`  🔍 USAGE — ${label}: ${stats.tracked} of ${stats.total} entries recalled via memory_search`];
  if (stats.top.length === 0) {
    lines.push("  (no recorded recalls yet — usage accrues as memory_search runs)");
  } else {
    stats.top.forEach((entry, i) => {
      lines.push(`  ${i + 1}. ${entry.signal.hits}x (last ${entry.signal.lastHit}) — ${usageExcerpt(entry.content)}`);
    });
  }
  return lines;
}

/** Event-ledger recall stats: how much of the episodic history is actually
 * being consulted, and which events carry the load. Fail-open like the rest. */
interface EventUsageStats {
  total: number;
  tracked: number;
  top: Array<{ content: string; hits: number; lastHit: string | null }>;
}

function eventUsageStats(dbManager: DatabaseManager | null): EventUsageStats | null {
  if (!dbManager) return null;
  try {
    const db = dbManager.getDb();
    const total = (db.prepare("SELECT COUNT(*) AS count FROM memory_events").get() as { count: number | bigint }).count;
    const rows = db.prepare(
      "SELECT content, hit_count, last_hit_at FROM memory_events WHERE hit_count > 0 ORDER BY hit_count DESC, id DESC LIMIT ?",
    ).all(USAGE_TOP_ENTRIES) as Array<{ content: string; hit_count: number | bigint; last_hit_at: string | null }>;
    const tracked = (db.prepare("SELECT COUNT(*) AS count FROM memory_events WHERE hit_count > 0").get() as { count: number | bigint }).count;
    return {
      total: typeof total === "bigint" ? Number(total) : total,
      tracked: typeof tracked === "bigint" ? Number(tracked) : tracked,
      top: rows.map((row) => ({
        content: String(row.content),
        hits: typeof row.hit_count === "bigint" ? Number(row.hit_count) : Number(row.hit_count ?? 0),
        lastHit: row.last_hit_at ?? null,
      })),
    };
  } catch {
    return null;
  }
}

function renderEventUsage(stats: EventUsageStats | null): string[] {
  if (!stats || stats.total === 0) return [];
  const lines = [`  📚 EPISODIC LEDGER — ${stats.tracked} of ${stats.total} events recalled via memory_search`];
  if (stats.top.length === 0) {
    lines.push("  (no recorded recalls yet — usage accrues as memory_search runs)");
  } else {
    stats.top.forEach((entry, i) => {
      lines.push(`  ${i + 1}. ${entry.hits}x (last ${entry.lastHit ?? "unknown"}) — ${usageExcerpt(entry.content)}`);
    });
  }
  return lines;
}

/** Concretion health: the distillation loop ran silently and mostly failed for a
 * long time, so its success rate belongs in plain sight next to the store sizes. */
interface ConcretionHealth {
  total: number;
  failed: number;
  lastFailureAt: string | null;
  lastFailure: string | null;
  pendingEvents: number;
}

function concretionHealth(dbManager: DatabaseManager | null): ConcretionHealth | null {
  if (!dbManager) return null;
  try {
    const db = dbManager.getDb();
    const total = (db.prepare("SELECT COUNT(*) AS c FROM concretion_runs").get() as { c: number | bigint }).c;
    const failed = (db.prepare("SELECT COUNT(*) AS c FROM concretion_runs WHERE status = 'failed'").get() as { c: number | bigint }).c;
    const last = db.prepare(
      "SELECT started_at, error FROM concretion_runs WHERE status = 'failed' ORDER BY id DESC LIMIT 1",
    ).get() as { started_at: string; error: string | null } | undefined;
    const pendingEvents = (db.prepare("SELECT COUNT(*) AS c FROM memory_events WHERE concreted_at IS NULL").get() as { c: number | bigint }).c;
    const num = (value: number | bigint) => (typeof value === "bigint" ? Number(value) : value);
    return {
      total: num(total),
      failed: num(failed),
      lastFailureAt: last?.started_at ?? null,
      lastFailure: last?.error ?? null,
      pendingEvents: num(pendingEvents),
    };
  } catch {
    return null;
  }
}

function renderConcretionHealth(stats: ConcretionHealth | null): string[] {
  if (!stats || stats.total === 0) return [];
  const rate = Math.round((stats.failed / Math.max(1, stats.total)) * 100);
  const lines = [
    `  🧪 CONCRETION — ${stats.total - stats.failed}/${stats.total} runs completed (${rate}% failed) · ${stats.pendingEvents} events pending distillation`,
  ];
  if (stats.failed > 0 && stats.lastFailure) {
    lines.push(`  last failure (${(stats.lastFailureAt ?? "").slice(0, 10)}): ${usageExcerpt(stats.lastFailure)}`);
  }
  return lines;
}

export function registerInsightsCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: ProjectStoreRef,
  projectName: ProjectNameRef,
  dbManager: DatabaseManager | null = null,
): void {
  pi.registerCommand("memory-insights", {
    description: "Show what's stored in persistent memory",
    handler: async (_args, ctx) => {
      const memoryEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();
      const activeProjectStore = resolveProjectStore(projectStore);
      const activeProjectName = resolveProjectName(projectName);
      const projectEntries = activeProjectStore ? activeProjectStore.getMemoryEntries() : null;

      const lines: string[] = [];
      lines.push("");
      lines.push("  ╔══════════════════════════════════════════════╗");
      lines.push("  ║            🧠 Memory Insights                ║");
      lines.push("  ╚══════════════════════════════════════════════╝");
      lines.push("");

      // Memory section
      lines.push("  📋 MEMORY (your personal notes)");
      lines.push("  " + "─".repeat(44));
      if (memoryEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < memoryEntries.length; i++) {
          const preview =
            memoryEntries[i].length > 100
              ? memoryEntries[i].slice(0, 100) + "..."
              : memoryEntries[i];
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      // User section
      lines.push("  👤 USER PROFILE");
      lines.push("  " + "─".repeat(44));
      if (userEntries.length === 0) {
        lines.push("  (empty)");
      } else {
        for (let i = 0; i < userEntries.length; i++) {
          const preview =
            userEntries[i].length > 100
              ? userEntries[i].slice(0, 100) + "..."
              : userEntries[i];
          lines.push(`  ${i + 1}. ${preview}`);
        }
      }
      lines.push("");

      if (projectEntries !== null) {
        lines.push(`  📁 PROJECT MEMORY: ${activeProjectName ?? ""}`);
        lines.push("  " + "─".repeat(44));
        if (projectEntries.length === 0) {
          lines.push("  (empty)");
        } else {
          for (let i = 0; i < projectEntries.length; i++) {
            const preview =
              projectEntries[i].length > 100
                ? projectEntries[i].slice(0, 100) + "..."
                : projectEntries[i];
            lines.push(`  ${i + 1}. ${preview}`);
          }
        }
        lines.push("");
      }

      // Usage section (promotion-gate data: which entries actually get recalled)
      const usageLines = [
        ...renderUsageScope("global memory", usageScopeStats(dbManager, "memory", null)),
        ...renderUsageScope(
          `project:${activeProjectName ?? ""}`,
          activeProjectStore && activeProjectName ? usageScopeStats(dbManager, "memory", activeProjectName) : null,
        ),
      ];
      if (usageLines.length > 0) {
        lines.push(...usageLines);
        lines.push("");
      }

      const concretionLines = renderConcretionHealth(concretionHealth(dbManager));
      if (concretionLines.length > 0) {
        lines.push(...concretionLines);
        lines.push("");
      }

      const eventLines = renderEventUsage(eventUsageStats(dbManager));
      if (eventLines.length > 0) {
        lines.push(...eventLines);
        lines.push("");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
