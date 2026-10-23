import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildRerankPool, rankRerankCandidates, rerankIndexDirectory, runRerankBenchmark, scoreRerankCheckpoint } from "./rerank.js";
import type { EvaluationSearchResult } from "./metrics.js";
import { readCandidatePool, writeJsonFile, writeQueryCandidates } from "./files.js";
import { evaluationHash } from "./identity.js";
import { scanEvaluation } from "./scanner.js";
import { evaluationConfigSchema, type QueryCandidate } from "./types.js";
import { openDatabase } from "../storage/database.js";
import { KEYWORD_QUERY_RULE_VERSION } from "../search/tokens.js";

vi.mock("../search/embedding.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../search/embedding.js")>(),
  LocalContentTokenizer: class { async countContentTokens(text: string) { return text.length; } },
  LocalEmbeddingProvider: class {
    readonly modelId = "synthetic-embedding";
    async countContentTokens(text: string) { return text.length; }
    async embedPassages(texts: readonly string[]) { return texts.map(() => Float32Array.from([1, 1])); }
    async embedQuery() { return Float32Array.from([1, 1]); }
  },
}));

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function result(id: string, location: string): EvaluationSearchResult {
  return {
    agent: "codex", contentFingerprint: "fingerprint", excerpt: "", fragmentId: id,
    location, matchReason: "hybrid", passageId: id, sessionId: "session", sourceId: "source",
    sourcePath: "/synthetic/session.jsonl", sourceType: "session", updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("frozen reranker comparison", () => {
  it("reranks only the same depth prefix and diversifies after scoring", () => {
    const candidates = [result("a", "line:1"), result("b", "line:1"), result("c", "line:2"), result("d", "line:3")];
    expect(rankRerankCandidates(candidates, 3).map((value) => value.passageId)).toEqual(["a", "c", "b"]);
    expect(rankRerankCandidates(candidates, 3, [1, 9, 4, 100]).map((value) => value.passageId)).toEqual(["b", "c", "a"]);
  });

  it("measures repeated real scoring and resumes only matching checkpoints", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reranker-checkpoint-"));
    directories.push(directory);
    const file = path.join(directory, "query.json");
    const provider = { modelId: "synthetic", score: vi.fn(async () => [0.2, 0.9]), dispose: vi.fn(async () => {}) };
    const input = { binding: "frozen-input", passages: ["first synthetic text", "second synthetic text"], query: "synthetic query", runs: 3 };
    const first = await scoreRerankCheckpoint(file, provider, input);
    expect(provider.score).toHaveBeenCalledTimes(3);
    expect(first.latencyMs).toHaveLength(3);
    expect(first.scores).toEqual([0.2, 0.9]);
    expect(await scoreRerankCheckpoint(file, provider, input)).toEqual(first);
    expect(provider.score).toHaveBeenCalledTimes(3);
    await expect(scoreRerankCheckpoint(file, provider, { ...input, binding: "changed" })).rejects.toThrow("checkpoint");
    await fs.writeFile(file, "broken");
    await expect(scoreRerankCheckpoint(file, provider, input)).rejects.toThrow();
  });

  it("rejects missing or non-finite model scores before saving", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reranker-checkpoint-"));
    directories.push(directory);
    const provider = { modelId: "synthetic", score: vi.fn(async () => [Number.NaN]), dispose: vi.fn(async () => {}) };
    await expect(scoreRerankCheckpoint(path.join(directory, "bad.json"), provider, {
      binding: "frozen", passages: ["synthetic text"], query: "query", runs: 1,
    })).rejects.toThrow("scores");
  });

  it("freezes real service candidates, rejects unjudged evidence and exports body-free reports", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reranker-service-"));
    directories.push(directory);
    const sources = path.join(directory, "sources");
    await fs.mkdir(sources);
    await fs.copyFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures/codex-jsonl-v1.jsonl"), path.join(sources, "session.jsonl"));
    const config = { ...evaluationConfigSchema.parse({
      schemaVersion: 1, outputDirectory: path.join(directory, "output"),
      datasets: [{ agent: "codex", id: "fixture-codex", type: "local", roots: [sources] }],
      benchmark: { modes: ["hybrid"], queryRuns: 2, queryWarmupRuns: 0 },
    }), reranker: { candidateCounts: [50], cacheDirectory: path.join(directory, "cache") } };
    const { manifest } = await scanEvaluation(config);
    const candidate: QueryCandidate = {
      answer: "Synthetic answer", candidateId: "query-1", datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 3, startLine: 2, sessionId: "fixture-codex" }],
      query: "indexing behavior", queryType: "implementation", rationale: "Synthetic query",
      queryQuality: { reason: "Synthetic accepted query", reviewedAt: "2026-01-01", reviewer: { model: "fixture", promptVersion: 1 }, status: "accepted" },
      review: { completeness: "unchecked", status: "pending" }, split: "test",
    };
    const candidatesFile = path.join(directory, "candidates.jsonl");
    const rejectedCandidate = { ...candidate, candidateId: "query-without-relevant", query: "other synthetic question" };
    await writeQueryCandidates(candidatesFile, [candidate, rejectedCandidate]);
    const built = await buildRerankPool(config, manifest, candidatesFile);
    const databaseState = () => {
      const database = openDatabase(path.join(rerankIndexDirectory(config, manifest), "fixture-codex"));
      try {
        return {
          fragments: database.prepare("SELECT id FROM fragments ORDER BY id").all(),
          embeddings: database.prepare("SELECT fragment_id, model_id, input_hash FROM fragment_embeddings ORDER BY fragment_id").all(),
        };
      } finally { database.close(); }
    };
    const initialState = databaseState();
    expect(initialState.fragments).toHaveLength(1);
    expect(initialState.embeddings).toHaveLength(1);
    const rebuilt = await buildRerankPool(config, manifest, candidatesFile);
    expect(path.dirname(rebuilt.outputFile)).not.toBe(path.dirname(built.outputFile));
    expect(databaseState()).toEqual(initialState);
    const pool = await readCandidatePool(built.outputFile);
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0]!.results[0]!.modes).toContain("seed");
    expect(await fs.readFile(built.retrievalFile, "utf8")).not.toContain("Synthetic final answer");
    const reviewed: QueryCandidate = { ...candidate, review: {
      completeness: "complete", status: "accepted", reviewer: "fixture",
      scope: { depth: 50, modes: ["hybrid"], poolGeneratedAt: pool.generatedAt, poolSha256: evaluationHash(pool), type: "pooled" },
      judgments: pool.queries[0]!.results.map((passage) => ({
        chunkIndex: passage.chunkIndex, endLine: 3, startLine: 2, sessionId: passage.sessionId,
        passageId: passage.passageId, reason: "Synthetic judgment", relevance: 3,
      })),
    } };
    const qrelsFile = path.join(directory, "qrels.jsonl");
    const rejected: QueryCandidate = { ...rejectedCandidate, review: {
      ...reviewed.review, status: "rejected", judgments: reviewed.review.judgments!.map((judgment) => ({ ...judgment, relevance: 0 })),
    } };
    await writeQueryCandidates(qrelsFile, [{ ...reviewed, review: { ...reviewed.review, judgments: [] } }, rejected]);
    const provider = { modelId: "fixture-reranker", score: vi.fn(async (_query: string, passages: readonly string[]) => passages.map(() => 1)), dispose: vi.fn(async () => {}) };
    await expect(runRerankBenchmark(config, manifest, built.outputFile, qrelsFile, built.retrievalFile, { provider })).rejects.toThrow("complete judgments");
    expect(provider.score).not.toHaveBeenCalled();
    await writeQueryCandidates(qrelsFile, [reviewed, rejected]);
    const evaluated = await runRerankBenchmark(config, manifest, built.outputFile, qrelsFile, built.retrievalFile, { provider });
    expect(provider.score).toHaveBeenCalledTimes(3);
    expect(evaluated.report.zeroRelevantQueriesExcluded).toBe(1);
    expect(evaluated.report.paired[0]).toMatchObject({ improved: 0, tied: 1, worse: 0 });
    expect(evaluated.report.runs.find((run) => run.mode === "hybrid-current")?.latencyMs).toHaveLength(2);
    const html = await fs.readFile(evaluated.htmlReportFile, "utf8");
    expect(html).toContain("silver");
    expect(html).toContain("not production quality evidence");
    expect(html).toContain(KEYWORD_QUERY_RULE_VERSION);
    expect(html).not.toContain("Synthetic final answer");
    const saved = await fs.readFile(evaluated.outputFile, "utf8");
    expect(saved).not.toContain("Synthetic final answer");
    const retrieval = JSON.parse(await fs.readFile(built.retrievalFile, "utf8"));
    expect(retrieval.queries[0].currentLatencyMs).toHaveLength(2);
    expect(retrieval.queries[0].currentResults).toHaveLength(1);
    expect(retrieval.keywordQueryRuleVersion).toBe(KEYWORD_QUERY_RULE_VERSION);
    await writeJsonFile(built.retrievalFile, { ...retrieval, keywordQueryRuleVersion: "obsolete-query-rule" });
    await expect(runRerankBenchmark(config, manifest, built.outputFile, qrelsFile, built.retrievalFile, { provider })).rejects.toThrow("does not match");
    retrieval.queries[0].candidates[0].passageId = "0".repeat(64);
    await writeJsonFile(built.retrievalFile, retrieval);
    await expect(runRerankBenchmark(config, manifest, built.outputFile, qrelsFile, built.retrievalFile, { provider })).rejects.toThrow("judged pool passage");
  });

  it("keeps current hybrid diversity separately from a prefix cap and pools both rankings", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reranker-current-"));
    directories.push(directory);
    const sources = path.join(directory, "sources");
    await fs.mkdir(sources);
    const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures/codex-jsonl-v1.jsonl");
    const records = (await fs.readFile(fixture, "utf8")).trim().split("\n").map((value) => JSON.parse(value));
    records[2].payload.content[0].text = "indexing paragraph ".repeat(150);
    const user = structuredClone(records[1]);
    user.payload.id = "second-user";
    user.payload.content[0].text = "Explain a second distinct topic with sufficient visible details.";
    const assistant = structuredClone(records[2]);
    assistant.payload.id = "second-assistant";
    assistant.payload.content[0].text = "A separate final answer explains another topic with sufficient detail to form a complete retrievable interaction.";
    await fs.writeFile(path.join(sources, "session.jsonl"), [...records, user, assistant].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const config = { ...evaluationConfigSchema.parse({
      schemaVersion: 1, outputDirectory: path.join(directory, "output"),
      datasets: [{ agent: "codex", id: "fixture-codex", type: "local", roots: [sources] }],
      benchmark: { modes: ["hybrid"], queryRuns: 1, queryWarmupRuns: 0 },
    }), reranker: { candidateCounts: [1], cacheDirectory: path.join(directory, "cache") } };
    const { manifest } = await scanEvaluation(config);
    const candidate: QueryCandidate = {
      answer: "Synthetic answer", candidateId: "long-turn-query", datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 3, startLine: 2, sessionId: "fixture-codex" }],
      query: "indexing", queryType: "implementation", rationale: "Synthetic query",
      queryQuality: { reason: "Synthetic accepted query", reviewedAt: "2026-01-01", reviewer: { model: "fixture", promptVersion: 1 }, status: "accepted" },
      review: { completeness: "unchecked", status: "pending" }, split: "test",
    };
    const candidatesFile = path.join(directory, "candidates.jsonl");
    await writeQueryCandidates(candidatesFile, [candidate]);
    const built = await buildRerankPool(config, manifest, candidatesFile);
    const retrieval = JSON.parse(await fs.readFile(built.retrievalFile, "utf8"));
    const query = retrieval.queries[0];
    expect(query.candidates).toHaveLength(1);
    expect(query.currentResults.length).toBeGreaterThan(1);
    expect(query.currentLatencyMs).toHaveLength(1);
    const pool = await readCandidatePool(built.outputFile);
    const pooledIds = new Set(pool.queries[0]!.results.map((passage) => passage.passageId));
    for (const result of query.currentResults) expect(pooledIds.has(result.passageId)).toBe(true);
    expect(query.currentResults[0].location).not.toBe(query.currentResults[1].location);
    expect(query.currentResults.every((result: { excerpt: string }) => result.excerpt === "")).toBe(true);
  });
});
