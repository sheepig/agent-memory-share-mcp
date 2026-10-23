import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildChunkAblationPool, runChunkAblation } from "./chunk-ablation.js";
import { readCandidatePool, readQueryCandidates, writeJsonFile, writeQueryCandidates } from "./files.js";
import { sessionReportHref } from "./session-report.js";
import { scanEvaluation } from "./scanner.js";
import { evaluationConfigSchema, type QueryCandidate } from "./types.js";

vi.mock("../search/embedding.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../search/embedding.js")>();
  return {
    ...original,
    LocalContentTokenizer: class {
      async countContentTokens(text: string) {
        return [...text].length;
      }
    },
    LocalEmbeddingProvider: class {
      readonly modelId = "fixture-embedding";
      async countContentTokens(text: string) {
        return [...text].length;
      }
      async embedPassages(texts: readonly string[]) {
        return texts.map((text) => Float32Array.from([text.includes("indexing") ? 1 : 0, 1]));
      }
      async embedQuery(text: string) {
        return Float32Array.from([text.includes("indexing") ? 1 : 0, 1]);
      }
    },
  };
});

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("chunk parameter ablation", () => {
  it("pools each variant's retrieved and seed-turn chunks under distinct passage identities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-ablation-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sources");
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(sourceRoot, "session.jsonl"));
    const config = evaluationConfigSchema.parse({
      benchmark: { modes: ["keyword", "semantic", "hybrid"], queryRuns: 1, queryWarmupRuns: 0 },
      chunkAblation: { variants: [
        { id: "small", maxContentTokens: 40, overlapContentTokens: 0 },
        { id: "large", maxContentTokens: 80, overlapContentTokens: 10 },
        { id: "large-copy", maxContentTokens: 80, overlapContentTokens: 10 },
      ] },
      datasets: [{ agent: "codex", id: "fixture-codex", roots: [sourceRoot], type: "local" }],
      outputDirectory: path.join(root, "output"),
      schemaVersion: 1,
    });
    const { manifest } = await scanEvaluation(config);
    const candidate: QueryCandidate = {
      answer: "Deterministic indexing behavior.",
      candidateId: "query-1",
      datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 3, sessionId: "fixture-codex", startLine: 2 }],
      query: "deterministic indexing behavior",
      queryType: "implementation",
      rationale: "The final answer discusses indexing.",
      review: { completeness: "unchecked", status: "pending" },
      split: "test",
    };
    const candidatesFile = path.join(root, "candidates.jsonl");
    await writeQueryCandidates(candidatesFile, [candidate]);

    const result = await buildChunkAblationPool(config, manifest, candidatesFile);
    const pool = await readCandidatePool(result.outputFile);
    const passages = pool.queries[0]!.results;

    expect(pool.chunkAblation?.variants).toEqual(config.chunkAblation?.variants);
    expect(passages.length).toBeGreaterThan(2);
    expect(new Set(passages.map((passage) => passage.passageId)).size).toBe(passages.length);
    expect(passages.every((passage) => passage.passageId?.length === 64)).toBe(true);
    expect(new Set(passages.flatMap((passage) => passage.variantIds ?? []))).toEqual(new Set(["small", "large", "large-copy"]));
    expect(passages.some((passage) => passage.variantIds?.includes("large") && passage.variantIds.includes("large-copy"))).toBe(true);
    expect(passages.filter((passage) => passage.chunkIndex === 0).length).toBeGreaterThan(1);
    expect(passages.some((passage) => passage.modes.includes("seed"))).toBe(true);

    const reviewedFile = path.join(root, "reviewed.jsonl");
    await writeQueryCandidates(reviewedFile, [{
      ...candidate,
      review: {
        completeness: "complete",
        judgments: passages.map((passage) => ({
          chunkIndex: passage.chunkIndex,
          endLine: 3,
          passageId: passage.passageId,
          reason: "Synthetic passage judgment.",
          relevance: passage.text.includes("indexing") ? 3 : 0,
          sessionId: passage.sessionId,
          startLine: 2,
        })),
        reviewer: "fixture",
        status: "accepted",
      },
    }]);
    const benchmark = await runChunkAblation(config, manifest, result.outputFile, reviewedFile);
    expect(benchmark.report.variants).toHaveLength(3);
    const reports = benchmark.report.variants;
    expect(benchmark.report.pooledTurnReferences).toEqual([{
      candidateId: candidate.candidateId, datasetId: candidate.datasetId, relevanceThreshold: 1,
      relevantTurns: [{ sessionId: "fixture-codex", location: "line:2", endLocation: "line:3" }],
    }]);
    expect(reports.map((variant) => variant.id)).toEqual(["small", "large", "large-copy"]);
    for (const variant of reports) {
      expect(variant.datasets[0]?.searches.keyword?.queries).toBe(1);
      expect(variant.datasets[0]?.searches.semantic?.queries).toBe(1);
      expect(variant.datasets[0]?.searches.hybrid?.queries).toBe(1);
      expect(variant.datasets[0]?.splitTurns).toBe(1);
      expect(variant.datasets[0]?.avgContentTokens).toBeGreaterThan(0);
      expect(variant.datasets[0]?.searches.keyword?.mrrAt10).toBeGreaterThanOrEqual(0);
      expect(variant.datasets[0]?.searches.keyword?.mrrAt10).toBeLessThanOrEqual(1);
      expect(variant.datasets[0]?.searches.semantic?.turnMetrics.at20).toMatchObject({ pooledTurnRecall: 1, hit: 1 });
      expect(variant.datasets[0]?.queries).toHaveLength(3);
      expect(variant.datasets[0]?.queries.find((query) => query.mode === "semantic")?.ranking[0]).toMatchObject({
        sessionId: "fixture-codex", sourcePath: path.join(sourceRoot, "session.jsonl"), location: "line:2", endLocation: "line:3",
      });
      const saved = JSON.parse(await fs.readFile(variant.reportFile, "utf8"));
      expect(saved.pooledTurnReferences).toEqual(benchmark.report.pooledTurnReferences);
      expect(JSON.stringify(saved.datasets[0].queries)).not.toContain("Synthetic final answer with sufficient visible detail");
      const qrels = await fs.readFile(path.join(path.dirname(variant.reportFile), "trec/fixture-codex/qrels.txt"), "utf8");
      expect(qrels.trim().split("\n")).toHaveLength(passages.filter((passage) => passage.variantIds?.includes(variant.id)).length);
      const variantHtml = await fs.readFile(variant.htmlReportFile, "utf8");
      expect(variantHtml).toContain("Retrieval evaluation");
      expect(variantHtml).toContain(`href="${sessionReportHref("fixture-codex", "fixture-codex", "line:2", "../")}"`);
    }
    const html = await fs.readFile(benchmark.htmlReportFile, "utf8");
    expect(html).toContain("Chunk parameter ablation");
    const href = sessionReportHref("fixture-codex", "fixture-codex", "line:2");
    expect(html).toContain(`href="${href}"`);
    const evidence = await fs.readFile(path.join(path.dirname(benchmark.htmlReportFile), href.split("#")[0]!), "utf8");
    expect(evidence).toContain('id="line-2"');
    expect(evidence).toContain("Synthetic Codex compatibility request");
    expect(html).toContain("small/report.html");
    expect(html).toContain("large/report.html");
    expect(html).toContain("large-copy/report.html");
    expect(html).toContain("Pooled Turn Recall");
    expect(html).toContain("Hit@K");
    expect(html).toContain("Same-turn duplicate rate");
    expect(html).toContain("Per-query comparison");
    expect(html).toContain("+0.0 pp");
    expect(html).not.toContain("Synthetic final answer with sufficient visible detail");
    expect(benchmark.report.inputHashes.poolSha256).toMatch(/^[a-f0-9]{64}$/u);

    const omitted = passages.find((passage) => passage.variantIds?.includes("small") && !passage.text.includes("indexing"))!;
    expect(omitted).toBeDefined();
    const partialPool = structuredClone(pool);
    partialPool.queries[0]!.results = partialPool.queries[0]!.results.filter((passage) => passage.passageId !== omitted.passageId);
    const partialPoolFile = path.join(root, "partial-pool.json");
    const partialQrelsFile = path.join(root, "partial-qrels.jsonl");
    const partialQrels = await readQueryCandidates(reviewedFile);
    partialQrels[0]!.review.judgments = partialQrels[0]!.review.judgments!.filter((judgment) => judgment.passageId !== omitted.passageId);
    await writeJsonFile(partialPoolFile, partialPool);
    await writeQueryCandidates(partialQrelsFile, partialQrels);
    await expect(runChunkAblation(config, manifest, partialPoolFile, partialQrelsFile)).rejects.toThrow(/unjudged passage/u);
    const diagnosticConfig = evaluationConfigSchema.parse({ ...config, benchmark: { ...config.benchmark, allowUnjudgedResults: true } });
    const diagnostic = await runChunkAblation(diagnosticConfig, manifest, partialPoolFile, partialQrelsFile);
    expect(diagnostic.report.allowUnjudgedResults).toBe(true);
    expect(diagnostic.report.variants[0]!.datasets[0]!.queries.some((query) => query.ranking.some((rank) => rank.passageId === omitted.passageId && rank.relevance === null))).toBe(true);
    expect(await fs.readFile(diagnostic.htmlReportFile, "utf8")).toContain("Unjudged results are allowed");

    // Keep the query in every variant even if only the large variant has relevant evidence.
    await writeQueryCandidates(reviewedFile, [{
      ...candidate,
      review: {
        completeness: "complete", reviewer: "fixture", status: "accepted",
        judgments: passages.map((passage) => ({
          endLine: 3, passageId: passage.passageId, reason: "Variant-specific relevance.",
          relevance: passage.variantIds?.includes("large") && passage.text.includes("indexing") ? 3 : 0,
          sessionId: passage.sessionId, startLine: 2,
        })),
      },
    }]);
    const variantSpecific = await runChunkAblation(config, manifest, result.outputFile, reviewedFile);
    expect(variantSpecific.report.pooledTurnReferences).toEqual(benchmark.report.pooledTurnReferences);
    expect(variantSpecific.report.variants[0]?.datasets[0]?.searches.semantic).toMatchObject({
      queries: 1, turnMetrics: { at20: { pooledTurnRecall: 0, hit: 0 } },
    });
    expect(variantSpecific.report.variants[1]?.datasets[0]?.searches.semantic).toMatchObject({
      queries: 1, turnMetrics: { at20: { pooledTurnRecall: 1, hit: 1 } },
    });

    const changedConfig = evaluationConfigSchema.parse({
      ...config,
      chunkAblation: { variants: [
        { id: "small", maxContentTokens: 40, overlapContentTokens: 0 },
        { id: "large", maxContentTokens: 80, overlapContentTokens: 0 },
        { id: "large-copy", maxContentTokens: 80, overlapContentTokens: 10 },
      ] },
    });
    await expect(runChunkAblation(changedConfig, manifest, result.outputFile, reviewedFile)).rejects.toThrow(/variants or search modes/u);

    const incomplete = {
      ...candidate,
      review: {
        completeness: "complete" as const,
        judgments: [
          { chunkIndex: passages[0]!.chunkIndex, endLine: 3, passageId: passages[0]!.passageId, reason: "Only one passage was judged.", relevance: 3, sessionId: passages[0]!.sessionId, startLine: 2 },
        ],
        reviewer: "fixture",
        status: "accepted" as const,
      },
    };
    await writeQueryCandidates(reviewedFile, [incomplete]);
    await expect(runChunkAblation(config, manifest, result.outputFile, reviewedFile)).rejects.toThrow(/cover every pooled passage/u);
  });

  it("rejects duplicate variants and non-advancing overlap", () => {
    const base = {
      datasets: [{ agent: "codex", id: "fixture", roots: ["/tmp"], type: "local" }],
      outputDirectory: "/tmp/agent-memory-eval",
      schemaVersion: 1,
    };
    expect(() => evaluationConfigSchema.parse({
      ...base,
      chunkAblation: { variants: [
        { id: "same", maxContentTokens: 100, overlapContentTokens: 0 },
        { id: "same", maxContentTokens: 200, overlapContentTokens: 0 },
      ] },
    })).toThrow();
    expect(() => evaluationConfigSchema.parse({
      ...base,
      chunkAblation: { variants: [
        { id: "bad", maxContentTokens: 100, overlapContentTokens: 100 },
        { id: "good", maxContentTokens: 200, overlapContentTokens: 0 },
      ] },
    })).toThrow();
  });
});
