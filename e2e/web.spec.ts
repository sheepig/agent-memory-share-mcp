import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";
import type { FastifyInstance } from "fastify";

import type { EmbeddingProvider } from "../src/search/embedding.js";
import { writeJsonFile, writeQueryCandidates } from "../src/evaluation/files.js";
import { writeEvaluationHtmlReport } from "../src/evaluation/html-report.js";
import { buildHumanReviewServer } from "../src/evaluation/human-review.js";
import type { CandidatePool, QueryCandidate } from "../src/evaluation/types.js";
import { buildServer } from "../src/server/app.js";
import { readDaemonConfig } from "../src/server/config.js";

let app: FastifyInstance;
let baseUrl: string;
let evaluationReportFile: string;
let humanAuditFile: string;
let reviewApp: FastifyInstance;
let reviewBaseUrl: string;
let temporaryRoot: string;
const assistantReply = "Evidence location remains inspectable with the original source path, message role, position, and content fingerprint available for verification.";
const embeddingProvider: EmbeddingProvider = {
  modelId: "test-embedding-v1",
  async countContentTokens(text) {
    return [...text].length;
  },
  async embedPassages(texts) {
    return texts.map(() => Float32Array.from([1, 0]));
  },
  async embedQuery() {
    return Float32Array.from([1, 0]);
  },
};

test.beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-web-e2e-"));
  const homeDirectory = path.join(temporaryRoot, "home");
  const sessionPath = path.join(homeDirectory, ".codex/sessions/2026/10/15/session.jsonl");
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, [
    { type: "session_meta", payload: { id: "browser-session", cwd: "/workspace/evidence" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Search provenance" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: assistantReply }] } },
  ].map((record) => JSON.stringify(record)).join("\n"));

  const dataDirectory = path.join(temporaryRoot, "data");
  evaluationReportFile = path.join(temporaryRoot, "report.html");
  humanAuditFile = path.join(temporaryRoot, "human-audit.jsonl");
  await writeEvaluationHtmlReport(evaluationReportFile, {
    benchmark: { embeddingModel: "fixture-embedding", modes: ["keyword"], queryRuns: 3, querySplit: "test" },
    candidates: [{
      answer: "Source positions are retained for inspection.",
      candidateId: "candidate-browser-session",
      datasetId: "coding-sessions",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: 3, sessionId: "browser-session", startLine: 2 }],
      query: "How can a retrieval result be inspected?",
      queryType: "implementation",
      rationale: "The Session describes retained evidence locations.",
      review: {
        completeness: "complete",
        judgments: [{ endLine: 3, reason: "Direct evidence.", relevance: 3, sessionId: "browser-session", startLine: 2 }],
        reviewer: { model: "fixture", promptVersion: 1, provider: "fixture", relevanceThreshold: 2, reportedModels: ["fixture"], type: "llm" },
        status: "accepted",
      },
      split: "test",
    }],
    datasets: [{
      agent: "codex",
      databaseBytes: 4194304,
      databaseScanMs: 82,
      datasetId: "coding-sessions",
      fragments: 1,
      indexMs: 245,
      peakRssBytes: 67108864,
      searches: { keyword: { latencyMs: { p50: 3, p95: 5, p99: 7 }, mrrAt10: 1, ndcgAt10: 1, ndcgGain: "linear_graded_0_3_trec_eval", queries: 1, recallAt5: 1, recallAt10: 1, recallAt20: 1, runsPerQuery: 3 } },
      sessions: 1,
    }],
    finishedAt: "2026-10-20T01:00:00.000Z",
    inputHashes: { manifestSha256: "a".repeat(64), qrelsSha256: "b".repeat(64) },
    manifest: {
    datasets: [{
      agent: "codex",
      diagnostics: {},
      elapsedMs: 18,
      eligibleSessions: 1,
      id: "coding-sessions",
      roots: [path.dirname(sessionPath)],
      sessions: [{
        byteSize: 2048,
        chunks: [{ characters: 320, endLocation: "line:3", location: "line:2", ordinal: 0, turnCount: 1 }],
        contentFingerprint: "fixture-fingerprint",
        relativePath: "session.jsonl",
        rootIndex: 0,
        sourceId: "browser-session",
        sourcePath: sessionPath,
        updatedAt: "2026-10-19T00:00:00.000Z",
      }],
      sourceBytes: 2048,
      sourceFilesVisited: 1,
      type: "local",
    }],
    generatedAt: "2026-10-20T00:00:00.000Z",
    rules: { applicationVersion: "0.1.0", indexRuleVersion: 1, sensitiveContentRuleVersion: 1 },
    schemaVersion: 1,
    },
    qrels: { accepted: 1, rejected: 0, total: 1 },
    rules: { applicationVersion: "0.1.0", indexRuleVersion: 1, sensitiveContentRuleVersion: 1 },
    runs: [{
      candidateId: "candidate-browser-session",
      datasetId: "coding-sessions",
      latencyMs: [2, 3, 4],
      mode: "keyword",
      results: [{
        agent: "codex",
        contentFingerprint: "fixture-fingerprint",
        endLocation: "line:3",
        excerpt: assistantReply,
        fragmentId: "fragment-1",
        location: "line:2",
        matchReason: "body match",
        sessionId: "browser-session",
        sourceId: "browser-session",
        sourcePath: sessionPath,
        sourceType: "session",
        updatedAt: "2026-10-20T00:00:00.000Z",
      }],
    }],
    standardEvaluation: {
      datasets: [{ datasetId: "coding-sessions", modes: [{ irMeasures: { judgedAt10: 0.1, status: "passed" }, mode: "keyword", trecEval: { maxAbsoluteDelta: 0, metrics: { mrrAt10: 1, ndcgAt10: 1, recallAt5: 1, recallAt10: 1, recallAt20: 1 }, status: "passed" } }] }],
      irMeasuresCommand: "ir_measures",
      status: "passed",
      trecEvalCommand: "trec_eval",
    },
  });

  app = await buildServer({
    dataDirectory,
    embeddingProvider,
    homeDirectory,
    logger: false,
    publicDirectory: path.resolve("dist/public"),
    scanIntervalMs: 0,
  });
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

  const qrelsFile = path.join(temporaryRoot, "llm-reviewed-qrels.jsonl");
  const poolFile = path.join(temporaryRoot, "candidate-pool.json");
  const candidates: QueryCandidate[] = [];
  const pooledQueries: CandidatePool["queries"] = [];
  for (let index = 0; index < 50; index += 1) {
    const line = index + 1;
    const relevance = index % 4;
    const candidateId = `review-candidate-${index}`;
    const sessionId = `review-session-${index}`;
    const query = `How should retrieval evidence ${index} be assessed?`;
    candidates.push({
      answer: `Assessment answer ${index}`,
      candidateId,
      datasetId: "review-fixture",
      generatedBy: { model: "fixture", promptVersion: 1 },
      goldSpans: [{ endLine: line, sessionId, startLine: line }],
      query,
      queryType: "implementation",
      rationale: "Synthetic browser review fixture.",
      review: {
        completeness: "complete",
        judgments: [{ endLine: line, reason: "Fixture judgment.", relevance, sessionId, startLine: line }],
        reviewedAt: "2026-10-20T08:00:00.000Z",
        reviewer: { model: "fixture", promptVersion: 1, provider: "fixture", relevanceThreshold: 2, reportedModels: ["fixture"], type: "llm" },
        scope: { depth: 20, modes: ["keyword"], poolGeneratedAt: "2026-10-20T07:00:00.000Z", type: "pooled" },
        status: relevance >= 2 ? "accepted" : "rejected",
      },
    });
    pooledQueries.push({
      candidateId,
      datasetId: "review-fixture",
      query,
      results: [{ location: `line:${line}`, modes: ["keyword"], sessionId, sourcePath: `/synthetic/review-${index}.jsonl`, text: `Redacted review evidence ${index}` }],
    });
  }
  await writeQueryCandidates(qrelsFile, candidates);
  await writeJsonFile(poolFile, { depth: 20, generatedAt: "2026-10-20T07:00:00.000Z", modes: ["keyword"], queries: pooledQueries, schemaVersion: 1 } satisfies CandidatePool);
  const review = await buildHumanReviewServer({ limit: 50, outputFile: humanAuditFile, poolFile, qrelsFile, reviewer: "browser-reviewer" });
  reviewApp = review.app;
  reviewBaseUrl = await reviewApp.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await Promise.all([app?.close(), reviewApp?.close()]);
  await fs.rm(temporaryRoot, { force: true, recursive: true });
});

test("automatically indexes a session and applies exclusion and restoration", async ({ page }, testInfo) => {
  await page.goto(`${baseUrl}/sessions`);

  const session = page.locator(".session-row", { hasText: "Search provenance" });
  await expect(session).toBeVisible();
  await session.getByRole("link", { name: "查看对话 Search provenance" }).click();
  await expect(page.getByRole("heading", { name: "Search provenance" })).toBeVisible();
  await expect(page.getByText(assistantReply)).toBeVisible();
  await page.screenshot({ fullPage: true, path: testInfo.outputPath("session-detail.png") });
  await page.getByRole("link", { name: "返回 Sessions" }).click();

  const returnedSession = page.locator(".session-row", { hasText: "Search provenance" });
  await expect(returnedSession).toContainText("已参与", { timeout: 15_000 });
  await expect(returnedSession).toContainText("索引可用");
  await expect(page.getByLabel("Agent Session 片段容量")).toContainText("Codex：1 / 5000 片段");

  await returnedSession.getByRole("button", { name: "剔除 Search provenance" }).click();
  await expect(returnedSession).toContainText("已剔除");
  const excludedSearch = await page.request.get(`${baseUrl}/api/search`, { params: { mode: "keyword", query: "evidence location" } });
  expect(excludedSearch.ok()).toBe(true);
  expect((await excludedSearch.json()).results).toEqual([]);
  await returnedSession.getByRole("button", { name: "恢复 Search provenance" }).click();
  await expect(returnedSession).toContainText("已参与");
  await expect(returnedSession).toContainText("索引可用");

  await page.getByRole("link", { exact: true, name: "Search" }).click();
  await page.getByRole("combobox", { name: "检索模式" }).selectOption("hybrid");
  await page.getByRole("textbox", { name: "按项目路径筛选" }).fill("/workspace/evidence");
  await page.getByRole("searchbox", { name: "搜索证据" }).fill("evidence location");
  await page.getByRole("button", { name: "搜索" }).click();

  await expect(page.getByText(assistantReply)).toBeVisible();
  await expect(page.getByText("混合命中")).toBeVisible();
  await expect(page.locator(".evidence-provenance code")).toContainText("session.jsonl:2-3");
  await page.screenshot({ fullPage: true, path: testInfo.outputPath("search.png") });

});

test("saves the global reranker switch to the local config and restores it after reload", async ({ page }, testInfo) => {
  await page.goto(`${baseUrl}/search`);
  const toggle = page.getByRole("switch", { name: "启用本地 reranker" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("已启用", { exact: true })).toBeVisible();
  expect(readDaemonConfig(path.join(temporaryRoot, "data")).rerankerEnabled).toBe(true);
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.screenshot({ fullPage: true, path: testInfo.outputPath("reranker-settings.png") });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("已关闭", { exact: true })).toBeVisible();
  expect(readDaemonConfig(path.join(temporaryRoot, "data")).rerankerEnabled).toBe(false);
});

test("opens the standalone evaluation report and inspects one Session", async ({ page }, testInfo) => {
  await page.goto(pathToFileURL(evaluationReportFile).href);

  await expect(page.getByRole("heading", { name: "Retrieval evaluation" })).toBeVisible();
  await expect(page.getByText("trec_eval passed")).toBeVisible();
  await expect(page.locator(".session > summary").filter({ hasText: "browser-session" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How can a retrieval result be inspected?" })).toBeVisible();
  await expect(page.getByText("rel 3")).toBeVisible();
  await expect(page.getByText(assistantReply)).toHaveCount(0);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath("evaluation-report.png") });
});

test("blindly scores one of 50 human qrels cases and restores the saved audit", async ({ page }, testInfo) => {
  await page.goto(reviewBaseUrl);

  await expect(page.getByRole("heading", { name: "How should retrieval evidence 0 be assessed?" })).toBeVisible();
  await expect(page.getByText("0 / 50 已完成")).toBeVisible();
  await expect(page.getByText(/LLM 0/u)).toHaveCount(0);
  await page.getByRole("button", { name: "2 相关" }).click();

  await expect(page.getByText("已纠正 LLM 分数")).toBeVisible();
  await expect(page.getByText("人工 2 · LLM 0")).toBeVisible();
  await expect(page.getByText("1 / 50 已完成")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "How should retrieval evidence 1 be assessed?" })).toBeVisible();
  await page.getByRole("button", { name: "上一条" }).click();
  await expect(page.getByText("人工 2 · LLM 0")).toBeVisible();
  expect((await fs.readFile(humanAuditFile, "utf8")).trim().split("\n")).toHaveLength(1);
  await page.screenshot({ fullPage: true, path: testInfo.outputPath("human-qrels-review.png") });
});
