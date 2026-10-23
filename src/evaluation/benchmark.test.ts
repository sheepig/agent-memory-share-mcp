import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ManifestSessionAdapter, runBenchmark, validateCandidatesAgainstManifest, validateReviewedCandidates } from "./benchmark.js";
import { writeQueryCandidates } from "./files.js";
import { sessionReportHref } from "./session-report.js";
import { scanEvaluation } from "./scanner.js";
import { buildCandidatePool } from "./pool.js";
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
  };
});

const temporaryDirectories: string[] = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../sources/fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("evaluation benchmark", () => {
  it("indexes a fixed eligible manifest and calculates keyword quality", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-benchmark-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sources");
    const outputDirectory = path.join(root, "output");
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(sourceRoot, "session.jsonl"));
    const config = evaluationConfigSchema.parse({
      benchmark: { modes: ["keyword"], queryRuns: 1, queryWarmupRuns: 0 },
      datasets: [{ agent: "codex", id: "fixture-codex", roots: [sourceRoot], type: "local" }],
      outputDirectory,
      schemaVersion: 1,
    });
    const { manifest } = await scanEvaluation(config);
    const candidate: QueryCandidate = {
      answer: "The answer describes deterministic indexing behavior.",
      candidateId: "candidate-1",
      datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: 3, sessionId: "fixture-codex", startLine: 2 }],
      query: "deterministic indexing behavior",
      queryType: "implementation",
      rationale: "The source explicitly discusses indexing behavior.",
      review: { completeness: "complete", reviewer: "fixture", status: "accepted" },
    };
    const qrels = path.join(root, "qrels.jsonl");
    await writeQueryCandidates(qrels, [candidate]);

    const pool = await buildCandidatePool(config, manifest, qrels);
    const pooled = JSON.parse(await fs.readFile(pool.outputFile, "utf8")) as { queries: Array<{ results: unknown[] }> };
    expect(pool.queries).toBe(1);
    expect(pooled.queries[0]?.results.length).toBeGreaterThan(0);
    expect(pooled.queries[0]?.results[0]).toMatchObject({ modes: expect.arrayContaining(["seed"]), text: expect.any(String) });

    const { htmlReportFile, outputFile, report } = await runBenchmark(config, manifest, qrels);
    const dataset = (report.datasets as Array<Record<string, unknown>>)[0]!;
    const keyword = (dataset.searches as Record<string, Record<string, number>>).keyword!;

    expect(dataset.sessions).toBe(1);
    expect(dataset.fragments).toBe(1);
    expect(keyword.queries).toBe(1);
    expect(keyword.recallAt5).toBe(1);
    expect(keyword.mrrAt10).toBe(1);
    expect(report.qrels).toEqual({ accepted: 1, rejected: 0, reviewers: { "human:legacy": 1 }, total: 1 });
    expect(report.standardEvaluation).toMatchObject({ status: "not_configured" });
    expect(await fs.readFile(path.join(path.dirname(outputFile), "trec/fixture-codex/qrels.txt"), "utf8")).toContain("candidate-1 0 fixture-codex-");
    const html = await fs.readFile(htmlReportFile, "utf8");
    expect(html).toContain("Retrieval evaluation");
    expect(html).toContain("fixture-codex");
    expect(html).toContain("deterministic indexing behavior");
    const href = sessionReportHref("fixture-codex", "fixture-codex", "line:2");
    expect(html).toContain(`href="${href}"`);
    const evidence = await fs.readFile(path.join(path.dirname(outputFile), href.split("#")[0]!), "utf8");
    expect(evidence).toContain('id="line-2"');
    expect(evidence).toContain("Synthetic Codex compatibility request");
  });

  it("requires terminal and complete human review", () => {
    const pending = {
      answer: "answer",
      candidateId: "candidate",
      datasetId: "dataset",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: 2, sessionId: "session", startLine: 1 }],
      query: "query",
      queryType: "concept",
      rationale: "rationale",
      review: { completeness: "unchecked", status: "pending" },
    } satisfies QueryCandidate;

    expect(() => validateReviewedCandidates([pending])).toThrow(/complete review/u);
  });

  it("passes evaluation-only chunk parameters through the production adapter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-chunks-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sources");
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(sourceRoot, "session.jsonl"));
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture-codex", roots: [sourceRoot], type: "local" }],
      outputDirectory: path.join(root, "output"),
      schemaVersion: 1,
    });
    const { manifest } = await scanEvaluation(config);
    const dataset = manifest.datasets[0]!;
    const session = dataset.sessions[0]!;
    const source = {
      agent: dataset.agent,
      contentFingerprint: session.contentFingerprint,
      sourceId: session.sourceId,
      sourcePath: session.sourcePath,
      sourceType: "session" as const,
      updatedAt: new Date(session.updatedAt),
    };
    const tokenCounter = { async countContentTokens(text: string) { return [...text].length; } };
    const production = new ManifestSessionAdapter(dataset, tokenCounter);
    const variant = new ManifestSessionAdapter(dataset, tokenCounter, { maxContentTokens: 40, overlapContentTokens: 5 });
    const productionChunks = [];
    const variantChunks = [];
    for await (const document of production.extract(source)) productionChunks.push(document);
    for await (const document of variant.extract(source)) variantChunks.push(document);

    expect(productionChunks).toHaveLength(1);
    expect(variantChunks.length).toBeGreaterThan(1);
    expect(variantChunks.every((document) => document.contentTokenCount! <= 40)).toBe(true);
  });

  it("rejects a legacy span that is ambiguous across sibling chunks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-ambiguous-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "sources");
    await fs.mkdir(sourceRoot);
    await fs.copyFile(path.join(fixtures, "codex-jsonl-v1.jsonl"), path.join(sourceRoot, "session.jsonl"));
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture-codex", roots: [sourceRoot], type: "local" }],
      outputDirectory: path.join(root, "output"),
      schemaVersion: 1,
    });
    const { manifest } = await scanEvaluation(config);
    const session = manifest.datasets[0]!.sessions[0]!;
    const first = session.chunks[0]!;
    session.chunks.push({ ...first, chunkIndex: 1, ordinal: first.ordinal + 1 });
    const candidate: QueryCandidate = {
      answer: "answer",
      candidateId: "candidate",
      datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: 3, sessionId: session.sourceId, startLine: 2 }],
      query: "query",
      queryType: "concept",
      rationale: "rationale",
      review: { completeness: "complete", reviewer: "fixture", status: "accepted" },
    };

    expect(() => validateCandidatesAgainstManifest([candidate], manifest)).toThrow(/ambiguous/u);
  });
});
