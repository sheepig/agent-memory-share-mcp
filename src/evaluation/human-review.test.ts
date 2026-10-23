import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeJsonFile, writeQueryCandidates } from "./files.js";
import { buildHumanReviewServer } from "./human-review.js";
import type { CandidatePool, QueryCandidate } from "./types.js";

const temporaryDirectories: string[] = [];

function fixture(index: number): { candidate: QueryCandidate; pooled: CandidatePool["queries"][number] } {
  const line = index + 1;
  const relevance = index % 4;
  const candidateId = `candidate-${index}`;
  const sessionId = `session-${index}`;
  const query = `How is evidence ${index} handled?`;
  return {
    candidate: {
      answer: `Evidence answer ${index}`,
      candidateId,
      datasetId: "fixture",
      generatedBy: { model: "query-model", promptVersion: 1 },
      goldSpans: [{ endLine: line, sessionId, startLine: line }],
      query,
      queryType: "implementation",
      rationale: "Synthetic human review fixture.",
      review: {
        completeness: "complete",
        judgments: [{ endLine: line, reason: `LLM reason ${index}`, relevance, sessionId, startLine: line }],
        reviewedAt: "2026-10-20T08:00:00.000Z",
        reviewer: {
          model: "judge-model",
          promptVersion: 1,
          provider: "fixture",
          relevanceThreshold: 2,
          reportedModels: ["judge-model"],
          type: "llm",
        },
        scope: {
          depth: 20,
          modes: ["keyword"],
          poolGeneratedAt: "2026-10-20T07:00:00.000Z",
          type: "pooled",
        },
        status: relevance >= 2 ? "accepted" : "rejected",
      },
    },
    pooled: {
      candidateId,
      datasetId: "fixture",
      query,
      results: [{
        location: `line:${line}`,
        modes: ["keyword"],
        sessionId,
        sourcePath: `/synthetic/session-${index}.jsonl`,
        text: `Synthetic redacted evidence ${index}`,
      }],
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("human qrels review", () => {
  it("keeps same-index passages from different variants as separate audit cases", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-human-ablation-"));
    temporaryDirectories.push(root);
    const { candidate, pooled } = fixture(0);
    candidate.review.status = "accepted";
    candidate.review.judgments = [
      { chunkIndex: 0, endLine: 1, passageId: "passage-a", reason: "Relevant.", relevance: 3, sessionId: "session-0", startLine: 1 },
      { chunkIndex: 0, endLine: 1, passageId: "passage-b", reason: "Unrelated.", relevance: 0, sessionId: "session-0", startLine: 1 },
    ];
    pooled.results = [
      { chunkIndex: 0, location: "line:1", modes: ["keyword"], passageId: "passage-a", sessionId: "session-0", sourcePath: "/synthetic/session-0.jsonl", text: "Relevant passage." },
      { chunkIndex: 0, location: "line:1", modes: ["keyword"], passageId: "passage-b", sessionId: "session-0", sourcePath: "/synthetic/session-0.jsonl", text: "Unrelated passage." },
    ];
    const qrelsFile = path.join(root, "qrels.jsonl");
    const poolFile = path.join(root, "pool.json");
    await Promise.all([
      writeQueryCandidates(qrelsFile, [candidate]),
      writeJsonFile(poolFile, { depth: 20, generatedAt: "2026-10-20T07:00:00.000Z", modes: ["keyword"], queries: [pooled], schemaVersion: 1 } satisfies CandidatePool),
    ]);
    const server = await buildHumanReviewServer({ limit: 2, outputFile: path.join(root, "audit.jsonl"), poolFile, qrelsFile, reviewer: "fixture" });
    const response = await server.app.inject({ method: "GET", url: "/api/review" });
    const cases = response.json().cases as Array<{ auditId: string }>;
    expect(cases).toHaveLength(2);
    expect(cases[0]?.auditId).not.toBe(cases[1]?.auditId);
    await server.app.close();
  });

  it("prepares 50 blind cases, persists a score separately, and resumes progress", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-human-review-"));
    temporaryDirectories.push(root);
    const qrelsFile = path.join(root, "llm-reviewed-qrels.jsonl");
    const poolFile = path.join(root, "candidate-pool.json");
    const outputFile = path.join(root, "human-audit.jsonl");
    const fixtures = Array.from({ length: 56 }, (_, index) => fixture(index));
    await writeQueryCandidates(qrelsFile, fixtures.map(({ candidate }) => candidate));
    await writeJsonFile(poolFile, {
      depth: 20,
      generatedAt: "2026-10-20T07:00:00.000Z",
      modes: ["keyword"],
      queries: fixtures.map(({ pooled }) => pooled),
      schemaVersion: 1,
    } satisfies CandidatePool);
    const originalQrels = await fs.readFile(qrelsFile, "utf8");

    const first = await buildHumanReviewServer({ limit: 50, outputFile, poolFile, qrelsFile, reviewer: "reviewer" });
    const initial = await first.app.inject({ method: "GET", url: "/api/review" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ completed: 0, reviewer: "reviewer", total: 50 });
    expect(initial.json().cases).toHaveLength(50);
    expect(initial.json().cases[0]).not.toHaveProperty("llmRelevance");

    const auditId = initial.json().cases[0].auditId as string;
    const saved = await first.app.inject({
      method: "POST",
      payload: { relevance: 2 },
      url: `/api/judgments/${auditId}`,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ humanRelevance: 2, llmRelevance: 0, status: "corrected" });
    expect(await fs.readFile(qrelsFile, "utf8")).toBe(originalQrels);
    const records = (await fs.readFile(outputFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      auditId,
      human: { relevance: 2, reviewer: "reviewer" },
      original: { relevance: 0, reviewer: { model: "judge-model", provider: "fixture", type: "llm" } },
      status: "corrected",
    });
    await first.app.close();

    const resumed = await buildHumanReviewServer({ limit: 50, outputFile, poolFile, qrelsFile, reviewer: "reviewer" });
    const state = await resumed.app.inject({ method: "GET", url: "/api/review" });
    expect(state.json()).toMatchObject({ completed: 1, total: 50 });
    expect(state.json().cases[0]).toMatchObject({ humanRelevance: 2, llmRelevance: 0, status: "corrected" });
    await resumed.app.close();
  });

  it("rejects scores outside the graded relevance scale", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-human-review-invalid-"));
    temporaryDirectories.push(root);
    const qrelsFile = path.join(root, "llm-reviewed-qrels.jsonl");
    const poolFile = path.join(root, "candidate-pool.json");
    const fixtures = Array.from({ length: 50 }, (_, index) => fixture(index));
    await writeQueryCandidates(qrelsFile, fixtures.map(({ candidate }) => candidate));
    await writeJsonFile(poolFile, {
      depth: 20,
      generatedAt: "2026-10-20T07:00:00.000Z",
      modes: ["keyword"],
      queries: fixtures.map(({ pooled }) => pooled),
      schemaVersion: 1,
    } satisfies CandidatePool);
    const server = await buildHumanReviewServer({
      limit: 50,
      outputFile: path.join(root, "human-audit.jsonl"),
      poolFile,
      qrelsFile,
      reviewer: "reviewer",
    });
    const state = await server.app.inject({ method: "GET", url: "/api/review" });
    const response = await server.app.inject({
      method: "POST",
      payload: { relevance: 4 },
      url: `/api/judgments/${state.json().cases[0].auditId}`,
    });
    expect(response.statusCode).toBe(400);
    await server.app.close();
    await expect(buildHumanReviewServer({
      limit: 50,
      outputFile: qrelsFile,
      poolFile,
      qrelsFile,
      reviewer: "reviewer",
    })).rejects.toThrow(/output must be separate/u);
  });
});
