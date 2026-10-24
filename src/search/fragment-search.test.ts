import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FragmentSearch } from "./fragment-search.js";
import { searchKeywordRows } from "./keyword-search.js";
import { encodeEmbedding, type EmbeddingProvider } from "./embedding.js";
import { buildSearchTerms } from "./tokens.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";

const workspaces: Array<{ database: AppDatabase; directory: string }> = [];
afterEach(() => {
  for (const { database, directory } of workspaces.splice(0)) {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fragment-rerank-"));
  const database = openDatabase(directory);
  workspaces.push({ database, directory });
  return database;
}

function insert(database: AppDatabase, id: string, options: {
  agent?: string; body?: string; chunk?: number; disposition?: string; location?: string;
  project?: string; source?: string; title?: string; type?: "memory" | "session"; updated?: string;
} = {}) {
  const source = options.source ?? id;
  const updated = options.updated ?? "2026-01-01T00:00:00.000Z";
  const body = options.body ?? `needle ${id}`;
  const type = options.type ?? "memory";
  database.prepare(`
    INSERT OR IGNORE INTO sources (id, source_type, agent, external_source_id, title, source_path,
      project_path, content_fingerprint, disposition, processing_state, source_updated_at, last_seen_at, embedding_state)
    VALUES (?, ?, ?, ?, 'SESSION DISCOVERY TITLE', ?, ?, ?, ?, 'indexed', ?, ?, 'indexed')
  `).run(source, type, options.agent ?? "codex", source, `/synthetic/${source}`, options.project ?? "/project/a",
    source, options.disposition ?? "selected", updated, updated);
  database.prepare(`INSERT INTO fragments (id, source_id, content_hash, ordinal, location, end_location, title, body, chunk_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, source, id, options.chunk ?? 0, options.location ?? "line:1", options.location ?? "line:1", options.title ?? null, body, options.chunk ?? null);
  database.prepare("INSERT INTO fragment_search VALUES (?, ?, ?)").run(id, buildSearchTerms(options.title ?? ""), buildSearchTerms(body));
  database.prepare("INSERT INTO fragment_embeddings(fragment_id, model_id, dimensions, embedding) VALUES (?, 'embedding-test', 2, ?)")
    .run(id, encodeEmbedding(Float32Array.from([1, 0])));
}

const embedding: EmbeddingProvider = {
  modelId: "embedding-test",
  async countContentTokens(text) { return text.length; },
  async embedQuery() { return Float32Array.from([1, 0]); },
  async embedPassages(texts) { return texts.map(() => Float32Array.from([1, 0])); },
};

describe("fragment search reranking", () => {
  it("takes one configuration snapshot per search and bypasses the model when disabled", async () => {
    const database = workspace();
    insert(database, "one");
    let enabled = false;
    const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map(() => 7));
    const search = new FragmentSearch(database, {
      isRerankerEnabled: () => enabled,
      reranker: { modelId: "test", score },
    });
    expect((await search.search({ limit: 1, query: "needle" })).results[0]?.matchReason).toBe("body match");
    expect(score).not.toHaveBeenCalled();
    enabled = true;
    expect((await search.search({ limit: 1, query: "needle" })).results[0]?.score).toBe(7);
    enabled = false;
    expect((await search.search({ limit: 1, query: "needle" })).results[0]?.matchReason).toBe("body match");
    expect(score).toHaveBeenCalledOnce();
  });

  it("finishes an already started search with its original configuration", async () => {
    const database = workspace();
    insert(database, "one");
    let enabled = true;
    let release!: (value: Float32Array) => void;
    const queryEmbedding = new Promise<Float32Array>((resolve) => { release = resolve; });
    const isRerankerEnabled = vi.fn(() => enabled);
    const score = vi.fn(async () => [7]);
    const search = new FragmentSearch(database, {
      embeddingProvider: { ...embedding, embedQuery: () => queryEmbedding },
      isRerankerEnabled,
      reranker: { modelId: "test", score },
    });
    const pending = search.search({ limit: 1, mode: "semantic", query: "needle" });
    enabled = false;
    release(Float32Array.from([1, 0]));
    expect((await pending).results[0]?.score).toBe(7);
    expect(isRerankerEnabled).toHaveBeenCalledOnce();
    expect((await search.search({ limit: 1, mode: "semantic", query: "needle" })).results[0]?.score).toBe(1);
    expect(score).toHaveBeenCalledOnce();
  });

  it("reranks full candidate bodies with explicit Memory titles and omits Session discovery titles", async () => {
    const database = workspace();
    insert(database, "first", { body: "needle", title: "Explicit memory title" });
    const fullBody = `needle ${"long detail ".repeat(400)} decisive evidence at the end`;
    insert(database, "second", { body: fullBody, type: "session" });
    const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map((text) => text.includes("decisive evidence") ? 9 : 1));
    const search = new FragmentSearch(database, { reranker: { modelId: "test-cross-encoder", score } });
    const result = await search.search({ limit: 1, query: "needle" });
    expect(result.results[0]).toMatchObject({ fragmentId: "second", score: 9, matchReason: expect.stringContaining("test-cross-encoder") });
    const documents = score.mock.calls[0]![1];
    expect(documents).toContain(fullBody);
    expect(documents).toContain("Explicit memory title\n\nneedle");
    expect(documents.join("\n")).not.toContain("SESSION DISCOVERY TITLE");
  });

  it("reranks before selecting the highest scoring chunk of each turn", async () => {
    const database = workspace();
    insert(database, "first", { type: "session", source: "same-turn", chunk: 0, body: "needle first" });
    insert(database, "best", { type: "session", source: "same-turn", chunk: 1, body: "needle best" });
    insert(database, "other", { type: "session", source: "other-turn", body: "needle other" });
    const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map((text) => text.includes("best") ? 3 : text.includes("first") ? 2 : 1));
    const search = new FragmentSearch(database, { reranker: { modelId: "test", score } });
    const candidates = await search.retrieveCandidates({ limit: 2, query: "needle" }, 3);
    expect(candidates).toHaveLength(3);
    expect((await search.search({ limit: 2, query: "needle" })).results.map((row) => row.fragmentId)).toEqual(["best", "other"]);
    expect(score.mock.calls[0]![1]).toHaveLength(3);
  });

  it("applies disposition and explicit filters before reranking in every mode", async () => {
    const database = workspace();
    insert(database, "allowed");
    insert(database, "excluded", { disposition: "excluded" });
    insert(database, "unselected", { disposition: "discovered" });
    insert(database, "other-agent", { agent: "cursor" });
    insert(database, "other-project", { project: "/project/b" });
    insert(database, "old", { updated: "2020-01-01T00:00:00.000Z" });
    insert(database, "future", { updated: "2030-01-01T00:00:00.000Z" });
    insert(database, "session", { type: "session" });
    const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map(() => 1));
    const search = new FragmentSearch(database, { embeddingProvider: embedding, reranker: { modelId: "test", score } });
    for (const mode of ["keyword", "semantic", "hybrid"] as const) {
      const result = await search.search({ agent: "codex", limit: 10, mode, projectPath: "/project/a", query: "needle",
        sourceType: "memory", updatedAfter: "2025-01-01", updatedBefore: "2027-01-01" });
      expect(result.results.map((row) => row.fragmentId)).toEqual(["allowed"]);
    }
    expect(score.mock.calls.every((call) => call[1].length === 1)).toBe(true);
  });

  it("preserves keyword, semantic and hybrid behavior without a reranker", async () => {
    const database = workspace();
    insert(database, "one");
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const keyword = (await search.search({ limit: 1, query: "needle" })).results[0]!;
    expect(keyword).toMatchObject({ fragmentId: "one", matchReason: "body match", score: undefined });
    const semantic = (await search.search({ limit: 1, mode: "semantic", query: "needle" })).results[0]!;
    expect(semantic).toMatchObject({ fragmentId: "one", matchReason: "semantic similarity", score: 1 });
    const hybrid = (await search.search({ limit: 1, mode: "hybrid", query: "needle" })).results[0]!;
    expect(hybrid).toMatchObject({ fragmentId: "one", matchReason: "hybrid match" });
    expect(hybrid.score).toBeCloseTo(2 / 61);
  });

  it.each(["keyword", "semantic", "hybrid"] as const)("excludes the caller's memories and sessions before %s reranking", async (mode) => {
    const database = workspace();
    const agents = ["claude-code", "codex", "cursor", "opencode"] as const;
    for (const agent of agents) {
      for (const type of ["memory", "session"] as const) insert(database, `${agent}-${type}`, { agent, type });
    }
    const score = vi.fn(async (_query: string, documents: readonly string[]) => documents.map(() => 1));
    const search = new FragmentSearch(database, { embeddingProvider: embedding, reranker: { modelId: "test", score } });
    for (const excludeAgent of agents) {
      score.mockClear();
      const input = { excludeAgent, limit: 20, mode, query: "needle" };
      const result = await search.search(input);
      const expected = agents.filter((agent) => agent !== excludeAgent)
        .flatMap((agent) => [`${agent}-memory`, `${agent}-session`]).sort();
      expect(result.results.map((row) => row.fragmentId).sort()).toEqual(expected);
      expect(score).toHaveBeenCalledOnce();
      expect(score.mock.calls[0]![1].map((body) => body.replace("needle ", "")).sort()).toEqual(expected);

      const conflict = { ...input, agent: excludeAgent };
      score.mockClear();
      expect((await search.search(conflict)).results).toEqual([]);
      expect(score).not.toHaveBeenCalled();
    }
  });

  it("expands hybrid retrieval beyond its default depth and caps the un-diversified pool", async () => {
    const database = workspace();
    for (let index = 0; index < 60; index += 1) insert(database, `item-${index}`);
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const candidates = await search.retrieveCandidates({ limit: 1, mode: "hybrid", query: "needle" }, 60);
    expect(candidates).toHaveLength(60);
    expect(candidates.every((candidate) => candidate.reason === "hybrid match")).toBe(true);
    expect(await search.retrieveCandidates({ limit: 1, mode: "hybrid", query: "needle" }, 10)).toHaveLength(10);
  });

  it.each([[1, 2], [NaN], [Infinity]])("rejects malformed scores %j", async (...scores) => {
    const database = workspace();
    insert(database, "one");
    const search = new FragmentSearch(database, { reranker: { modelId: "broken", async score() { return scores; } } });
    await expect(search.search({ limit: 1, query: "needle" })).rejects.toThrow(/scores/);
  });
});

describe("bounded semantic retrieval", () => {
  it("yields between vector batches and reads bodies only for final candidates", async () => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 300; index += 1) insert(database, `item-${index}`);
      database.prepare("UPDATE fragment_embeddings SET embedding = ? WHERE fragment_id <> 'item-299'")
        .run(encodeEmbedding(Float32Array.from([1, 1])));
    })();
    let yielded = false;
    const immediate = new Promise<void>((resolve) => setImmediate(() => { yielded = true; resolve(); }));
    const prepare = vi.spyOn(database, "prepare");
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const result = await search.search({ limit: 1, mode: "semantic", query: "needle" });
    const yieldedBeforeCompletion = yielded;
    await immediate;
    expect(yieldedBeforeCompletion).toBe(true);
    expect(result.results.map((row) => row.fragmentId)).toEqual(["item-299"]);
    const vectorQueries = prepare.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("e.embedding"));
    expect(vectorQueries.some((sql) => /LIMIT \?/.test(sql) && !sql.includes("f.body"))).toBe(true);
    await immediate;
    prepare.mockRestore();
  });

  it("keeps lower-scoring distinct turns after arbitrarily many chunks of one turn", async () => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 270; index += 1) {
        insert(database, `same-${index}`, { type: "session", source: "same", chunk: index });
      }
      insert(database, "other", { type: "session" });
      database.prepare("UPDATE fragment_embeddings SET embedding = ? WHERE fragment_id = 'other'")
        .run(encodeEmbedding(Float32Array.from([1, 1])));
    })();
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    expect((await search.search({ limit: 2, mode: "semantic", query: "needle" })).results.map((row) => row.fragmentId))
      .toEqual(["same-0", "other"]);
    expect((await search.retrieveCandidates({ limit: 2, mode: "semantic", query: "needle" }, 2))
      .map(({ row }) => row.fragment_id)).toEqual(["same-0", "same-1"]);
  });

  it.each(["exclude", "update"] as const)("does not return bodies changed by %s during a vector scan", async (change) => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 300; index += 1) insert(database, `item-${index}`);
    })();
    const changed = new Promise<void>((resolve) => setImmediate(() => {
      if (change === "exclude") database.prepare("UPDATE sources SET disposition = 'excluded' WHERE id = 'item-0'").run();
      else database.prepare("UPDATE fragments SET body = 'new unscored body', content_hash = 'changed' WHERE id = 'item-0'").run();
      resolve();
    }));
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const result = await search.search({ limit: 1, mode: "semantic", query: "needle" });
    await changed;
    expect(result.results.every((row) => row.fragmentId !== "item-0")).toBe(true);
  });

  it("matches exhaustive cosine ranking and turn diversification across batches", async () => {
    const database = workspace();
    const expected: Array<{ id: string; source: string; score: number }> = [];
    database.transaction(() => {
      for (let index = 0; index < 400; index += 1) {
        const id = `rank-${index}`;
        const source = `turn-${index % 19}`;
        const project = index % 7 === 0 ? "/context" : "/project/a";
        insert(database, id, { type: "session", source, chunk: Math.floor(index / 19), project });
        const vector = Float32Array.from([1, (index * 37 % 401) / 401]);
        database.prepare("UPDATE fragment_embeddings SET embedding = ? WHERE fragment_id = ?")
          .run(encodeEmbedding(vector), id);
        // Source project belongs to the first chunk that created the source.
        const sourceProject = (index % 19) % 7 === 0 ? "/context" : "/project/a";
        expected.push({ id, source, score: 1 / Math.sqrt(1 + vector[1]! ** 2) + (sourceProject === "/context" ? 0.05 : 0) });
      }
    })();
    expected.sort((left, right) => right.score - left.score);
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const input = { contextProjectPath: "/context", limit: 25, mode: "semantic" as const, query: "needle" };
    const leaders = expected.filter((row, index) => expected.findIndex((other) => other.source === row.source) === index);
    const repeats = expected.filter((row) => !leaders.includes(row));
    expect((await search.search(input)).results.map((row) => row.fragmentId))
      .toEqual([...leaders, ...repeats].slice(0, 25).map((row) => row.id));
    expect((await search.retrieveCandidates(input, 70)).map(({ row }) => row.fragment_id))
      .toEqual(expected.slice(0, 70).map((row) => row.id));
  });

  it("revalidates source availability after asynchronous reranking", async () => {
    const database = workspace();
    insert(database, "one");
    const search = new FragmentSearch(database, {
      embeddingProvider: embedding,
      reranker: { modelId: "exclude-during-rerank", async score() {
        database.prepare("UPDATE sources SET disposition = 'excluded' WHERE id = 'one'").run();
        return [1];
      } },
    });
    expect((await search.search({ limit: 1, mode: "semantic", query: "needle" })).results).toEqual([]);
  });
});


describe("bounded keyword retrieval", () => {
  it("retains raw depth and distinct turns without loading duplicate bodies", async () => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 400; index += 1) insert(database, `same-${index}`, {
        body: "needle", chunk: index, source: "same", type: "session", updated: "2027-01-01T00:00:00.000Z",
      });
      insert(database, "other", { body: "needle", type: "session" });
    })();
    let yielded = false;
    const scheduled = new Promise<void>((resolve) => setImmediate(() => { yielded = true; resolve(); }));
    const references = await searchKeywordRows(database, { limit: 2, query: "needle" }, {
      filters: ["s.processing_state = 'indexed'", "s.disposition = 'selected'"],
      values: [], limit: 2, diversify: true,
    });
    const yieldedDuringScan = yielded;
    await scheduled;
    expect(yieldedDuringScan).toBe(true);
    expect(references.map((row) => row.fragment_id)).toEqual(["same-0", "same-1", "other"]);
    expect(references.every((row) => !("body" in row))).toBe(true);
    const search = new FragmentSearch(database);
    expect((await search.search({ limit: 2, query: "needle" })).results.map((row) => row.fragmentId))
      .toEqual(["same-0", "other"]);
    expect((await search.retrieveCandidates({ limit: 2, query: "needle" }, 2)).map(({ row }) => row.fragment_id))
      .toEqual(["same-0", "same-1"]);
  });

  it("preserves original RRF ranks for semantic hits beyond the retained keyword turn leaders", async () => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 200; index += 1) insert(database, `same-${index}`, {
        body: "needle", chunk: index, source: "same", type: "session", updated: "2027-01-01T00:00:00.000Z",
      });
      for (let index = 0; index < 50; index += 1) insert(database, `other-${String(index).padStart(3, "0")}`, {
        body: "needle", type: "session",
      });
      database.prepare("UPDATE fragment_embeddings SET embedding = ? WHERE fragment_id <> 'other-049'")
        .run(encodeEmbedding(Float32Array.from([0, 1])));
    })();
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const result = await search.search({ limit: 2, mode: "hybrid", query: "needle" });
    expect(result.results.map((row) => row.fragmentId)).toEqual(["same-0", "other-049"]);
    expect(result.results[1]?.matchReason).toBe("hybrid match");
    expect(result.results[1]?.score).toBeCloseTo(1 / 61 + 1 / (60 + 250), 12);
  });

  it("matches exhaustive hybrid fusion for duplicate-heavy keyword rankings", async () => {
    const database = workspace();
    const semantics: Array<{ id: string; score: number }> = [];
    database.transaction(() => {
      for (let index = 0; index < 360; index += 1) {
        const id = `fusion-${index}`;
        insert(database, id, { body: `needle ${"detail ".repeat(index % 9)}`, type: "session",
          source: `turn-${index % 13}`, chunk: Math.floor(index / 13) });
        const vector = Float32Array.from([1, (index * 31 % 367) / 367]);
        database.prepare("UPDATE fragment_embeddings SET embedding = ? WHERE fragment_id = ?")
          .run(encodeEmbedding(vector), id);
        semantics.push({ id, score: 1 / Math.sqrt(1 + vector[1]! ** 2) });
      }
    })();
    semantics.sort((left, right) => right.score - left.score);
    const lexical = database.prepare(`SELECT f.id, f.source_id FROM fragment_search
      JOIN fragments f ON f.id = fragment_search.fragment_id JOIN sources s ON s.id = f.source_id
      WHERE fragment_search MATCH 'needle'
      ORDER BY bm25(fragment_search, 0.0, 5.0, 1.0), s.source_updated_at DESC, f.ordinal, f.id`)
      .all() as Array<{ id: string; source_id: string }>;
    const fused = new Map(lexical.map((row, index) => [row.id, { ...row, score: 1 / (60 + index + 1) }]));
    semantics.slice(0, 50).forEach((row, index) => { fused.get(row.id)!.score += 1 / (60 + index + 1); });
    const ranking = [...fused.values()].sort((left, right) => right.score - left.score);
    const search = new FragmentSearch(database, { embeddingProvider: embedding });
    const input = { limit: 5, mode: "hybrid" as const, query: "needle" };
    const distinct = ranking.filter((row, index) => ranking.findIndex((other) => row.source_id === other.source_id) === index);
    expect((await search.search(input)).results.map((row) => row.fragmentId)).toEqual(distinct.slice(0, 5).map((row) => row.id));
    expect((await search.retrieveCandidates(input, 50)).map(({ row }) => row.fragment_id))
      .toEqual(ranking.slice(0, 50).map((row) => row.id));
  });

  it("revalidates keyword references after a source is excluded between pages", async () => {
    const database = workspace();
    database.transaction(() => {
      for (let index = 0; index < 200; index += 1) insert(database, `same-${index}`, {
        body: "needle", chunk: index, source: "same", type: "session", updated: "2027-01-01T00:00:00.000Z",
      });
      insert(database, "other", { body: "needle", type: "session" });
    })();
    const excluded = new Promise<void>((resolve) => setImmediate(() => {
      database.prepare("UPDATE sources SET disposition = 'excluded' WHERE id = 'same'").run();
      resolve();
    }));
    const result = await new FragmentSearch(database).search({ limit: 2, query: "needle" });
    await excluded;
    expect(result.results.every((row) => row.sourceId !== "same")).toBe(true);
  });
});
