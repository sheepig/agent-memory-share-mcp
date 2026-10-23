import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { buildFtsQuery, buildSearchTerms } from "./tokens.js";

describe("search terms", () => {
  it("keeps the indexed Chinese n-grams and English prefixes", () => {
    expect(buildSearchTerms("会话搜索").split(" ")).toEqual(expect.arrayContaining(["会", "会话", "会话搜", "搜索"]));
    expect(buildSearchTerms("Session").split(" ")).toEqual(expect.arrayContaining(["se", "sess", "session"]));
  });

  it("uses full English terms and Chinese bigrams as optional query terms", () => {
    expect(buildFtsQuery("MCP search")).toBe('"mcp" OR "search"');
    expect(buildFtsQuery("会话搜索")).toBe('"会话" OR "话搜" OR "搜索"');
    expect(buildFtsQuery("查")).toBe('"查"');
    expect(buildFtsQuery("  WAL wal  ")).toBe('"wal"');
    expect(buildFtsQuery('" OR () *')).toBe('"or"');
    expect(buildFtsQuery("***")).toBe("");
    expect(buildFtsQuery("SQLITE_BUSY source_service.ts")).toBe('"sqlite_busy" OR "source_service" OR "ts"');
  });

  it("recalls partial natural-language matches without short-prefix or single-Han noise", () => {
    const database = new Database(":memory:");
    try {
      database.exec("CREATE VIRTUAL TABLE documents USING fts5(id UNINDEXED, terms)");
      const insert = database.prepare("INSERT INTO documents VALUES (?, ?)");
      insert.run("wal", buildSearchTerms("SQLite WAL concurrent readers"));
      insert.run("server", buildSearchTerms("server connection"));
      insert.run("session", buildSearchTerms("session provenance"));
      insert.run("chinese", buildSearchTerms("会话搜索"));
      insert.run("single-character-noise", buildSearchTerms("开会讨论"));
      const search = (query: string) => database.prepare("SELECT id FROM documents WHERE documents MATCH ? ORDER BY bm25(documents)").all(buildFtsQuery(query));
      expect(search("why SQLite WAL helps concurrency")).toEqual([{ id: "wal" }]);
      expect(search("session")).toEqual([{ id: "session" }]);
      expect(search("会话搜索")).toEqual([{ id: "chinese" }]);
      expect(search('" OR () *')).toEqual([]);
    } finally {
      database.close();
    }
  });
});
