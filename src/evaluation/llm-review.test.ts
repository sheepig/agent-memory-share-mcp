import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validateReviewedCandidates } from "./benchmark.js";
import { readQueryCandidates, writeJsonFile, writeQueryCandidates } from "./files.js";
import { reviewQrelsWithLlm } from "./llm-review.js";
import { evaluationConfigSchema, type CandidatePool, type QueryCandidate } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("LLM qrels review", () => {
  it("retries invalid response types and keeps distinct passage judgments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-llm-ablation-"));
    temporaryDirectories.push(root);
    const tokenFile = path.join(root, "token");
    const candidatesFile = path.join(root, "candidates.jsonl");
    const poolFile = path.join(root, "pool.json");
    const outputFile = path.join(root, "qrels.jsonl");
    await fs.writeFile(tokenFile, "fixture-secret", { mode: 0o600 });
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture", roots: [root], type: "local" }],
      outputDirectory: root,
      qrelReview: { apiKeyFile: tokenFile, baseUrl: "https://example.test", datasetIds: ["fixture"], model: "fixture", provider: "fixture" },
      schemaVersion: 1,
    });
    const candidate: QueryCandidate = {
      answer: "Answer",
      candidateId: "query-1",
      datasetId: "fixture",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 3, sessionId: "session", startLine: 2 }],
      query: "Where is the answer?",
      queryType: "implementation",
      rationale: "Synthetic evidence.",
      review: { completeness: "unchecked", status: "pending" },
    };
    const pool: CandidatePool = {
      chunkAblation: {
        manifestSha256: "a".repeat(64),
        queriesSha256: "b".repeat(64),
        variants: [
          { id: "small", maxContentTokens: 40, overlapContentTokens: 0 },
          { id: "large", maxContentTokens: 80, overlapContentTokens: 10 },
        ],
      },
      depth: 20,
      generatedAt: "2026-10-21T00:00:00.000Z",
      modes: ["keyword"],
      queries: [{ candidateId: "query-1", datasetId: "fixture", query: candidate.query, results: [
        { chunkIndex: 0, endLocation: "line:3", location: "line:2", modes: ["keyword"], passageId: "passage-a", sessionId: "session", sourcePath: path.join(root, "session.jsonl"), text: "Direct answer.", variantIds: ["small"] },
        { chunkIndex: 0, endLocation: "line:3", location: "line:2", modes: ["keyword"], passageId: "passage-b", sessionId: "session", sourcePath: path.join(root, "session.jsonl"), text: "Unrelated text.", variantIds: ["large"] },
      ] }],
      schemaVersion: 1,
    };
    await Promise.all([writeQueryCandidates(candidatesFile, [candidate]), writeJsonFile(poolFile, pool)]);
    let invalidResponseSent = false;
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const passage = (JSON.parse(body.messages[1]!.content) as { passage: string }).passage;
      const relevance = passage.includes("Direct") ? (invalidResponseSent ? 3 : "3") : 0;
      if (passage.includes("Direct")) invalidResponseSent = true;
      return new Response(JSON.stringify({
        choices: [{ index: 0, message: { content: JSON.stringify({ reason: "fixture", relevance }), role: "assistant" } }],
        created: 1,
        id: "fixture",
        model: "fixture",
        object: "chat.completion",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    });

    await reviewQrelsWithLlm(config, candidatesFile, poolFile, "fixture instructions", outputFile, { fetch: mockFetch });
    const reviewed = (await readQueryCandidates(outputFile))[0]!;
    expect(reviewed.review.judgments).toEqual(expect.arrayContaining([
      expect.objectContaining({ chunkIndex: 0, passageId: "passage-a", relevance: 3 }),
      expect.objectContaining({ chunkIndex: 0, passageId: "passage-b", relevance: 0 }),
    ]));
    expect(reviewed.review.scope?.poolSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const invalidFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ index: 0, message: { content: JSON.stringify({ reason: "fixture", relevance: "3" }), role: "assistant" } }],
      created: 1, id: "fixture", model: "fixture", object: "chat.completion",
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    await expect(reviewQrelsWithLlm(config, candidatesFile, poolFile, "fixture instructions", path.join(root, "invalid.jsonl"), {
      fetch: invalidFetch,
    })).rejects.toThrow();
    // At most three attempts for each of the two independent passages.
    expect(invalidFetch.mock.calls.length).toBeLessThanOrEqual(6);
    await expect(fs.access(path.join(root, "invalid.jsonl"))).rejects.toThrow();
  });

  it("uses a configured token file and writes auditable pooled judgments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-llm-review-"));
    temporaryDirectories.push(root);
    const tokenFile = path.join(root, "deepseek-token");
    const candidatesFile = path.join(root, "candidates.jsonl");
    const poolFile = path.join(root, "pool.json");
    const outputFile = path.join(root, "reviewed.jsonl");
    await fs.writeFile(tokenFile, "test-secret\n", { mode: 0o600 });
    const config = evaluationConfigSchema.parse({
      datasets: [{ agent: "codex", id: "fixture-codex", roots: [root], type: "local" }],
      outputDirectory: root,
      qrelReview: {
        apiKeyFile: tokenFile,
        baseUrl: "https://deepseek.test",
        concurrency: 2,
        datasetIds: ["fixture-codex"],
        model: "deepseek-test",
        provider: "deepseek",
        relevanceThreshold: 2,
      },
      schemaVersion: 1,
    });
    const candidate: QueryCandidate = {
      answer: "The implementation uses deterministic indexing.",
      candidateId: "candidate-1",
      datasetId: "fixture-codex",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ chunkIndex: 0, endLine: 3, sessionId: "session-1", startLine: 2 }],
      query: "How is indexing implemented?",
      queryType: "implementation",
      rationale: "The seed evidence discusses indexing.",
      review: { completeness: "unchecked", status: "pending" },
    };
    const pool: CandidatePool = {
      depth: 20,
      generatedAt: "2026-01-01T00:00:00.000Z",
      modes: ["keyword"],
      queries: [{
        candidateId: candidate.candidateId,
        datasetId: candidate.datasetId,
        query: candidate.query,
        results: [
          {
            chunkIndex: 0,
            endLocation: "line:3",
            location: "line:2",
            modes: ["seed", "keyword"],
            sessionId: "session-1",
            sourcePath: path.join(root, "session-1.jsonl"),
            text: "This passage explains deterministic indexing.",
          },
          {
            chunkIndex: 1,
            endLocation: "line:3",
            location: "line:2",
            modes: ["keyword"],
            sessionId: "session-1",
            sourcePath: path.join(root, "session-1.jsonl"),
            text: "This passage is unrelated.",
          },
        ],
      }],
      schemaVersion: 1,
    };
    await Promise.all([writeQueryCandidates(candidatesFile, [candidate]), writeJsonFile(poolFile, pool)]);
    const requestBodies: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestBodies.push(body);
      const messages = body.messages as Array<{ content: string }>;
      const input = JSON.parse(messages[1]!.content) as { passage: string };
      const relevant = input.passage.includes("deterministic");
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", index: 0, message: { content: JSON.stringify({ reason: relevant ? "direct evidence" : "unrelated", relevance: relevant ? 3 : 0 }), role: "assistant" } }],
        created: 1,
        id: "completion-1",
        model: "deepseek-reported",
        object: "chat.completion",
      }), { headers: { "content-type": "application/json" }, status: 200 });
    });

    const result = await reviewQrelsWithLlm(config, candidatesFile, poolFile, "test instructions", outputFile, { fetch: mockFetch });
    const reviewed = (await readQueryCandidates(outputFile))[0]!;

    expect(result).toMatchObject({ accepted: 1, rejected: 0, reviewed: 1 });
    expect(reviewed.goldSpans).toEqual([{ chunkIndex: 0, endLine: 3, sessionId: "session-1", startLine: 2 }]);
    expect(reviewed.review).toMatchObject({
      completeness: "complete",
      reviewer: { model: "deepseek-test", provider: "deepseek", relevanceThreshold: 2, reportedModels: ["deepseek-reported"], type: "llm" },
      scope: { depth: 20, modes: ["keyword"], poolGeneratedAt: pool.generatedAt, type: "pooled" },
      status: "accepted",
    });
    expect(reviewed.review.judgments).toHaveLength(2);
    expect(reviewed.review.judgments).toEqual(expect.arrayContaining([
      expect.objectContaining({ chunkIndex: 0, relevance: 3 }),
      expect.objectContaining({ chunkIndex: 1, relevance: 0 }),
    ]));
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({ response_format: { type: "json_object" }, thinking: { type: "disabled" } });
    expect(await fs.readFile(outputFile, "utf8")).not.toContain("test-secret");
    expect(() => validateReviewedCandidates([reviewed])).not.toThrow();
  });
});
