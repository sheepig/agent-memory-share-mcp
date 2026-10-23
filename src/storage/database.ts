import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('session', 'memory')),
      agent TEXT NOT NULL,
      external_source_id TEXT NOT NULL,
      title TEXT,
      source_path TEXT NOT NULL,
      project_path TEXT,
      content_fingerprint TEXT NOT NULL,
      indexed_fingerprint TEXT,
      disposition TEXT NOT NULL CHECK (disposition IN ('discovered', 'selected', 'excluded')),
      processing_state TEXT NOT NULL CHECK (processing_state IN (
        'discovered', 'indexing', 'indexed', 'failed', 'source_changed', 'source_unavailable'
      )),
      source_updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      error_message TEXT,
      index_rule_version INTEGER NOT NULL DEFAULT 1,
      UNIQUE (agent, source_type, external_source_id)
    );

    CREATE INDEX sources_type_disposition ON sources(source_type, disposition);
    CREATE INDEX sources_agent_updated ON sources(agent, source_updated_at DESC);

    CREATE TABLE fragments (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT CHECK (role IS NULL OR role IN ('assistant', 'user')),
      location TEXT NOT NULL,
      title TEXT,
      body TEXT NOT NULL,
      UNIQUE (source_id, ordinal, location)
    );

    CREATE INDEX fragments_source ON fragments(source_id, ordinal);

    CREATE VIRTUAL TABLE fragment_search USING fts5(
      fragment_id UNINDEXED,
      title_terms,
      body_terms,
      tokenize='unicode61'
    );

    CREATE TABLE scan_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
      level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE source_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE scan_diagnostics ADD COLUMN source_path TEXT;
  `,
  `
    ALTER TABLE fragments ADD COLUMN end_location TEXT;
    ALTER TABLE fragments ADD COLUMN started_at TEXT;
    ALTER TABLE fragments ADD COLUMN ended_at TEXT;
    ALTER TABLE fragments ADD COLUMN turn_count INTEGER CHECK (turn_count IS NULL OR turn_count > 0);
  `,
  `
    CREATE TABLE fragment_embeddings (
      fragment_id TEXT PRIMARY KEY REFERENCES fragments(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      embedding BLOB NOT NULL
    );

    CREATE INDEX fragment_embeddings_model ON fragment_embeddings(model_id);
  `,
  `
    ALTER TABLE sources ADD COLUMN embedding_state TEXT NOT NULL DEFAULT 'pending'
      CHECK (embedding_state IN ('disabled', 'failed', 'indexed', 'indexing', 'pending'));
    ALTER TABLE sources ADD COLUMN embedding_model_id TEXT;
    ALTER TABLE sources ADD COLUMN embedding_error TEXT;
    ALTER TABLE fragment_embeddings ADD COLUMN input_hash TEXT;
  `,
  `
    ALTER TABLE sources ADD COLUMN original_session_id TEXT;
    ALTER TABLE sources ADD COLUMN explicit_metadata_json TEXT;
    ALTER TABLE sources ADD COLUMN last_seen_scan_id TEXT;

    CREATE TABLE scan_checkpoints (
      adapter_key TEXT PRIMARY KEY,
      scan_id TEXT NOT NULL,
      cursor TEXT,
      started_at TEXT NOT NULL
    );

    CREATE INDEX sources_scan_generation ON sources(source_type, agent, last_seen_scan_id);
  `,
  `
    ALTER TABLE scan_diagnostics ADD COLUMN adapter_key TEXT;
    ALTER TABLE scan_diagnostics ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE scan_diagnostics ADD COLUMN last_seen_at TEXT;
    ALTER TABLE scan_diagnostics ADD COLUMN resolved_at TEXT;
    UPDATE scan_diagnostics SET last_seen_at = created_at WHERE last_seen_at IS NULL;
    CREATE INDEX scan_diagnostics_current ON scan_diagnostics(resolved_at, id DESC);
  `,
  `
    ALTER TABLE sources ADD COLUMN security_rule_version INTEGER NOT NULL DEFAULT 1;
  `,
  `
    ALTER TABLE fragments ADD COLUMN chunk_index INTEGER;
    ALTER TABLE fragments ADD COLUMN content_tokens INTEGER CHECK (content_tokens IS NULL OR content_tokens >= 0);
  `,
] as const;

export type AppDatabase = Database.Database;

export function openDatabase(dataDirectory: string): AppDatabase {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, "agent-memory.sqlite");
  const existed = fs.existsSync(databasePath);
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(migrations[0]);
  const currentVersion = (database.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number | null }).version ?? 1;
  const backupPath = existed && currentVersion < migrations.length
    ? `${databasePath}.pre-migration-v${currentVersion}.bak`
    : undefined;
  if (backupPath) {
    database.pragma("wal_checkpoint(TRUNCATE)");
    fs.copyFileSync(databasePath, backupPath);
  }
  try {
    migrate(database);
  } catch (error) {
    database.close();
    if (backupPath) {
      fs.rmSync(`${databasePath}-wal`, { force: true });
      fs.rmSync(`${databasePath}-shm`, { force: true });
      fs.copyFileSync(backupPath, databasePath);
    }
    throw error;
  }
  backfillEmbeddingInputHashes(database);
  return database;
}

function backfillEmbeddingInputHashes(database: AppDatabase): void {
  const rows = database.prepare(`
    SELECT e.fragment_id, f.title, f.body
    FROM fragment_embeddings e
    JOIN fragments f ON f.id = e.fragment_id
    WHERE e.input_hash IS NULL
  `).all() as Array<{ body: string; fragment_id: string; title: string | null }>;
  if (rows.length === 0) return;
  const update = database.prepare("UPDATE fragment_embeddings SET input_hash = ? WHERE fragment_id = ?");
  database.transaction(() => {
    for (const row of rows) {
      const input = `${row.title ? `${row.title}\n` : ""}${row.body}`;
      update.run(createHash("sha256").update(input).digest("hex"), row.fragment_id);
    }
  })();
}

function migrate(database: AppDatabase): void {
  database.exec(migrations[0]);
  const applied = database
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((row) => (row as { version: number }).version);

  const apply = database.transaction(() => {
    migrations.slice(1).forEach((sql, index) => {
      const version = index + 2;
      if (applied.includes(version)) {
        return;
      }
      database.exec(sql);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    });
  });
  apply();
}
