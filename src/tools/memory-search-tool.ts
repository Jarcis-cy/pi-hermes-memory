import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import { searchMemoryEvents } from '../store/event-memory-store.js';
import type { MemoryCategory } from '../types.js';
import { createSharedToolResultRenderer } from './shared-output-view.js';
import { searchResultView } from './tool-result-views.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: `Search persistent memory across the unlimited episodic event ledger and legacy/core memory.

Use this when you need to recall what happened in a prior task, find the source of a correction or lesson, or retrieve durable user/project context. Episodic results include event IDs, dates, kinds, and evidence quotes. Adaptive principles are already injected when enabled; source events remain searchable here.`,
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
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type (memory, user, or failure).' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Number({ description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: string; category?: string; limit?: number }) => {
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
      const events = category
        ? searchMemoryEvents(dbManager, query, {
          project: project === undefined ? undefined : project,
          scope: eventScope,
          kind: category,
          limit,
        })
        : searchMemoryEvents(dbManager, query, {
          project: project === undefined ? undefined : project,
          scope: eventScope,
          limit,
        });
      const eventContents = new Set(events.map((event) => event.content));
      const legacyLimit = Math.max(0, limit - events.length);
      const legacy = legacyLimit === 0
        ? []
        : searchMemories(dbManager, query, { project, target, category, limit })
          .filter((entry) => !eventContents.has(entry.content))
          .slice(0, legacyLimit);
      const combinedCount = legacy.length + events.length;

      if (combinedCount === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${combinedCount} memory result${combinedCount === 1 ? '' : 's'} matching "${query}":\n\n`;

      for (const event of events) {
        const projectLabel = event.project ? `[${event.project}]` : event.scope === 'user' ? '[user]' : '[global]';
        output += `📚 E${event.id} ${projectLabel} [${event.kind}] ${event.content}\n`;
        output += `   Occurred: ${event.occurredAt} | Source: ${event.source}\n`;
        if (event.evidenceQuote) output += `   Evidence: "${event.evidenceQuote}"\n`;
        output += `\n`;
      }

      for (const entry of legacy) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const finalResult: SearchResult = { success: true, count: combinedCount, output: output.trim() };
      return { content: [{ type: 'text' as const, text: output.trim() }], details: finalResult };
    },
  });
}
