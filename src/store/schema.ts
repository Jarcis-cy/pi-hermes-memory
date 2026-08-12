/**
 * SQLite schema for pi-hermes-memory v0.4
 *
 * Tables:
 * - sessions — Pi session metadata
 * - session_files — indexed JSONL metadata for incremental backfill
 * - messages — all conversation messages
 * - message_fts — FTS5 index for full-text search across messages
 * - memories — legacy/core memory entries (searchable)
 * - memory_fts — FTS5 index for memory search
 * - memory_events — append-only episodic memory (unlimited, searchable)
 * - event_fts — FTS5 index for event search
 * - concretion_runs — event-to-principle processing ledger
 * - principles — accepted adaptive principles and their history
 * - principle_sources — provenance links from principles to events
 * - principle_conflicts — candidates that require user resolution
 */

export const SCHEMA_SQL = `
  -- Extension key/value metadata
  CREATE TABLE IF NOT EXISTS extension_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Session metadata
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    cwd TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    message_count INTEGER DEFAULT 0
  );

  -- Indexed session file metadata for cheap incremental backfill
  CREATE TABLE IF NOT EXISTS session_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  -- All messages from all sessions
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    tool_calls TEXT
  );

  -- FTS5 index for full-text search across messages
  -- content='messages' + content_rowid='rowid' keeps FTS in sync with the content table
  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid'
  );

  -- Triggers to keep message_fts in sync with messages table
  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO message_fts(message_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO message_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Extended memory entries (beyond MEMORY.md limit)
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
    category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
    content TEXT NOT NULL,
    failure_reason TEXT,
    tool_state TEXT,
    corrected_to TEXT,
    created DATE NOT NULL,
    last_referenced DATE NOT NULL
  );

  -- FTS5 index for memory search
  -- content='memories' + content_rowid='id' keeps FTS in sync
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  );

  -- Triggers to keep memory_fts in sync with memories table
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;

  -- Every periodic reflection is recorded, including runs that produce no
  -- principles. This is the audit boundary between episodic memory and
  -- adaptive behavior.
  CREATE TABLE IF NOT EXISTS concretion_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual', 'migration')),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    principle_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  -- Append-only episodic memory. There is deliberately no character limit and
  -- no automatic delete path. A capture may contain several independently
  -- searchable events.
  CREATE TABLE IF NOT EXISTS memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL,
    project TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'user', 'project')),
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'correction', 'failure', 'decision', 'outcome', 'insight', 'convention', 'tool-quirk')),
    content TEXT NOT NULL,
    evidence_quote TEXT,
    source TEXT NOT NULL CHECK (source IN ('background-review', 'correction', 'session-flush', 'legacy-import', 'manual')),
    source_session_id TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    concreted_at TEXT,
    concretion_run_id INTEGER REFERENCES concretion_runs(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_events_capture_identity
    ON memory_events(IFNULL(source_session_id, capture_id), kind, scope, IFNULL(project, ''), content);

  CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
    content,
    evidence_quote,
    content='memory_events',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS memory_events_ai AFTER INSERT ON memory_events BEGIN
    INSERT INTO event_fts(rowid, content, evidence_quote)
    VALUES (new.id, new.content, COALESCE(new.evidence_quote, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS memory_events_ad AFTER DELETE ON memory_events BEGIN
    INSERT INTO event_fts(event_fts, rowid, content, evidence_quote)
    VALUES ('delete', old.id, old.content, COALESCE(old.evidence_quote, ''));
  END;

  CREATE TRIGGER IF NOT EXISTS memory_events_au AFTER UPDATE ON memory_events BEGIN
    INSERT INTO event_fts(event_fts, rowid, content, evidence_quote)
    VALUES ('delete', old.id, old.content, COALESCE(old.evidence_quote, ''));
    INSERT INTO event_fts(rowid, content, evidence_quote)
    VALUES (new.id, new.content, COALESCE(new.evidence_quote, ''));
  END;

  -- Principles are versioned instead of overwritten. Only active rows are
  -- injected; superseded and rejected rows remain as decision history.
  CREATE TABLE IF NOT EXISTS principles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL CHECK (scope IN ('global', 'user', 'project')),
    project TEXT,
    content TEXT NOT NULL,
    rationale TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
    supersedes_id INTEGER REFERENCES principles(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS principle_sources (
    principle_id INTEGER NOT NULL REFERENCES principles(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES memory_events(id),
    PRIMARY KEY (principle_id, event_id)
  );

  -- Semantic conflicts and capacity decisions are never resolved silently.
  CREATE TABLE IF NOT EXISTS principle_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_scope TEXT NOT NULL CHECK (candidate_scope IN ('global', 'user', 'project')),
    candidate_project TEXT,
    candidate_content TEXT NOT NULL,
    candidate_rationale TEXT,
    conflicting_principle_ids TEXT NOT NULL,
    source_event_ids TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT,
    accepted_principle_id INTEGER REFERENCES principles(id)
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_session_files_session_id ON session_files(session_id);
  CREATE INDEX IF NOT EXISTS idx_memory_events_project ON memory_events(project);
  CREATE INDEX IF NOT EXISTS idx_memory_events_kind ON memory_events(kind);
  CREATE INDEX IF NOT EXISTS idx_memory_events_source ON memory_events(source);
  CREATE INDEX IF NOT EXISTS idx_memory_events_pending ON memory_events(concreted_at, id);
  CREATE INDEX IF NOT EXISTS idx_principles_active ON principles(status, scope, project);
  CREATE INDEX IF NOT EXISTS idx_principle_conflicts_status ON principle_conflicts(status, id);
`;
