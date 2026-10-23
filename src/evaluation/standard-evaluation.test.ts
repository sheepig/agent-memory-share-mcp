import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FragmentSearchResult } from "../domain/source.js";
import { runStandardEvaluation, type NativeMetrics } from "./standard-evaluation.js";
import type { QueryCandidate } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

function acceptedCandidate(): QueryCandidate {
  return {
    answer: "The indexed passage answers the query.",
    candidateId: "query-1",
    datasetId: "fixture",
    generatedBy: { model: "fixture", promptVersion: 1 },
    goldSpans: [{ chunkIndex: 0, endLine: 4, sessionId: "session-1", startLine: 2 }],
    query: "How is the passage indexed?",
    queryType: "implementation",
    rationale: "The relevant passage states the implementation.",
    review: {
      completeness: "complete",
      judgments: [
        { chunkIndex: 0, endLine: 4, reason: "Direct answer.", relevance: 3, sessionId: "session-1", startLine: 2 },
        { chunkIndex: 1, endLine: 4, reason: "Sibling chunk is unrelated.", relevance: 0, sessionId: "session-1", startLine: 2 },
      ],
      reviewer: {
        model: "fixture",
        promptVersion: 1,
        provider: "fixture",
        relevanceThreshold: 2,
        reportedModels: ["fixture"],
        type: "llm",
      },
      status: "accepted",
    },
  };
}

function result(): FragmentSearchResult {
  return {
    agent: "codex",
    chunkIndex: 0,
    contentFingerprint: "fingerprint",
    endLocation: "line:4",
    excerpt: "The indexed passage answers the query.",
    fragmentId: "fragment-1",
    location: "line:2",
    matchReason: "keyword",
    sessionId: "session-1",
    sourceId: "session-1",
    sourcePath: "/tmp/session-1.jsonl",
    sourceType: "session",
    updatedAt: "2026-10-19T00:00:00.000Z",
  };
}

const perfectMetrics: NativeMetrics = {
  mrrAt10: 1,
  ndcgAt10: 1,
  recallAt5: 1,
  recallAt10: 1,
  recallAt20: 1,
};

describe("standard evaluation", () => {
  it("exports different TREC document IDs for variant passages with the same chunk index", async () => {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-standard-passages-"));
    temporaryDirectories.push(outputDirectory);
    const candidate = acceptedCandidate();
    candidate.review.judgments = [
      { chunkIndex: 0, endLine: 4, passageId: "passage-a", reason: "Direct answer.", relevance: 3, sessionId: "session-1", startLine: 2 },
      { chunkIndex: 0, endLine: 4, passageId: "passage-b", reason: "Different text.", relevance: 0, sessionId: "session-1", startLine: 2 },
    ];
    await runStandardEvaluation({
      candidates: [candidate],
      nativeMetrics: new Map([["fixture\0keyword", perfectMetrics]]),
      outputDirectory,
      runs: [{ candidateId: "query-1", datasetId: "fixture", mode: "keyword", results: [{ ...result(), passageId: "passage-a" }] }],
    });
    const directory = path.join(outputDirectory, "trec", "fixture");
    const qrelLines = (await fs.readFile(path.join(directory, "qrels.txt"), "utf8")).trim().split("\n");
    const relevantId = qrelLines.find((line) => line.endsWith(" 3"))?.split(" ")[2];
    const otherId = qrelLines.find((line) => line.endsWith(" 0"))?.split(" ")[2];
    const runId = (await fs.readFile(path.join(directory, "run-keyword.txt"), "utf8")).trim().split(" ")[2];
    expect(relevantId).toBe(runId);
    expect(otherId).not.toBe(relevantId);
  });

  it("exports TREC artifacts and verifies native metrics with both tools", async () => {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-standard-eval-"));
    temporaryDirectories.push(outputDirectory);
    const runCommand = vi.fn(async (_command: string, args: readonly string[]) => {
      const selector = args.join(" ");
      if (selector.includes("recall.5,10,20")) {
        return { stdout: "recall_5 all 1.0000\nrecall_10 all 1.0000\nrecall_20 all 1.0000\n" };
      }
      if (selector.includes("ndcg_cut.10")) return { stdout: "ndcg_cut_10 all 1.0000\n" };
      if (selector.includes("recip_rank")) return { stdout: "recip_rank all 1.0000\n" };
      return { stdout: "Judged@10 1.0000\n" };
    });

    const evaluation = await runStandardEvaluation({
      candidates: [acceptedCandidate()],
      nativeMetrics: new Map([["fixture\0keyword", perfectMetrics]]),
      outputDirectory,
      runs: [{ candidateId: "query-1", datasetId: "fixture", mode: "keyword", results: [result()] }],
      tools: { irMeasuresCommand: "ir_measures", trecEvalCommand: "trec_eval" },
    }, { runCommand });

    expect(evaluation.status).toBe("passed");
    expect(evaluation.datasets[0]?.modes[0]).toMatchObject({
      irMeasures: { judgedAt10: 1, status: "passed" },
      trecEval: { maxAbsoluteDelta: 0, status: "passed" },
    });
    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(runCommand.mock.calls.filter(([command]) => command === "trec_eval")
      .every(([, args]) => args.includes("-c"))).toBe(true);
    const directory = path.join(outputDirectory, "trec", "fixture");
    const qrels = (await fs.readFile(path.join(directory, "qrels.txt"), "utf8")).trim().split("\n");
    const relevantDocument = qrels.find((line) => line.endsWith(" 3"))?.split(" ")[2];
    const siblingDocument = qrels.find((line) => line.endsWith(" 0"))?.split(" ")[2];
    const runDocument = (await fs.readFile(path.join(directory, "run-keyword.txt"), "utf8")).trim().split(" ")[2];
    expect(relevantDocument).toMatch(/^fixture-[a-f0-9]{32}$/u);
    expect(siblingDocument).toMatch(/^fixture-[a-f0-9]{32}$/u);
    expect(siblingDocument).not.toBe(relevantDocument);
    expect(runDocument).toBe(relevantDocument);
    expect(await fs.readFile(path.join(directory, "qrels-binary.txt"), "utf8")).toMatch(/^query-1 0 fixture-[a-f0-9]{32} 1$/mu);
    expect(await fs.readFile(path.join(directory, "run-keyword.txt"), "utf8")).toMatch(/^query-1 Q0 fixture-[a-f0-9]{32} 1 20 agent-memory-keyword$/mu);
  });

  it("fails when trec_eval disagrees with native metrics", async () => {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-standard-eval-mismatch-"));
    temporaryDirectories.push(outputDirectory);

    await expect(runStandardEvaluation({
      candidates: [acceptedCandidate()],
      nativeMetrics: new Map([["fixture\0keyword", { ...perfectMetrics, latencyMs: { p50: 1 }, queries: 1 }]]),
      outputDirectory,
      runs: [{ candidateId: "query-1", datasetId: "fixture", mode: "keyword", results: [result()] }],
      tools: { irMeasuresCommand: "ir_measures", trecEvalCommand: "trec_eval" },
    }, {
      runCommand: async (_command, args) => ({
        stdout: args.includes("recip_rank") ? "recip_rank all 0.5000\n"
          : args.includes("ndcg_cut.10") ? "ndcg_cut_10 all 1.0000\n"
            : args.includes("recall.5,10,20") ? "recall_5 all 1.0000\nrecall_10 all 1.0000\nrecall_20 all 1.0000\n"
              : "Judged@10 1.0000\n",
      }),
    })).rejects.toThrow(/differ from native metrics/u);
  });

  it("checks an empty run with ir-measures and records that trec_eval was skipped", async () => {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-standard-empty-"));
    temporaryDirectories.push(outputDirectory);
    const zero = { mrrAt10: 0, ndcgAt10: 0, recallAt5: 0, recallAt10: 0, recallAt20: 0 };
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "trec_eval") throw new Error("trec_eval cannot read an empty run");
      return { stdout: args.includes("R@5")
        ? "R@5\t0.0000\nR@10\t0.0000\nR@20\t0.0000\nRR@10\t0.0000\n"
        : "nDCG@10\t0.0000\nJudged@10\t0.0000\n" };
    });
    const input = {
      candidates: [acceptedCandidate()], nativeMetrics: new Map([["fixture\0keyword", zero]]), outputDirectory,
      runs: [{ candidateId: "query-1", datasetId: "fixture", mode: "keyword" as const, results: [] }],
      tools: { irMeasuresCommand: "ir_measures", trecEvalCommand: "trec_eval" },
    };
    const evaluation = await runStandardEvaluation(input, { runCommand });
    expect(evaluation.status).toBe("passed");
    expect(evaluation.datasets[0]?.modes[0]).toMatchObject({
      trecEval: { status: "skipped_empty_run" },
      irMeasures: { status: "passed", metrics: zero, maxAbsoluteDelta: 0, judgedAt10: 0 },
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
    const args = runCommand.mock.calls.map(([, args]) => args);
    expect(args[0]?.[0]).toMatch(/qrels-binary\.txt$/u);
    expect(args[1]?.[0]).toMatch(/qrels\.txt$/u);
    expect((await fs.readFile(path.join(outputDirectory, "trec/fixture/run-keyword.txt"), "utf8")).trim()).toBe("");
    await expect(runStandardEvaluation({
      ...input, nativeMetrics: new Map([["fixture\0keyword", perfectMetrics]]),
    }, { runCommand })).rejects.toThrow(/differ from native metrics/u);
  });
});
