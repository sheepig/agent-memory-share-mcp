import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FragmentSearch } from "./fragment-search.js";
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
