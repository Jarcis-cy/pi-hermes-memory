import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseManager } from "./db.js";
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
}

export type ConcretionCandidateAction = "add" | "reinforce" | "refine" | "conflict" | "none";

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
  conflicts: number;
  ignored: number;
  concretedEvents: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function cleanNullable(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
      source_session_id, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export function searchMemoryEvents(
  dbManager: DatabaseManager,
  query: string,
  options: { project?: string | null; scope?: EventScope; kind?: EventKind; source?: EventSource; limit?: number } = {},
): MemoryEvent[] {
  const normalized = normalizeFts5Query(query);
  if (!normalized) return [];
  const db = dbManager.getDb();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  let parseError = false;

  const run = (matchQuery: string): MemoryEvent[] => {
    const conditions = ["e.id IN (SELECT rowid FROM event_fts WHERE event_fts MATCH ?)"];
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
    try {
      const rows = db.prepare(`
        SELECT e.*
        FROM memory_events e
        WHERE ${conditions.join(" AND ")}
        ORDER BY e.occurred_at DESC, e.id DESC
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

  const supersedesIds = [...new Set(input.supersedesIds ?? [])];
  if (activePrinciplePayloadChars(db, { scope: input.scope, project, content, supersedesIds }) > charLimit) {
    return { overCapacity: true };
  }

  if (supersedesIds.length) {
    const placeholders = supersedesIds.map(() => "?").join(", ");
    db.prepare(`UPDATE principles SET status = 'superseded', updated_at = ? WHERE status = 'active' AND id IN (${placeholders})`)
      .run(nowIso(), ...supersedesIds);
  }
  const stamp = nowIso();
  const inserted = db.prepare(`
    INSERT INTO principles (scope, project, content, rationale, status, supersedes_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(input.scope, project, content, rationale, supersedesIds[0] ?? null, stamp, stamp) as { lastInsertRowid: number | bigint };
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
    conflicts: 0,
    ignored: 0,
    concretedEvents: 0,
  };

  const apply = () => {
    if (candidates.length === 0) {
      for (const eventId of eventIds) consumedEventIds.add(eventId);
    }
    for (const candidate of candidates) {
      const sourceEventIds = [...new Set(candidate.sourceEventIds)];
      if (!sourceEventIds.length || sourceEventIds.some((id) => !eventIds.has(id))) {
        throw new Error("Concretion candidate cited a missing or out-of-batch source event.");
      }
      if (candidate.action === "none") {
        for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
        result.ignored++;
        continue;
      }
      const existingIds = [...new Set(candidate.existingPrincipleIds ?? [])];
      if (candidate.action === "reinforce") {
        if (existingIds.length !== 1) {
          throw new Error("Reinforcement must identify exactly one active principle.");
        }
        const principleId = existingIds[0];
        const active = db.prepare(`
          SELECT id, scope, project
          FROM principles
          WHERE id = ? AND status = 'active'
        `).get(principleId) as { id: number; scope: EventScope; project: string | null } | undefined;
        if (!active) {
          throw new Error("Reinforcement referenced a principle that is not active.");
        }
        if (active.scope === "project") {
          const sourceProjects = [...new Set(sourceEventIds.map((id) => eventsById.get(id)?.project ?? null))];
          if (sourceProjects.length !== 1 || sourceProjects[0] !== active.project) {
            throw new Error("Reinforcement mixed source events across project boundaries.");
          }
        }
        linkPrincipleSources(db, principleId, sourceEventIds);
        for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
        result.reinforced++;
        continue;
      }

      const scope = candidate.scope;
      const content = candidate.content?.trim();
      if (!scope || !content || !EVENT_SCOPES.has(scope)) {
        throw new Error("Concretion candidate has an invalid scope or empty content.");
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

      const supersedesIds = candidate.action === "refine" ? relevantExistingIds.slice(0, 1) : [];
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
          reason: `Activating this candidate would exceed the ${options.charLimit}-character principle budget.`,
        });
        result.conflicts++;
      } else if (added.duplicateId) {
        result.reinforced++;
      } else if (candidate.action === "refine") {
        result.refined++;
      } else {
        result.added++;
      }
      for (const eventId of sourceEventIds) consumedEventIds.add(eventId);
    }

    if (candidates.length > 0 && consumedEventIds.size !== eventIds.size) {
      const missing = [...eventIds].filter((id) => !consumedEventIds.has(id));
      throw new Error(`Concretion plan did not classify every event in the batch: ${missing.join(", ")}`);
    }

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
  if (outcome.overCapacity) return { success: false, message: `Decision would exceed the ${charLimit}-character principle budget.` };
  if (outcome.error) return { success: false, message: outcome.error };
  const principleId = outcome.principleId ?? outcome.duplicateId;
  return { success: true, message: `Resolved conflict ${conflictId}.`, principleId };
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function renderAdaptivePrinciples(
  dbManager: DatabaseManager,
  project?: string | null,
  includeConflicts = true,
): string {
  const principles = getActivePrinciples(dbManager, project);
  const conflicts = includeConflicts ? getRelevantPendingPrincipleConflicts(dbManager, project, 3) : [];
  const blocks: string[] = [];
  if (principles.length) {
    blocks.push([
      "<adaptive-principles>",
      "These are generalized lessons distilled from prior events. Apply them as fallible",
      "behavioral defaults. Current user instructions and current evidence override them.",
      "Do not claim to remember a source event unless you retrieve it with memory_search.",
      "",
      ...principles.map((principle, index) => `${index + 1}. [P${principle.id}/${principle.scope}] ${principle.content}`),
      "</adaptive-principles>",
    ].join("\n"));
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

export async function writePrinciplesSnapshot(dbManager: DatabaseManager, filePath: string): Promise<void> {
  const principles = getAllActivePrinciples(dbManager);
  const conflicts = getPendingPrincipleConflicts(dbManager, 100);
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
