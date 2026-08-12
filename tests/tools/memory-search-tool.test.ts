import { afterEach, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from '../../src/store/db.js';
import { addMemory } from '../../src/store/sqlite-memory-store.js';
import { captureMemoryEvents } from '../../src/store/event-memory-store.js';
import { registerMemorySearchTool } from '../../src/tools/memory-search-tool.js';

let ROOT_DIR = '';
let activeDbManager: DatabaseManager | null = null;

afterEach(() => {
  activeDbManager?.close();
  activeDbManager = null;
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = '';
});

function makeDbManager(): DatabaseManager {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-memory-search-tool-test-'));
  activeDbManager = new DatabaseManager(ROOT_DIR);
  return activeDbManager;
}

describe('registerMemorySearchTool', () => {
  it('returns a broader natural-language match when strict term matching misses', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, "user's name is Naruto", 'user');

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;

    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-1', { query: 'name identity Naruto', target: 'user' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);
  });

  it('returns episodic event IDs, dates, sources, and evidence quotes', async () => {
    const dbManager = makeDbManager();
    const capturedEvent = captureMemoryEvents(dbManager, [{
      scope: 'project',
      kind: 'outcome',
      content: 'The PS-SR restoration benchmark completed in 42 minutes.',
      evidenceQuote: 'benchmark completed in 42 minutes',
    }], {
      captureId: 'review-1',
      project: 'material',
      source: 'background-review',
      occurredAt: '2026-07-24T12:00:00.000Z',
    });

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;
    registerMemorySearchTool(mockPi, dbManager);

    const result = await captured.execute('tc-events', { query: 'PS-SR benchmark', project: 'material' });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, new RegExp(`E${capturedEvent.eventIds[0]}`));
    assert.match(result.content[0].text, /2026-07-24T12:00:00.000Z/);
    assert.match(result.content[0].text, /Source: background-review/);
    assert.match(result.content[0].text, /Evidence: "benchmark completed in 42 minutes"/);
  });

  it('deduplicates legacy mirrors and respects the total result limit', async () => {
    const dbManager = makeDbManager();
    addMemory(dbManager, 'shared legacy and event observation', 'memory');
    captureMemoryEvents(dbManager, [{
      scope: 'global',
      kind: 'fact',
      content: 'shared legacy and event observation',
      evidenceQuote: 'shared observation',
    }, {
      scope: 'global',
      kind: 'fact',
      content: 'second searchable observation',
      evidenceQuote: 'second observation',
    }], {
      captureId: 'legacy-import:test',
      source: 'legacy-import',
    });

    let captured: any;
    const mockPi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as any;
    registerMemorySearchTool(mockPi, dbManager);

    const deduplicated = await captured.execute('tc-dedupe', { query: 'shared legacy event', limit: 10 });
    assert.strictEqual(deduplicated.details.success, true);
    assert.strictEqual(deduplicated.details.count, 1);
    assert.strictEqual((deduplicated.content[0].text.match(/shared legacy and event observation/g) ?? []).length, 1);

    const limited = await captured.execute('tc-limit', { query: 'observation', limit: 1 });
    assert.strictEqual(limited.details.success, true);
    assert.strictEqual(limited.details.count, 1);
  });
});
