import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseManager } from "./db.js";
import { deriveEventEntities } from "./event-entities.js";
import { queryCoverage, tokenSetSimilarity } from "./text-similarity.js";
import { DEFAULT_PRINCIPLE_CHAR_LIMIT } from "../constants.js";

export { deriveEventEntities } from "./event-entities.js";
import {
  buildFallbackFts5Query,
  buildNaturalLanguageFallbackQuery,
  isFts5QueryError,
  normalizeFts5Query,
  normalizeNaturalLanguageFts5Query,
} from "./fts-query.js";
import { scanContent } from "./content-scanner.js";

export type EventScope = "global" | "user" | "project";
export type EventKind =
  | "fact"
  | "preference"
  | "correction"
  | "failure"
  | "decision"
  | "outcome"
  | "insight"
  | "convention"
  | "tool-quirk";
export type EventSource = "background-review" | "correction" | "session-flush" | "legacy-import" | "manual";
export type PrincipleStatus = "active" | "superseded" | "rejected";
export type ConcretionTrigger = "automatic" | "manual" | "migration";

const EVENT_SCOPES = new Set<EventScope>(["global", "user", "project"]);
const EVENT_KINDS = new Set<EventKind>([
  "fact",
  "preference",
  "correction",
  "failure",
  "decision",
  "outcome",
  "insight",
  "convention",
  "tool-quirk",
]);

export interface MemoryEventDraft {
  scope: EventScope;
  kind: EventKind;
  content: string;
  evidenceQuote?: string | null;
  /** Explicit facet tags; when omitted they are derived from the text. */
  entities?: string[];
}

export interface MemoryEvent {
  id: number;
  captureId: string;
  project: string | null;
  scope: EventScope;
  kind: EventKind;
  content: string;
  evidenceQuote: string | null;
  source: EventSource;
  sourceSessionId: string | null;
  occurredAt: string;
  createdAt: string;
  concretedAt: string | null;
  concretionRunId: number | null;
  /** Times memory_search returned this event (recall accounting). */
  hitCount: number;
  /** ISO date of the most recent recall, or null when never recalled. */
  lastHitAt: string | null;
  /** Lowercase facet tags ('|tag1|tag2|' storage split into an array). */
  entities: string[];
}

export interface CaptureEventsOptions {
  captureId?: string;
  project?: string | null;
  source: EventSource;
  sourceSessionId?: string | null;
  occurredAt?: string;
}

export interface CaptureEventsResult {
  captureId: string;
  inserted: number;
  existing: number;
  blocked: number;
  eventIds: number[];
  errors: string[];
}

export interface AdaptivePrinciple {
  id: number;
  scope: EventScope;
  project: string | null;
  content: string;
  rationale: string | null;
  status: PrincipleStatus;
  supersedesId: number | null;
  createdAt: string;
  updatedAt: string;
  sourceEventIds: number[];
  /** Times memory_search returned this principle (cold recall). */
  hitCount: number;
  lastHitAt: string | null;
  /** Review verdicts: how often the run clearly followed / ignored it. */
  appliedCount: number;
  violatedCount: number;
  lastFeedbackAt: string | null;
  /** Pinned principles are felt every run regardless of relevance. */
  pinned: boolean;
}

export type ConcretionCandidateAction = "add" | "reinforce" | "refine" | "merge" | "conflict" | "none";

export interface ConcretionCandidate {
  action: ConcretionCandidateAction;
  scope?: EventScope;
  content?: string;
  rationale?: string;
  sourceEventIds: number[];
  existingPrincipleIds?: number[];
  conflictReason?: string;
}

export interface PrincipleConflict {
  id: number;
  candidateScope: EventScope;
  candidateProject: string | null;
  candidateContent: string;
  candidateRationale: string | null;
  conflictingPrincipleIds: number[];
  sourceEventIds: number[];
  reason: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  acceptedPrincipleId: number | null;
}

export interface ApplyConcretionResult {
  added: number;
  reinforced: number;
  refined: number;
  /** Principles merged into one (the only action that can shrink the store). */
  merged: number;
  conflicts: number;
  ignored: number;
  /** Candidates dropped because the model's plan was not usable for them. */
  skipped: number;
  /** Batch events no candidate classified; they stay pending for the next run. */
  unclassified: number;
  concretedEvents: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanNullable(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseEntityTokens(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split("|").map((token) => token.trim()).filter(Boolean);
}

function serializeEntityTokens(entities: string[]): string | null {
  if (entities.length === 0) return null;
  return `|${entities.join("|")}|`;
}

function mapEventRow(row: Record<string, unknown>): MemoryEvent {
  return {
    id: Number(row.id),
    captureId: String(row.capture_id),
    project: cleanNullable(row.project as string | null),
    scope: row.scope as EventScope,
    kind: row.kind as EventKind,
    content: String(row.content),
    evidenceQuote: cleanNullable(row.evidence_quote as string | null),
    source: row.source as EventSource,
    sourceSessionId: cleanNullable(row.source_session_id as string | null),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
    concretedAt: cleanNullable(row.concreted_at as string | null),
    concretionRunId: row.concretion_run_id == null ? null : Number(row.concretion_run_id),
    hitCount: row.hit_count == null ? 0 : Number(row.hit_count),
    lastHitAt: cleanNullable(row.last_hit_at as string | null),
    entities: parseEntityTokens(row.entities as string | null),
  };
}

function mapPrincipleRow(row: Record<string, unknown>, sourceEventIds: number[] = []): AdaptivePrinciple {
  return {
    id: Number(row.id),
    scope: row.scope as EventScope,
    project: cleanNullable(row.project as string | null),
    content: String(row.content),
    rationale: cleanNullable(row.rationale as string | null),
    status: row.status as PrincipleStatus,
    supersedesId: row.supersedes_id == null ? null : Number(row.supersedes_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    sourceEventIds,
    hitCount: row.hit_count == null ? 0 : Number(row.hit_count),
    lastHitAt: cleanNullable(row.last_hit_at as string | null),
    appliedCount: row.applied_count == null ? 0 : Number(row.applied_count),
    violatedCount: row.violated_count == null ? 0 : Number(row.violated_count),
    lastFeedbackAt: cleanNullable(row.last_feedback_at as string | null),
    pinned: Number(row.pinned ?? 0) === 1,
  };
}

function eventRowById(dbManager: DatabaseManager, id: number): MemoryEvent | null {
  const row = dbManager.getDb().prepare("SELECT * FROM memory_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapEventRow(row) : null;
}

export function captureMemoryEvents(
  dbManager: DatabaseManager,
  drafts: MemoryEventDraft[],
  options: CaptureEventsOptions,
): CaptureEventsResult {
  const db = dbManager.getDb();
  const captureId = options.captureId?.trim() || randomUUID();
  const project = cleanNullable(options.project);
  const sourceSessionId = cleanNullable(options.sourceSessionId);
  const occurredAt = options.occurredAt?.trim() || nowIso();
  const createdAt = nowIso();
  const result: CaptureEventsResult = {
    captureId,
    inserted: 0,
    existing: 0,
    blocked: 0,
    eventIds: [],
    errors: [],
  };

  const insert = db.prepare(`
    INSERT OR IGNORE INTO memory_events (
      capture_id, project, scope, kind, content, evidence_quote, source,
      source_session_id, occurred_at, created_at, entities
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const find = db.prepare(`
    SELECT id
    FROM memory_events
    WHERE IFNULL(source_session_id, capture_id) = ?
      AND kind = ?
      AND scope = ?
      AND IFNULL(project, '') = IFNULL(?, '')
      AND content = ?
    ORDER BY id ASC
    LIMIT 1
  `);

  const write = () => {
    for (const draft of drafts) {
      const content = draft.content?.trim();
      const evidenceQuote = cleanNullable(draft.evidenceQuote);
      if (!EVENT_SCOPES.has(draft.scope) || !EVENT_KINDS.has(draft.kind) || !content) {
        result.blocked++;
        result.errors.push("Skipped an event with an invalid scope, kind, or empty content.");
        continue;
      }
      if (draft.scope === "project" && !project) {
        result.blocked++;
        result.errors.push(`Skipped project event without an active project: ${content.slice(0, 120)}`);
        continue;
      }
      const contentError = scanContent(content);
      const evidenceError = evidenceQuote ? scanContent(evidenceQuote) : null;
      if (contentError || evidenceError) {
        result.blocked++;
        result.errors.push(contentError ?? evidenceError!);
        continue;
      }

      const scopedProject = draft.scope === "project" ? project : null;
      const identity = sourceSessionId ?? captureId;
      const entities = serializeEntityTokens(
        draft.entities?.length ? draft.entities.flatMap((entity) => deriveEventEntities(entity)) : deriveEventEntities(content, evidenceQuote),
      );
      const inserted = insert.run(
        captureId,
        scopedProject,
        draft.scope,
        draft.kind,
        content,
        evidenceQuote,
        options.source,
        sourceSessionId,
        occurredAt,
        createdAt,
        entities,
      ) as { changes: number; lastInsertRowid: number | bigint };

      if (inserted.changes > 0) {
        result.inserted++;
        result.eventIds.push(Number(inserted.lastInsertRowid));
        continue;
      }

      const existing = find.get(identity, draft.kind, draft.scope, scopedProject, content) as { id: number } | undefined;
      if (existing) {
        result.existing++;
        result.eventIds.push(existing.id);
      }
    }
  };

  const transaction = db.transaction?.(write);
  if (transaction) transaction();
  else write();
  result.eventIds = [...new Set(result.eventIds)];
  return result;
}

export function importLegacyMemoriesAsEvents(dbManager: DatabaseManager): CaptureEventsResult {
  const rows = dbManager.getDb().prepare(`
    SELECT id, project, target, category, content, created
    FROM memories
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    project: string | null;
    target: "memory" | "user" | "failure";
    category: string | null;
    content: string;
    created: string;
  }>;
  const total: CaptureEventsResult = {
    captureId: "legacy-import",
    inserted: 0,
    existing: 0,
    blocked: 0,
    eventIds: [],
    errors: [],
  };
  const categoryKinds = new Set<EventKind>([
    "preference", "correction", "failure", "insight", "convention", "tool-quirk",
  ]);
  for (const row of rows) {
    const scope: EventScope = row.project ? "project" : row.target === "user" ? "user" : "global";
    const kind = categoryKinds.has(row.category as EventKind)
      ? row.category as EventKind
      : row.target === "failure" ? "failure" : "fact";
    const digest = createHash("sha256")
      .update(JSON.stringify([scope, row.project, kind, row.content]))
      .digest("hex");
    const captured = captureMemoryEvents(
      dbManager,
      [{ scope, kind, content: row.content }],
      {
        captureId: `legacy-import:${digest}`,
        project: row.project,
        source: "legacy-import",
        occurredAt: row.created,
      },
    );
    total.inserted += captured.inserted;
    total.existing += captured.existing;
    total.blocked += captured.blocked;
    total.eventIds.push(...captured.eventIds);
    total.errors.push(...captured.errors);
  }
  total.eventIds = [...new Set(total.eventIds)];
  return total;
}

export function getMemoryEvents(
  dbManager: DatabaseManager,
  options: {
    project?: string | null;
    source?: EventSource;
    kind?: EventKind;
    pendingOnly?: boolean;
    limit?: number;
  } = {},
): MemoryEvent[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.project !== undefined) {
    if (options.project === null) conditions.push("project IS NULL");
    else {
      conditions.push("project = ?");
      params.push(options.project);
    }
  }
  if (options.source) {
    conditions.push("source = ?");
    params.push(options.source);
  }
  if (options.kind) {
    conditions.push("kind = ?");
    params.push(options.kind);
  }
  if (options.pendingOnly) conditions.push("concreted_at IS NULL");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const rows = dbManager.getDb().prepare(`
    SELECT * FROM memory_events
    ${where}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[];
  return rows.map(mapEventRow);
}

export function getPendingConcretionStats(dbManager: DatabaseManager): {
  events: number;
  backgroundReviewCaptures: number;
} {
  const row = dbManager.getDb().prepare(`
    SELECT
      COUNT(*) AS events,
      COUNT(DISTINCT CASE WHEN source = 'background-review' THEN capture_id END) AS background_review_captures
    FROM memory_events
    WHERE concreted_at IS NULL
  `).get() as { events: number; background_review_captures: number };
  return {
    events: row.events,
    backgroundReviewCaptures: row.background_review_captures,
  };
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Record one recall per returned event (batched). Mirrors the extended-store
 * hit accounting so the episodic ledger gets the same promotion-gate data.
 * Failures must never break the read path; callers swallow errors. */
export function recordEventHits(dbManager: DatabaseManager, ids: number[]): void {
  if (ids.length === 0) return;
  const db = dbManager.getDb();
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE memory_events SET hit_count = hit_count + 1, last_hit_at = ? WHERE id IN (${placeholders})`,
  ).run(todayDate(), ...ids);
}

/** Per-principle recall evidence for concretion: how often the events behind a
 * principle were actually recalled, and when any of them last was. Principles
 * whose evidence is never recalled are weaker keep candidates. */
export interface PrincipleUsageSignal {
  principleId: number;
  sourceEventCount: number;
  totalHits: number;
  lastHitAt: string | null;
}

export function getPrincipleUsageSignals(dbManager: DatabaseManager): Map<number, PrincipleUsageSignal> {
  const principles = getAllActivePrinciples(dbManager);
  const signals = new Map<number, PrincipleUsageSignal>();
  if (principles.length === 0) return signals;
  const db = dbManager.getDb();
  const statement = db.prepare("SELECT hit_count, last_hit_at FROM memory_events WHERE id = ?");
  for (const principle of principles) {
    let totalHits = 0;
    let lastHitAt: string | null = null;
    let sourceEventCount = 0;
    for (const eventId of principle.sourceEventIds) {
      const row = statement.get(eventId) as { hit_count?: unknown; last_hit_at?: unknown } | undefined;
      if (!row) continue;
      sourceEventCount++;
      totalHits += row.hit_count == null ? 0 : Number(row.hit_count);
      const hit = cleanNullable(row.last_hit_at as string | null);
      if (hit && (!lastHitAt || hit > lastHitAt)) lastHitAt = hit;
    }
    signals.set(principle.id, { principleId: principle.id, sourceEventCount, totalHits, lastHitAt });
  }
  return signals;
}

/** Per-hit relevance bonus for episodic ranking. BM25 scores are small
 * negative numbers (more negative = better); subtracting up to 1.0 for
 * frequently recalled events lets usage outrank age WITHOUT ever penalizing
 * old events — a rarely recalled old event keeps its pure BM25 position. */
const EVENT_HIT_BONUS_PER_HIT = 0.02;
/** Bonus ceiling in hits: 50 recalls = full 1.0 bonus, further hits add none. */
const EVENT_HIT_BONUS_MAX_HITS = 50;

export function searchMemoryEvents(
  dbManager: DatabaseManager,
  query: string,
  options: {
    project?: string | null;
    scope?: EventScope;
    kind?: EventKind;
    source?: EventSource;
    /** Facet filter: matches one normalized entity tag (e.g. 'iar-1839'). */
    entity?: string;
    limit?: number;
  } = {},
): MemoryEvent[] {
  const normalized = normalizeFts5Query(query);
  if (!normalized) return [];
  const db = dbManager.getDb();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  let parseError = false;
  const entityTag = options.entity?.trim().toLowerCase() || null;

  const run = (matchQuery: string): MemoryEvent[] => {
    const conditions = ["event_fts MATCH ?"];
    const params: unknown[] = [matchQuery];
    if (options.project !== undefined) {
      if (options.project === null) conditions.push("e.project IS NULL");
      else {
        conditions.push("e.project = ?");
        params.push(options.project);
      }
    }
    if (options.scope) {
      conditions.push("e.scope = ?");
      params.push(options.scope);
    }
    if (options.kind) {
      conditions.push("e.kind = ?");
      params.push(options.kind);
    }
    if (options.source) {
      conditions.push("e.source = ?");
      params.push(options.source);
    }
    if (entityTag) {
      conditions.push("e.entities LIKE ? ESCAPE '\\'");
      params.push(`%|${entityTag.replace(/[\\%_]/g, (ch) => `\\${ch}`)}|%`);
    }
    try {
      // Relevance first: BM25 (lower is better), minus the bounded usage bonus.
      // Age is only the deterministic tiebreaker, never the primary order —
      // an old event that matches the query outranks a newer weaker match.
      const rows = db.prepare(`
        SELECT e.*, bm25(event_fts) AS rank_score
        FROM memory_events e
        JOIN event_fts ON event_fts.rowid = e.id
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank_score - ${EVENT_HIT_BONUS_PER_HIT} * MIN(e.hit_count, ${EVENT_HIT_BONUS_MAX_HITS}) ASC,
                 e.occurred_at DESC, e.id DESC
        LIMIT ?
      `).all(...params, limit) as Record<string, unknown>[];
      return rows.map(mapEventRow);
    } catch (error) {
      if (isFts5QueryError(error)) {
        parseError = true;
        return [];
      }
      throw error;
    }
  };

  const exact = run(normalized);
  if (exact.length) return exact;
  if (parseError) {
    const natural = normalizeNaturalLanguageFts5Query(query);
    if (!natural || natural === normalized) return [];
    const results = run(natural);
    if (results.length) return results;
    const fallback = buildNaturalLanguageFallbackQuery(query);
    return fallback && fallback !== natural ? run(fallback) : results;
  }
  const fallback = buildFallbackFts5Query(query);
  return fallback && fallback !== normalized ? run(fallback) : exact;
}

function sourceIdsForPrinciples(dbManager: DatabaseManager, principleIds: number[]): Map<number, number[]> {
  const result = new Map<number, number[]>();
  if (!principleIds.length) return result;
  const placeholders = principleIds.map(() => "?").join(", ");
  const rows = dbManager.getDb().prepare(`
    SELECT principle_id, event_id
    FROM principle_sources
    WHERE principle_id IN (${placeholders})
    ORDER BY event_id ASC
  `).all(...principleIds) as Array<{ principle_id: number; event_id: number }>;
  for (const row of rows) {
    const ids = result.get(row.principle_id) ?? [];
    ids.push(row.event_id);
    result.set(row.principle_id, ids);
  }
  return result;
}

export function getActivePrinciples(dbManager: DatabaseManager, project?: string | null): AdaptivePrinciple[] {
  const params: unknown[] = [];
  let scopeClause = "scope IN ('global', 'user')";
  if (project?.trim()) {
    scopeClause = `(scope IN ('global', 'user') OR (scope = 'project' AND project = ?))`;
    params.push(project.trim());
  }
  const rows = dbManager.getDb().prepare(`
    SELECT * FROM principles
    WHERE status = 'active' AND ${scopeClause}
    ORDER BY CASE scope WHEN 'user' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, id ASC
  `).all(...params) as Record<string, unknown>[];
  const sources = sourceIdsForPrinciples(dbManager, rows.map((row) => Number(row.id)));
  return rows.map((row) => mapPrincipleRow(row, sources.get(Number(row.id)) ?? []));
}

/**
 * Lexical recall over the active principle layer.
 *
 * Principles are normally injected; this is the cold path that keeps a principle
 * reachable after it falls out of the injection budget (or when the run simply
 * cannot feel it). Lexical coverage, not BM25, because the layer is small
 * (hundreds at most) and has no FTS index — a full scan over the scoped view is
 * cheaper than a migration and keeps this deterministic.
 *
 * Contract: returns active principles of the requested scope only (global+user,
 * or one project), ranked by query coverage then recency; an empty/whitespace
 * query yields nothing (a blank query is not a recall cue).
 */
export function searchPrinciples(
  dbManager: DatabaseManager,
  query: string,
  options: { project?: string | null; scope?: EventScope; limit?: number } = {},
): Array<{ principle: AdaptivePrinciple; score: number }> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 5, 20));
  const project = options.project ?? null;
  const candidates = options.scope === "user"
    ? getActivePrinciples(dbManager, null).filter((principle) => principle.scope === "user")
    : options.scope === "project"
      ? getActivePrinciples(dbManager, project).filter((principle) => principle.scope === "project" && principle.project === project)
      : options.scope === "global"
        ? getActivePrinciples(dbManager, null).filter((principle) => principle.scope === "global")
        : getActivePrinciples(dbManager, project);

  const scored = candidates
    .map((principle) => ({ principle, score: queryCoverage(trimmed, principle.content) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : b.principle.id - a.principle.id));
  return scored.slice(0, limit);
}


export function getAllActivePrinciples(dbManager: DatabaseManager): AdaptivePrinciple[] {
  const rows = dbManager.getDb().prepare(`
    SELECT * FROM principles
    WHERE status = 'active'
    ORDER BY scope ASC, IFNULL(project, '') ASC, id ASC
  `).all() as Record<string, unknown>[];
  const sources = sourceIdsForPrinciples(dbManager, rows.map((row) => Number(row.id)));
  return rows.map((row) => mapPrincipleRow(row, sources.get(Number(row.id)) ?? []));
}

function activePrinciplePayloadChars(db: ReturnType<DatabaseManager["getDb"]>, candidate?: {
  scope: EventScope;
  project: string | null;
  content: string;
  supersedesIds: number[];
}): number {
  const rows = db.prepare(`
    SELECT id, scope, project, content
    FROM principles
    WHERE status = 'active'
  `).all() as Array<{ id: number; scope: EventScope; project: string | null; content: string }>;
  const superseded = new Set(candidate?.supersedesIds ?? []);
  const retained = rows.filter((row) => !superseded.has(row.id));
  if (candidate) retained.push({ id: -1, scope: candidate.scope, project: candidate.project, content: candidate.content });

  const shared = retained
    .filter((row) => row.scope === "global" || row.scope === "user")
    .reduce((sum, row) => sum + row.content.length + 1, 0);
  const byProject = new Map<string, number>();
  for (const row of retained) {
    if (row.scope !== "project" || !row.project) continue;
    byProject.set(row.project, (byProject.get(row.project) ?? 0) + row.content.length + 1);
  }
  return Math.max(shared, ...[...byProject.values()].map((projectChars) => shared + projectChars));
}

function linkPrincipleSources(db: ReturnType<DatabaseManager["getDb"]>, principleId: number, eventIds: number[]): void {
  const insert = db.prepare("INSERT OR IGNORE INTO principle_sources (principle_id, event_id) VALUES (?, ?)");
  for (const eventId of [...new Set(eventIds)]) insert.run(principleId, eventId);
}

function relevantPrincipleIdsForCandidate(
  db: ReturnType<DatabaseManager["getDb"]>,
  ids: number[],
  scope: EventScope,
  project: string | null,
): number[] {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT id, scope, project
    FROM principles
    WHERE status = 'active' AND id IN (${placeholders})
  `).all(...uniqueIds) as Array<{ id: number; scope: EventScope; project: string | null }>;
  const allowed = new Set(rows
    .filter((row) => (
      row.scope === scope
      && (scope !== "project" || cleanNullable(row.project) === cleanNullable(project))
    ))
    .map((row) => row.id));
  return uniqueIds.filter((id) => allowed.has(id));
}

/** Jaccard similarity at or above this is "the same rule stated twice". */
const PRINCIPLE_NEAR_DUPLICATE_THRESHOLD = 0.85;

/** Record one cold recall per principle (batched). Failures never break search. */
export function recordPrincipleHits(dbManager: DatabaseManager, ids: number[]): void {
  if (ids.length === 0) return;
  const db = dbManager.getDb();
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(
    `UPDATE principles SET hit_count = hit_count + 1, last_hit_at = ? WHERE id IN (${placeholders})`,
  ).run(todayDate(), ...ids);
}

/**
 * Record review verdicts about injected principles: a follow counts as a small
 * reinforcement, a violation as a loud one. Both are prehension events, so they
 * stamp last_feedback_at; only violations are loud because ignoring a stated
 * default is the case worth resurfacing.
 */
export function recordPrincipleFeedback(
  dbManager: DatabaseManager,
  feedback: { applied?: number[]; violated?: number[] },
): { applied: number; violated: number } {
  const applied = [...new Set(feedback.applied ?? [])];
  const violated = [...new Set(feedback.violated ?? [])];
  if (applied.length === 0 && violated.length === 0) return { applied: 0, violated: 0 };
  const db = dbManager.getDb();
  const stamp = todayDate();
  const run = (ids: number[], column: "applied_count" | "violated_count") => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const res = db.prepare(
      `UPDATE principles SET ${column} = ${column} + 1, last_feedback_at = ? WHERE id IN (${placeholders}) AND status = 'active'`,
    ).run(stamp, ...ids);
    return Number(res.changes ?? 0);
  };
  const transaction = db.transaction?.(() => ({ applied: run(applied, "applied_count"), violated: run(violated, "violated_count") }));
  const result = transaction ? transaction() : { applied: run(applied, "applied_count"), violated: run(violated, "violated_count") };
  return result;
}

/** Recency half-life for principle strength: an untouched principle halves ~8 weeks. */
const PRINCIPLE_STRENGTH_HALF_LIFE_DAYS = 56;

/**
 * Derived strength in [0, ~3]: 1 base, halved for every idle half-life since the
 * principle was last felt, boosted by recall and follow counts, and boosted
 * harder by recent violations (a stated default that keeps getting ignored is
 * the one worth resurfacing, not the one to bury).
 *
 * Deterministic and pure so ranking stays reproducible; `now` is injectable for
 * tests. Never used to delete anything — strength only orders selection.
 */
export function principleStrength(principle: AdaptivePrinciple, now: Date = new Date()): number {
  const daysSince = (value: string | null): number | null => {
    if (!value) return null;
    const then = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (Number.isNaN(then)) return null;
    return Math.max(0, (now.getTime() - then) / 86_400_000);
  };
  const idle = daysSince(principle.lastHitAt ?? principle.lastFeedbackAt ?? principle.updatedAt) ?? 0;
  const recency = Math.pow(0.5, idle / PRINCIPLE_STRENGTH_HALF_LIFE_DAYS);
  const follow = Math.log1p(Math.max(0, principle.hitCount) + Math.max(0, principle.appliedCount)) / Math.LN2;
  const violationAge = daysSince(principle.lastFeedbackAt) ?? Number.POSITIVE_INFINITY;
  const violationBoost = principle.violatedCount > 0 && violationAge <= 30
    ? Math.min(1.5, 0.5 * principle.violatedCount)
    : 0;
  return Number((recency + follow + violationBoost).toFixed(4));
}

/** Highest-scoring active principle in the same scope that restates `content`. */
function findNearDuplicatePrinciple(
  db: ReturnType<DatabaseManager["getDb"]>,
  input: { scope: EventScope; project: string | null; content: string },
): number | null {
  const rows = db.prepare(`
    SELECT id, content FROM principles
    WHERE status = 'active' AND scope = ? AND IFNULL(project, '') = IFNULL(?, '')
  `).all(input.scope, input.project) as Array<{ id: number; content: string }>;
  let bestId: number | null = null;
  let bestScore = PRINCIPLE_NEAR_DUPLICATE_THRESHOLD;
  for (const row of rows) {
    const score = tokenSetSimilarity(row.content, input.content);
    if (score >= bestScore) {
      bestScore = score;
      bestId = row.id;
    }
  }
  return bestId;
}

function addPrincipleInTransaction(
  db: ReturnType<DatabaseManager["getDb"]>,
  input: {
    scope: EventScope;
    project: string | null;
    content: string;
    rationale: string | null;
    sourceEventIds: number[];
    supersedesIds?: number[];
  },
  charLimit: number,
): { principleId?: number; duplicateId?: number; overCapacity?: boolean; error?: string } {
  const content = input.content.trim();
  const rationale = cleanNullable(input.rationale);
  const project = input.scope === "project" ? cleanNullable(input.project) : null;
  if (!content || !EVENT_SCOPES.has(input.scope) || (input.scope === "project" && !project)) {
    return { error: "Invalid principle scope, project, or empty content." };
  }
  const blocked = scanContent(content) ?? (rationale ? scanContent(rationale) : null);
  if (blocked) return { error: blocked };

  const duplicate = db.prepare(`
    SELECT id FROM principles
    WHERE status = 'active' AND scope = ? AND IFNULL(project, '') = IFNULL(?, '') AND content = ?
    LIMIT 1
  `).get(input.scope, project, content) as { id: number } | undefined;
  if (duplicate) {
    linkPrincipleSources(db, duplicate.id, input.sourceEventIds);
    return { duplicateId: duplicate.id };
  }

  // Encoding gate: a near-identical restatement is not a new occasion — it
  // reinforces the existing trace (same evidence, stronger standing) instead of
  // minting a near-duplicate row. Conservative on purpose: only near-identical
  // wording is absorbed, so genuinely different rules still get their own line.
  const nearDuplicate = findNearDuplicatePrinciple(db, { scope: input.scope, project, content });
  if (nearDuplicate) {
    linkPrincipleSources(db, nearDuplicate, input.sourceEventIds);
    return { duplicateId: nearDuplicate };
  }

  const supersedesIds = [...new Set(input.supersedesIds ?? [])];
  if (activePrinciplePayloadChars(db, { scope: input.scope, project, content, supersedesIds }) > charLimit) {
    return { overCapacity: true };
  }

  // A pinned principle is a user-stated invariant. Refining or merging it must not
  // silently drop it out of the always-injected register: the successor inherits
  // the pin. (Observed live: automatic concretion refined the only pinned safety
  // rule, superseded it, and the causal-efficacy register became empty.)
  let inheritsPin = false;
  if (supersedesIds.length) {
    const placeholders = supersedesIds.map(() => "?").join(", ");
    const pinnedRow = db.prepare(
      `SELECT 1 AS present FROM principles WHERE status = 'active' AND pinned = 1 AND id IN (${placeholders}) LIMIT 1`,
    ).get(...supersedesIds) as { present?: number } | undefined;
    inheritsPin = pinnedRow?.present === 1;
    db.prepare(`UPDATE principles SET status = 'superseded', updated_at = ? WHERE status = 'active' AND id IN (${placeholders})`)
      .run(nowIso(), ...supersedesIds);
  }
  const stamp = nowIso();
  const inserted = db.prepare(`
    INSERT INTO principles (scope, project, content, rationale, status, supersedes_id, created_at, updated_at, pinned)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(input.scope, project, content, rationale, supersedesIds[0] ?? null, stamp, stamp, inheritsPin ? 1 : 0) as { lastInsertRowid: number | bigint };
  const principleId = Number(inserted.lastInsertRowid);
  linkPrincipleSources(db, principleId, input.sourceEventIds);
  return { principleId };
}

function recordConflictInTransaction(
  db: ReturnType<DatabaseManager["getDb"]>,
  input: {
    scope: EventScope;
    project: string | null;
    content: string;
    rationale: string | null;
    conflictingPrincipleIds: number[];
    sourceEventIds: number[];
    reason: string;
  },
): number {
  const idsJson = JSON.stringify([...new Set(input.conflictingPrincipleIds)].sort((a, b) => a - b));
  const sourceJson = JSON.stringify([...new Set(input.sourceEventIds)].sort((a, b) => a - b));
  const existing = db.prepare(`
    SELECT id FROM principle_conflicts
    WHERE status = 'pending'
      AND candidate_scope = ?
      AND IFNULL(candidate_project, '') = IFNULL(?, '')
      AND candidate_content = ?
      AND conflicting_principle_ids = ?
      AND source_event_ids = ?
    LIMIT 1
  `).get(input.scope, input.project, input.content, idsJson, sourceJson) as { id: number } | undefined;
  if (existing) return existing.id;
  const inserted = db.prepare(`
    INSERT INTO principle_conflicts (
      candidate_scope, candidate_project, candidate_content, candidate_rationale,
      conflicting_principle_ids, source_event_ids, reason, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    input.scope,
    input.project,
    input.content,
    input.rationale,
    idsJson,
    sourceJson,
    input.reason,
    nowIso(),
  ) as { lastInsertRowid: number | bigint };
  return Number(inserted.lastInsertRowid);
}

export function startConcretionRun(
  dbManager: DatabaseManager,
  trigger: ConcretionTrigger,
  eventCount: number,
): number {
  const result = dbManager.getDb().prepare(`
    INSERT INTO concretion_runs (trigger, status, started_at, event_count)
    VALUES (?, 'running', ?, ?)
  `).run(trigger, nowIso(), eventCount) as { lastInsertRowid: number | bigint };
  return Number(result.lastInsertRowid);
}

export function failConcretionRun(dbManager: DatabaseManager, runId: number, error: string): void {
  dbManager.getDb().prepare(`
    UPDATE concretion_runs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE id = ? AND status = 'running'
  `).run(nowIso(), error.slice(0, 2000), runId);
}

export function applyConcretionPlan(
  dbManager: DatabaseManager,
  runId: number,
  events: MemoryEvent[],
  candidates: ConcretionCandidate[],
  options: { project?: string | null; charLimit: number },
): ApplyConcretionResult {
  const db = dbManager.getDb();
  const eventIds = new Set(events.map((event) => event.id));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const consumedEventIds = new Set<number>();
  const result: ApplyConcretionResult = {
    added: 0,
    reinforced: 0,
    refined: 0,
    merged: 0,
    conflicts: 0,
    ignored: 0,
    skipped: 0,
    unclassified: 0,
    concretedEvents: 0,
  };

  const apply = () => {
    if (candidates.length === 0) {
      for (const eventId of eventIds) consumedEventIds.add(eventId);
    }
    for (const candidate of candidates) {
      // Model output is imperfect by nature. A candidate that cites nothing usable
      // is dropped, not fatal: its events stay pending and the next run retries
      // them. Failing the whole batch is how distillation silently stopped working.
      const sourceEventIds = [...new Set(candidate.sourceEventIds)].filter((id) => eventIds.has(id));
      if (!sourceEventIds.length) {
        result.skipped++;
        continue;
      }
      if (candidate.action === "none") {
        for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
        result.ignored++;
        continue;
      }
      const existingIds = [...new Set(candidate.existingPrincipleIds ?? [])];
      if (candidate.action === "reinforce") {
        if (existingIds.length !== 1) {
          result.skipped++;
          continue;
        }
        const principleId = existingIds[0];
        const active = db.prepare(`
          SELECT id, scope, project
          FROM principles
          WHERE id = ? AND status = 'active'
        `).get(principleId) as { id: number; scope: EventScope; project: string | null } | undefined;
        if (!active) {
          result.skipped++;
          continue;
        }
        // A project-scoped principle may only be reinforced by evidence from that
        // project. Cross-project sources are dropped rather than failing the run;
        // if none survive, the candidate is skipped.
        const usableSourceIds = active.scope === "project"
          ? sourceEventIds.filter((id) => eventsById.get(id)?.project === active.project)
          : sourceEventIds;
        if (!usableSourceIds.length) {
          result.skipped++;
          continue;
        }
        linkPrincipleSources(db, principleId, usableSourceIds);
        for (const eventId of usableSourceIds) consumedEventIds.add(eventId);
        result.reinforced++;
        continue;
      }

      const scope = candidate.scope;
      const content = candidate.content?.trim();
      if (!scope || !content || !EVENT_SCOPES.has(scope)) {
        result.skipped++;
        continue;
      }
      const sourceProjects = [...new Set(sourceEventIds
        .map((id) => eventsById.get(id)?.project ?? null)
        .filter((project): project is string => Boolean(project)))];
      const project = scope === "project"
        ? (sourceProjects.length === 1 ? sourceProjects[0] : cleanNullable(options.project))
        : null;
      const rationale = cleanNullable(candidate.rationale);
      const blockedCandidate = scanContent(content) ?? (rationale ? scanContent(rationale) : null);
      if (blockedCandidate) {
        throw new Error(blockedCandidate);
      }
      const rawConflictReason = candidate.conflictReason?.trim();
      const safeConflictReason = rawConflictReason && !scanContent(rawConflictReason)
        ? rawConflictReason
        : undefined;
      const relevantExistingIds = relevantPrincipleIdsForCandidate(db, existingIds, scope, project);
      if (scope === "project" && (!project || sourceProjects.length > 1)) {
        recordConflictInTransaction(db, {
          scope,
          project: project ?? null,
          content,
          rationale,
          conflictingPrincipleIds: relevantExistingIds,
          sourceEventIds,
          reason: sourceProjects.length > 1
            ? "Candidate combines events from multiple projects and requires user scoping."
            : "Project-scoped candidate has no authoritative project source.",
        });
        result.conflicts++;
        for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
        continue;
      }
      if (candidate.action === "conflict") {
        recordConflictInTransaction(db, {
          scope,
          project,
          content,
          rationale,
          conflictingPrincipleIds: relevantExistingIds,
          sourceEventIds,
          reason: safeConflictReason || "Candidate conflicts with an active principle.",
        });
        result.conflicts++;
        for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
        continue;
      }

      if (candidate.action === "merge") {
        // A merge must shrink the store: require at least two active principles
        // in this scope and reject silently-dropped ids (a partial merge would
        // supersede principles the model never saw).
        const cited = [...new Set(candidate.existingPrincipleIds ?? [])];
        if (cited.length < 2 || relevantExistingIds.length !== cited.length) {
          recordConflictInTransaction(db, {
            scope,
            project,
            content,
            rationale,
            conflictingPrincipleIds: relevantExistingIds,
            sourceEventIds,
            reason: "Merge did not identify at least two active principles in the same scope.",
          });
          result.conflicts++;
          for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
          continue;
        }
      }

      const supersedesIds = candidate.action === "refine"
        ? relevantExistingIds.slice(0, 1)
        : candidate.action === "merge"
          ? relevantExistingIds
          : [];
      if (candidate.action === "refine") {
        const existing = supersedesIds.length === 1
          ? db.prepare(`
            SELECT id FROM principles
            WHERE id = ? AND status = 'active' AND scope = ? AND IFNULL(project, '') = IFNULL(?, '')
          `).get(supersedesIds[0], scope, project)
          : null;
        if (!existing) {
          recordConflictInTransaction(db, {
            scope,
            project,
            content,
            rationale,
            conflictingPrincipleIds: relevantExistingIds,
            sourceEventIds,
            reason: "Refinement did not identify exactly one active principle in the same scope.",
          });
          result.conflicts++;
          for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
          continue;
        }
      }
      const added = addPrincipleInTransaction(db, {
        scope,
        project,
        content,
        rationale,
        sourceEventIds,
        supersedesIds,
      }, options.charLimit);
      if (added.error) {
        recordConflictInTransaction(db, {
          scope,
          project,
          content,
          rationale,
          conflictingPrincipleIds: relevantExistingIds,
          sourceEventIds,
          reason: `Candidate requires review before activation: ${added.error}`,
        });
        result.conflicts++;
      } else if (added.overCapacity) {
        recordConflictInTransaction(db, {
          scope,
          project,
          content,
          rationale,
          conflictingPrincipleIds: relevantExistingIds,
          sourceEventIds,
          reason: `Activating this candidate would exceed the ${options.charLimit}-character principle budget;`
            + " merge near-duplicate principles with /memory-concretize to make room.",
        });
        result.conflicts++;
      } else if (added.duplicateId) {
        result.reinforced++;
      } else if (candidate.action === "merge") {
        result.merged = (result.merged ?? 0) + 1;
      } else if (candidate.action === "refine") {
        result.refined++;
      } else {
        result.added++;
      }
      for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
    }

    // Unclassified events are not an error: they simply stay pending and are
    // offered again next run. The count is reported so the caller can see when the
    // model is consistently under-classifying.
    const missing = [...eventIds].filter((id) => !consumedEventIds.has(id));
    result.unclassified = missing.length;

    const ids = [...consumedEventIds];
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(", ");
      result.concretedEvents = (db.prepare(`
        UPDATE memory_events
        SET concreted_at = ?, concretion_run_id = ?
        WHERE concreted_at IS NULL AND id IN (${placeholders})
      `).run(nowIso(), runId, ...ids) as { changes: number }).changes;
    }
    db.prepare(`
      UPDATE concretion_runs
      SET status = 'completed', completed_at = ?, principle_count = ?, conflict_count = ?
      WHERE id = ? AND status = 'running'
    `).run(nowIso(), result.added + result.refined, result.conflicts, runId);
  };

  const transaction = db.transaction?.(apply);
  if (transaction) transaction();
  else apply();
  return result;
}

function parseNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0);
}

function mapConflictRow(row: Record<string, unknown>): PrincipleConflict {
  let conflictingPrincipleIds: number[] = [];
  let sourceEventIds: number[] = [];
  try { conflictingPrincipleIds = parseNumberArray(JSON.parse(String(row.conflicting_principle_ids))); } catch {}
  try { sourceEventIds = parseNumberArray(JSON.parse(String(row.source_event_ids))); } catch {}
  return {
    id: Number(row.id),
    candidateScope: row.candidate_scope as EventScope,
    candidateProject: cleanNullable(row.candidate_project as string | null),
    candidateContent: String(row.candidate_content),
    candidateRationale: cleanNullable(row.candidate_rationale as string | null),
    conflictingPrincipleIds,
    sourceEventIds,
    reason: String(row.reason),
    status: row.status as PrincipleConflict["status"],
    createdAt: String(row.created_at),
    resolvedAt: cleanNullable(row.resolved_at as string | null),
    resolution: cleanNullable(row.resolution as string | null),
    acceptedPrincipleId: row.accepted_principle_id == null ? null : Number(row.accepted_principle_id),
  };
}

export function getPendingPrincipleConflicts(dbManager: DatabaseManager, limit = 20): PrincipleConflict[] {
  const rows = dbManager.getDb().prepare(`
    SELECT * FROM principle_conflicts
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT ?
  `).all(Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
  return rows.map(mapConflictRow);
}

export function getRelevantPendingPrincipleConflicts(
  dbManager: DatabaseManager,
  project?: string | null,
  limit = 20,
): PrincipleConflict[] {
  const params: unknown[] = [];
  let scopeClause = "candidate_scope IN ('global', 'user')";
  if (project?.trim()) {
    scopeClause = `(candidate_scope IN ('global', 'user') OR (candidate_scope = 'project' AND candidate_project = ?))`;
    params.push(project.trim());
  }
  const rows = dbManager.getDb().prepare(`
    SELECT * FROM principle_conflicts
    WHERE status = 'pending' AND ${scopeClause}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params, Math.max(1, Math.min(limit, 100))) as Record<string, unknown>[];
  return rows.map(mapConflictRow);
}

export function resolvePrincipleConflict(
  dbManager: DatabaseManager,
  conflictId: number,
  decision: "accept_candidate" | "keep_existing" | "keep_both",
  charLimit: number,
  resolution?: string,
): { success: boolean; message: string; principleId?: number } {
  const db = dbManager.getDb();
  const row = db.prepare("SELECT * FROM principle_conflicts WHERE id = ? AND status = 'pending'").get(conflictId) as Record<string, unknown> | undefined;
  if (!row) return { success: false, message: `Pending conflict ${conflictId} was not found.` };
  const conflict = mapConflictRow(row);
  if (decision === "keep_existing") {
    db.prepare(`
      UPDATE principle_conflicts SET status = 'rejected', resolved_at = ?, resolution = ? WHERE id = ?
    `).run(nowIso(), resolution?.trim() || "User kept the existing principle.", conflictId);
    return { success: true, message: `Rejected candidate from conflict ${conflictId}; existing principles remain active.` };
  }

  let outcome: ReturnType<typeof addPrincipleInTransaction> = {};
  const apply = () => {
    outcome = addPrincipleInTransaction(db, {
      scope: conflict.candidateScope,
      project: conflict.candidateProject,
      content: conflict.candidateContent,
      rationale: conflict.candidateRationale,
      sourceEventIds: conflict.sourceEventIds,
      supersedesIds: decision === "accept_candidate"
        ? relevantPrincipleIdsForCandidate(
          db,
          conflict.conflictingPrincipleIds,
          conflict.candidateScope,
          conflict.candidateProject,
        )
        : [],
    }, charLimit);
    if (!outcome.principleId && !outcome.duplicateId) return;
    const principleId = outcome.principleId ?? outcome.duplicateId!;
    db.prepare(`
      UPDATE principle_conflicts
      SET status = 'accepted', resolved_at = ?, resolution = ?, accepted_principle_id = ?
      WHERE id = ?
    `).run(
      nowIso(),
      resolution?.trim() || (decision === "accept_candidate" ? "User accepted the candidate." : "User kept both principles."),
      principleId,
      conflictId,
    );
  };
  const transaction = db.transaction?.(apply);
  if (transaction) transaction();
  else apply();
  if (outcome.overCapacity) {
    return {
      success: false,
      message: `Activating this decision would exceed the ${charLimit}-character principle budget.`
        + " Run /memory-concretize first: it can merge near-duplicate active principles and free enough budget for this candidate.",
    };
  }
  if (outcome.error) return { success: false, message: outcome.error };
  const principleId = outcome.principleId ?? outcome.duplicateId;
  return { success: true, message: `Resolved conflict ${conflictId}.`, principleId };
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

/** Single source for the omission note: the budget reserve and the rendered
 * note must be the same string, or the block silently overshoots the limit. */
function omissionNote(omitted: number, total: number, charLimit: number): string {
  return `(${omitted} of ${total} active principles are not shown in this run: the ${charLimit}-character budget is full.`
    + " They remain recallable with memory_search; run /memory-concretize to merge near-duplicates,"
    + " or /memory-conflicts to review pending candidates.)";
}

/**
 * Injection is split into three registers, because selection is not one problem:
 *
 * - **A, causal efficacy**: pinned principles (safety, authorization, explicit
 *   user pins). Felt every run regardless of relevance — a prohibition that only
 *   appears when it looks relevant is exactly the one that fails (#121 analogue).
 * - **C, contrast**: active principles violated within the last 30 days. A set
 *   that only surfaces what matches becomes an echo chamber; the ignored default
 *   keeps a guaranteed slice.
 * - **B, competition**: everything else, ranked by strength (use, follow,
 *   violation recency) with scope as tiebreaker. Weak principles fall out of the
 *   prompt but stay recallable through memory_search.
 *
 * Deterministic given the same database state and clock. Nothing is deleted; only
 * the injected selection changes.
 */
export function renderAdaptivePrinciples(
  dbManager: DatabaseManager,
  project?: string | null,
  includeConflicts = true,
  charLimit: number = DEFAULT_PRINCIPLE_CHAR_LIMIT,
): string {
  const principles = getActivePrinciples(dbManager, project);
  const conflicts = includeConflicts ? getRelevantPendingPrincipleConflicts(dbManager, project, 3) : [];
  const blocks: string[] = [];
  if (principles.length) {
    const now = new Date();
    const scopeRank = (principle: AdaptivePrinciple) => (principle.scope === "project" ? 0 : principle.scope === "user" ? 1 : 2);
    const byPreference = (a: AdaptivePrinciple, b: AdaptivePrinciple) => {
      const byScope = scopeRank(a) - scopeRank(b);
      if (byScope !== 0) return byScope;
      const byStrength = principleStrength(b, now) - principleStrength(a, now);
      if (byStrength !== 0) return byStrength;
      return b.id - a.id;
    };
    const pinned = principles.filter((principle) => principle.pinned).sort(byPreference);
    const violated = principles
      .filter((principle) => !principle.pinned && recentlyViolated(principle, now))
      .sort((a, b) => (a.lastFeedbackAt === b.lastFeedbackAt ? b.violatedCount - a.violatedCount : (b.lastFeedbackAt ?? "").localeCompare(a.lastFeedbackAt ?? "")));
    const competing = principles.filter((principle) => !principle.pinned && !violated.includes(principle)).sort(byPreference);

    const header = [
      "<adaptive-principles>",
      "These are generalized lessons distilled from prior events. Apply them as fallible",
      "behavioral defaults. Current user instructions and current evidence override them.",
      "Do not claim to remember a source event unless you retrieve it with memory_search.",
      "",
    ];
    const footer: string[] = [];
    const omissionReserve = omissionNote(principles.length, principles.length, charLimit).length;
    const budget = Math.max(0, charLimit - header.join("\n").length - "</adaptive-principles>".length - omissionReserve);

    // Slice reservations inside the budget: contrast gets a guaranteed share so
    // violations cannot be squeezed out by stronger-sounding defaults. Pinned
    // entries are admitted first and are never dropped for lack of room unless
    // the whole budget is exhausted (they are the safety register).
    const contrastReserve = Math.floor(budget * 0.1);
    const lines: string[] = [];
    const shown = new Set<number>();
    let used = 0;
    const admit = (principle: AdaptivePrinciple, tag: string): boolean => {
      const line = `${lines.length + 1}. [P${principle.id}/${principle.scope}]${tag} ${principle.content}`;
      if (used + line.length + 1 > budget) return false;
      lines.push(line);
      used += line.length + 1;
      shown.add(principle.id);
      return true;
    };

    for (const principle of pinned) {
      if (!admit(principle, " ·pinned")) break;
    }
    const contrastStart = used;
    for (const principle of violated) {
      if (used - contrastStart >= contrastReserve && used - contrastStart > 0) break;
      if (!admit(principle, " ·violated")) break;
    }
    for (const principle of competing) {
      if (!admit(principle, "")) break;
    }

    const omitted = principles.length - shown.size;
    if (omitted > 0) {
      footer.push(omissionNote(omitted, principles.length, charLimit));
    }
    blocks.push([...header, ...lines, ...footer, "</adaptive-principles>"].join("\n"));
  }
  if (conflicts.length) {
    blocks.push([
      "<memory-conflicts>",
      "The candidates below conflict with active adaptive principles and are NOT active.",
      "Ask the user to resolve them; do not choose or silently merge them.",
      "Use /memory-conflicts to show both sides and source-event evidence before deciding.",
      "",
      ...conflicts.map((conflict) => (
        `- Conflict ${conflict.id}: ${truncateForPrompt(conflict.candidateContent, 500)} (reason: ${truncateForPrompt(conflict.reason, 300)})`
      )),
      "</memory-conflicts>",
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

/** A violation keeps the contrast slot for this long before fading into competition. */
const VIOLATION_CONTRAST_DAYS = 30;

function recentlyViolated(principle: AdaptivePrinciple, now: Date): boolean {
  if (principle.violatedCount === 0 || !principle.lastFeedbackAt) return false;
  const then = Date.parse(principle.lastFeedbackAt.length === 10 ? `${principle.lastFeedbackAt}T00:00:00.000Z` : principle.lastFeedbackAt);
  if (Number.isNaN(then)) return false;
  return (now.getTime() - then) / 86_400_000 <= VIOLATION_CONTRAST_DAYS;
}

/** Injection-format snapshot (JSON) written beside PRINCIPLES.md so lazy
 * sessions can render principles without opening SQLite. */
export const PRINCIPLES_INJECTION_FILE = ".principles-injection.json";

interface InjectionPrinciple { id: number; scope: string; project: string | null; content: string; }
interface InjectionConflict { id: number; candidateContent: string; reason: string | null; }

async function writePrinciplesInjectionSnapshot(
  principles: AdaptivePrinciple[],
  conflicts: PrincipleConflict[],
  filePath: string,
  charLimit: number,
): Promise<void> {
  const payload = {
    charLimit,
    principles: principles.map((principle): InjectionPrinciple => ({
      id: principle.id,
      scope: principle.scope,
      project: principle.project ?? null,
      content: principle.content,
    })),
    conflicts: conflicts.slice(0, 3).map((conflict): InjectionConflict => ({
      id: conflict.id,
      candidateContent: truncateForPrompt(conflict.candidateContent, 500),
      reason: conflict.reason ? truncateForPrompt(conflict.reason, 300) : null,
    })),
  };
  try {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
    await fs.rename(tmp, filePath);
  } catch {
    // Snapshot is an optimization for lazy sessions; failure is non-fatal.
  }
}

/** Render the same adaptive-principles / memory-conflicts prompt blocks as
 * renderAdaptivePrinciples, but from the file snapshot (no SQLite open). */
export async function renderAdaptivePrinciplesFromSnapshot(
  dir: string,
  project?: string | null,
): Promise<string> {
  let payload: { charLimit?: number; principles?: InjectionPrinciple[]; conflicts?: InjectionConflict[] };
  try {
    payload = JSON.parse(await fs.readFile(path.join(dir, PRINCIPLES_INJECTION_FILE), "utf8")) as typeof payload;
  } catch {
    return "";
  }
  const scoped = (payload.principles ?? []).filter((principle) =>
    principle.scope === "global"
    || principle.scope === "user"
    || (principle.scope === "project" && project != null && principle.project === project),
  );
  const blocks: string[] = [];
  if (scoped.length) {
    const limit = payload.charLimit ?? DEFAULT_PRINCIPLE_CHAR_LIMIT;
    const header = [
      "<adaptive-principles>",
      "These are generalized lessons distilled from prior events. Apply them as fallible",
      "behavioral defaults. Current user instructions and current evidence override them.",
      "Do not claim to remember a source event unless you retrieve it with memory_search.",
      "",
    ];
    const footer: string[] = [];
    const omissionReserve = omissionNote(scoped.length, scoped.length, limit).length;
    const budget = Math.max(0, limit - header.join("\n").length - "</adaptive-principles>".length - omissionReserve);
    const lines: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const [index, principle] of scoped.entries()) {
      const line = `${index + 1}. [P${principle.id}/${principle.scope}] ${principle.content}`;
      if (used + line.length + 1 > budget) {
        omitted = scoped.length - index;
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    if (omitted > 0) {
      footer.push(omissionNote(omitted, scoped.length, limit));
    }
    blocks.push([...header, ...lines, ...footer, "</adaptive-principles>"].join("\n"));
  }
  const conflicts = payload.conflicts ?? [];
  if (conflicts.length) {
    blocks.push([
      "<memory-conflicts>",
      "The candidates below conflict with active adaptive principles and are NOT active.",
      "Ask the user to resolve them; do not choose or silently merge them.",
      "Use /memory-conflicts to show both sides and source-event evidence before deciding.",
      "",
      ...conflicts.map((conflict) => `- Conflict ${conflict.id}: ${conflict.candidateContent} (reason: ${conflict.reason ?? "unspecified"})`),
      "</memory-conflicts>",
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

export async function writePrinciplesSnapshot(
  dbManager: DatabaseManager,
  filePath: string,
  charLimit: number = DEFAULT_PRINCIPLE_CHAR_LIMIT,
): Promise<void> {
  const principles = getAllActivePrinciples(dbManager);
  const conflicts = getPendingPrincipleConflicts(dbManager, 100);
  await writePrinciplesInjectionSnapshot(principles, conflicts, path.join(path.dirname(filePath), PRINCIPLES_INJECTION_FILE), charLimit);
  const lines = [
    "# Adaptive Principles",
    "",
    "This file is generated from the SQLite principle ledger. Edit principles through the",
    "memory conflict workflow so provenance and history remain intact.",
    "",
  ];
  const groups = new Map<string, AdaptivePrinciple[]>();
  for (const principle of principles) {
    const key = principle.scope === "project" ? `Project: ${principle.project}` : principle.scope === "user" ? "User" : "Global";
    const list = groups.get(key) ?? [];
    list.push(principle);
    groups.set(key, list);
  }
  for (const [group, entries] of groups) {
    lines.push(`## ${group}`, "");
    for (const principle of entries) {
      lines.push(`- [P${principle.id}] ${principle.content}`);
      if (principle.rationale) lines.push(`  - Rationale: ${principle.rationale}`);
      lines.push(`  - Sources: ${principle.sourceEventIds.map((id) => `E${id}`).join(", ") || "none"}`);
    }
    lines.push("");
  }
  if (conflicts.length) {
    lines.push("## Pending Conflicts", "");
    for (const conflict of conflicts) {
      lines.push(`- [C${conflict.id}] ${conflict.candidateContent}`);
      lines.push(`  - Reason: ${conflict.reason}`);
      lines.push(`  - Existing: ${conflict.conflictingPrincipleIds.map((id) => `P${id}`).join(", ") || "none"}`);
      lines.push(`  - Sources: ${conflict.sourceEventIds.map((id) => `E${id}`).join(", ")}`);
    }
    lines.push("");
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(path.dirname(filePath), ".tmp-principles-"));
  const tempPath = path.join(tempDir, "snapshot.tmp");
  try {
    await fs.writeFile(tempPath, `${lines.join("\n").trim()}\n`, "utf-8");
    try {
      await fs.rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function getEventById(dbManager: DatabaseManager, id: number): MemoryEvent | null {
  return eventRowById(dbManager, id);
}
