import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("database migrations", () => {
  it("adds diagnostic source paths to an existing version 2 database", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-migration-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "agent-memory.sqlite");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE fragment_search USING fts5(fragment_id UNINDEXED, title_terms, body_terms, tokenize='unicode61');
      INSERT INTO schema_migrations VALUES(2, '2026-01-01T00:00:00.000Z');
      CREATE TABLE scan_diagnostics(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT,
        level TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sources(
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        agent TEXT NOT NULL,
        external_source_id TEXT NOT NULL,
        title TEXT,
        source_path TEXT NOT NULL,
        project_path TEXT,
        content_fingerprint TEXT NOT NULL,
        indexed_fingerprint TEXT,
        disposition TEXT NOT NULL,
        processing_state TEXT NOT NULL,
        source_updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        error_message TEXT,
        index_rule_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE fragments(
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT,
        location TEXT NOT NULL,
        title TEXT,
        body TEXT NOT NULL
      );
    `);
    old.close();

    const database = openDatabase(directory);
    const columns = database.prepare("PRAGMA table_info(scan_diagnostics)").all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toContain("source_path");
    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
    ]);
    const fragmentColumns = database.prepare("PRAGMA table_info(fragments)").all() as Array<{ name: string }>;
    expect(fragmentColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "end_location",
      "ended_at",
      "started_at",
      "turn_count",
      "chunk_index",
      "content_tokens",
    ]));
    const embeddingColumns = database.prepare("PRAGMA table_info(fragment_embeddings)").all() as Array<{ name: string }>;
    expect(embeddingColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "dimensions",
      "embedding",
      "fragment_id",
      "model_id",
      "input_hash",
    ]));
    const sourceColumns = database.prepare("PRAGMA table_info(sources)").all() as Array<{ name: string }>;
    expect(sourceColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "embedding_error",
      "embedding_model_id",
      "embedding_state",
      "explicit_metadata_json",
      "last_seen_scan_id",
      "original_session_id",
      "security_rule_version",
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scan_checkpoints'").get())
      .toEqual({ name: "scan_checkpoints" });
    expect((await fs.stat(`${file}.pre-migration-v2.bak`)).isFile()).toBe(true);
    database.close();
  });
});
