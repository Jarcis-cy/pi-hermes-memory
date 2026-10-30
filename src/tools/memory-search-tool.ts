import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats, recordSearchHits } from '../store/sqlite-memory-store.js';
import { recordEventHits, searchMemoryEvents, searchPrinciples } from '../store/event-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

function mutationTarget(entry: { target: "memory" | "user" | "failure"; project: string | null }): "memory" | "user" | "failure" | "project" {
  // A project name scopes ordinary memory entries, but project-attributed
  // failures still live in (and must be mutated through) the failure store.
  return entry.target === "memory" && entry.project ? "project" : entry.target;
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : "global";
}

export function registerMemorySearchTool(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  options: { usageTrackingEnabled?: boolean } = {},
): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search persistent memory across the unlimited episodic event ledger and legacy/core memory.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"
- Recall what happened in a prior task: episodic results include event IDs (E#), dates, kinds, and evidence quotes; adaptive principles are already injected when enabled, source events stay searchable here.
- Recall a principle that was NOT injected this run (injection is budgeted): principles matching the query come back labeled [P<id>/<scope>].

target="project" returns only project-attributed memory entries (the ones labeled [target=project]); combine with project to search a named project.

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    promptSnippet: 'Search extended memory store (unlimited capacity)',
    promptGuidelines: [
      'Use memory_search when you need context beyond what is in the system prompt.',
      'Use memory_search to find project-specific memories or user preferences.',
      'Use memory_search with category filter to find specific types of memories (failure, correction, insight, etc.).',
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure', 'project'] as const, { description: 'Filter by target type: memory, user, failure, or project-attributed memories.' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      entity: Type.Optional(Type.String({ description: 'Facet filter: one entity tag (ticket id, repo slug, path) derived from the event ledger, e.g. iar-1839.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: 'memory' | 'user' | 'failure' | 'project'; category?: string; entity?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Math.min(args.limit || 10, 20);

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      const eventStats = dbManager.getStats();
      if (stats.total === 0 && eventStats.events === 0) {
        const result: SearchResult = { success: false, message: 'No persistent memories or episodic events have been recorded yet.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const eventScope = target === 'user'
        ? 'user'
        : target === 'memory'
          ? (project ? 'project' : 'global')
          : undefined;
      const entity = args.entity?.trim() || undefined;
      // Principles are directives, not evidence: they get a small reserved slice
      // of the result budget and are skipped for category/entity filters, which
      // only describe the memory/event stores.
      const principleLimit = category || entity ? 0 : Math.min(3, limit);
      const principles = principleLimit === 0 ? [] : searchPrinciples(dbManager, query, {
        project: project === undefined ? null : project,
        scope: target === 'user' ? 'user' : target === 'failure' ? undefined : target === 'memory' ? (project ? 'project' : 'global') : undefined,
        limit: principleLimit,
      });
      const events = searchMemoryEvents(dbManager, query, {
        project: project === undefined ? undefined : project,
        scope: eventScope,
        ...(category ? { kind: category } : {}),
        ...(entity ? { entity } : {}),
        limit,
      });
      const eventContents = new Set(events.map((event) => event.content));
      const legacyLimit = Math.max(0, limit - events.length - principles.length);
      const legacy = legacyLimit === 0
        ? []
        : searchMemories(dbManager, query, { project, target, category, limit })
          .filter((entry) => !eventContents.has(entry.content))
          .slice(0, legacyLimit);
      const combinedCount = legacy.length + events.length + principles.length;

      if (combinedCount === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      // Usage-hit tracking (the promotion-gate data for consolidation): one
      // batched counter UPDATE per search. Must never break the read path.
      // Records hits for extended-store entries; episodic events carry their
      // own tracking on the event ledger.
      if (options.usageTrackingEnabled !== false && (legacy.length > 0 || events.length > 0)) {
        try {
          if (legacy.length > 0) recordSearchHits(dbManager, legacy.map((entry) => entry.id));
          if (events.length > 0) recordEventHits(dbManager, events.map((event) => event.id));
        } catch (err) {
          console.warn(`[pi-hermes-memory] usage-hit recording failed (search result unaffected): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let output = `Found ${combinedCount} memory result${combinedCount === 1 ? '' : 's'} matching "${query}":\n\n`;

      for (const { principle, score } of principles) {
        const scopeLabel = principle.scope === 'project'
          ? `project:${encodeURIComponent(principle.project ?? '')}`
          : principle.scope;
        output += `📐 P${principle.id} [${scopeLabel}] ${principle.content}\n`;
        output += `   Adaptation principle (generalized default, fallible; current instructions win). match=${score.toFixed(2)}\n\n`;
      }

      for (const event of events) {
        const projectLabel = event.project ? `[${event.project}]` : event.scope === 'user' ? '[user]' : '[global]';
        output += `📚 E${event.id} ${projectLabel} [${event.kind}] ${event.content}\n`;
        output += `   Occurred: ${event.occurredAt} | Source: ${event.source}\n`;
        if (event.evidenceQuote) output += `   Evidence: "${event.evidenceQuote}"\n`;
        output += `\n`;
      }

      for (const entry of legacy) {
        const projectLabel = `scope=${scopeLabel(entry.project)}`;
        const mutationTargetLabel = `[target=${mutationTarget(entry)}]`;
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: combinedCount, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
