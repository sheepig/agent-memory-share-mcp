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
] as const;

export type AppDatabase = Database.Database;

export function openDatabase(dataDirectory: string): AppDatabase {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const database = new Database(path.join(dataDirectory, "agent-memory.sqlite"));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  migrate(database);
  return database;
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
