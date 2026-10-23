import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { readCandidatePool, readQueryCandidates } from "./files.js";
import { humanReviewHtml } from "./human-review-html.js";
import type { CandidatePool, QueryCandidate } from "./types.js";

const scoreSchema = z.object({ relevance: z.number().int().min(0).max(3) }).strict();

const humanAuditRecordSchema = z.object({
  auditId: z.string().length(64),
  candidateId: z.string(),
  datasetId: z.string(),
  evidence: z.object({
    chunkIndex: z.number().int().nonnegative().optional(),
    endLine: z.number().int().positive(),
    passageId: z.string().min(1).optional(),
    sessionId: z.string(),
    sourcePath: z.string(),
    startLine: z.number().int().positive(),
  }),
  human: z.object({
    relevance: z.number().int().min(0).max(3),
    reviewedAt: z.string(),
    reviewer: z.string().min(1),
  }),
  original: z.object({
    reason: z.string(),
    relevance: z.number().int().min(0).max(3),
    reviewedAt: z.string(),
    reviewer: z.object({
      model: z.string(),
      promptVersion: z.number().int().positive(),
      provider: z.string(),
      relevanceThreshold: z.number().int().min(1).max(3),
      reportedModels: z.array(z.string()),
      type: z.literal("llm"),
    }),
  }),
  poolGeneratedAt: z.string(),
  poolSha256: z.string().length(64),
  qrelsSha256: z.string().length(64),
  schemaVersion: z.literal(1),
  status: z.enum(["confirmed", "corrected"]),
});

type HumanAuditRecord = z.infer<typeof humanAuditRecordSchema>;

interface HumanReviewCase {
  auditId: string;
  candidateId: string;
  datasetId: string;
  evidence: CandidatePool["queries"][number]["results"][number];
  original: {
    reason: string;
    relevance: number;
    reviewedAt: string;
    reviewer: Extract<NonNullable<QueryCandidate["review"]["reviewer"]>, { type: "llm" }>;
  };
  query: string;
  queryType: QueryCandidate["queryType"];
}

export interface HumanReviewServerOptions {
  limit: number;
  outputFile: string;
  poolFile: string;
  qrelsFile: string;
  reviewer: string;
}

export interface HumanReviewServer {
  app: FastifyInstance;
  completed: number;
  outputFile: string;
  total: number;
}

function lineNumber(location: string): number {
  const match = /^line:(\d+)$/u.exec(location);
  if (!match) throw new Error(`Human review requires line provenance, received: ${location}`);
  return Number(match[1]);
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function auditId(candidateId: string, sessionId: string, startLine: number, endLine: number, chunkIndex?: number, passageId?: string): string {
  return createHash("sha256")
    .update(passageId
      ? `${candidateId}\0passage\0${passageId}`
      : `${candidateId}\0${sessionId}\0${startLine}\0${endLine}\0${chunkIndex ?? "legacy"}`)
    .digest("hex");
}

function allCases(candidates: readonly QueryCandidate[], pool: CandidatePool): HumanReviewCase[] {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  return pool.queries.flatMap((pooled) => {
    const candidate = candidatesById.get(pooled.candidateId);
    if (!candidate || candidate.datasetId !== pooled.datasetId || candidate.query !== pooled.query) {
      throw new Error(`Candidate pool does not match LLM qrels: ${pooled.candidateId}`);
    }
    const reviewer = candidate.review.reviewer;
    const reviewedAt = candidate.review.reviewedAt;
    const judgments = candidate.review.judgments;
    if (typeof reviewer !== "object" || reviewer.type !== "llm" || !reviewedAt || !judgments) {
      throw new Error(`Human review requires complete LLM judgments: ${pooled.candidateId}`);
    }
    return pooled.results.map((result) => {
      const startLine = lineNumber(result.location);
      const endLine = lineNumber(result.endLocation ?? result.location);
      const judgment = judgments.find((value) => value.sessionId === result.sessionId
        && value.startLine === startLine && value.endLine === endLine
        && (result.passageId ? value.passageId === result.passageId : value.chunkIndex === result.chunkIndex));
      if (!judgment) throw new Error(`LLM qrels are missing pooled evidence: ${pooled.candidateId}/${result.sessionId}:${startLine}-${endLine}`);
      return {
        auditId: auditId(candidate.candidateId, result.sessionId, startLine, endLine, result.chunkIndex, result.passageId),
        candidateId: candidate.candidateId,
        datasetId: candidate.datasetId,
        evidence: result,
        original: {
          reason: judgment.reason,
          relevance: judgment.relevance,
          reviewedAt,
          reviewer,
        },
        query: candidate.query,
        queryType: candidate.queryType,
      };
    });
  });
}

function stratifiedCases(cases: readonly HumanReviewCase[], limit: number): HumanReviewCase[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("Human review limit must be a positive integer.");
  if (cases.length < limit) throw new Error(`Human review requested ${limit} cases, but only ${cases.length} complete LLM judgments are available.`);
  const buckets = [0, 1, 2, 3].map((relevance) => cases.filter((entry) => entry.original.relevance === relevance));
  const selected: HumanReviewCase[] = [];
  while (selected.length < limit) {
    let advanced = false;
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next) {
        selected.push(next);
        advanced = true;
        if (selected.length === limit) break;
      }
    }
    if (!advanced) break;
  }
  return selected;
}

async function readAuditRecords(file: string): Promise<HumanAuditRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return humanAuditRecordSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid human audit record at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function writeAuditRecords(file: string, records: readonly HumanAuditRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
  await fs.rename(temporary, file);
}

function publicCase(entry: HumanReviewCase, record?: HumanAuditRecord) {
  return {
    auditId: entry.auditId,
    candidateId: entry.candidateId,
    datasetId: entry.datasetId,
    evidence: {
      ...(entry.evidence.endLocation ? { endLocation: entry.evidence.endLocation } : {}),
      location: entry.evidence.location,
      modes: entry.evidence.modes,
      sessionId: entry.evidence.sessionId,
      sourcePath: entry.evidence.sourcePath,
      text: entry.evidence.text,
    },
    ...(record ? {
      humanRelevance: record.human.relevance,
      llmRelevance: record.original.relevance,
      reviewedAt: record.human.reviewedAt,
      status: record.status,
    } : {}),
    query: entry.query,
    queryType: entry.queryType,
  };
}

export async function buildHumanReviewServer(options: HumanReviewServerOptions): Promise<HumanReviewServer> {
  if (!options.reviewer.trim()) throw new Error("Human reviewer name is required.");
  const outputPath = path.resolve(options.outputFile);
  if ([options.qrelsFile, options.poolFile].some((file) => path.resolve(file) === outputPath)) {
    throw new Error("Human audit output must be separate from the silver qrels and candidate pool.");
  }
  const [candidates, pool, qrelsSha256, poolSha256] = await Promise.all([
    readQueryCandidates(options.qrelsFile),
    readCandidatePool(options.poolFile),
    sha256(options.qrelsFile),
    sha256(options.poolFile),
  ]);
  const cases = stratifiedCases(allCases(candidates, pool), options.limit);
  const casesById = new Map(cases.map((entry) => [entry.auditId, entry]));
  const prior = await readAuditRecords(options.outputFile);
  for (const record of prior) {
    if (!casesById.has(record.auditId) || record.qrelsSha256 !== qrelsSha256 || record.poolSha256 !== poolSha256) {
      throw new Error("Existing human audit does not match the selected qrels, pool, or 50-case sample.");
    }
    if (record.human.reviewer !== options.reviewer) throw new Error("Existing human audit belongs to a different reviewer.");
  }
  const records = new Map(prior.map((record) => [record.auditId, record]));
  const app = fastify({ logger: false });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(humanReviewHtml()));
  app.get("/api/review", async () => ({
    cases: cases.map((entry) => publicCase(entry, records.get(entry.auditId))),
    completed: records.size,
    reviewer: options.reviewer,
    total: cases.length,
  }));
  app.post<{ Params: { auditId: string } }>("/api/judgments/:auditId", async (request, reply) => {
    const parsed = scoreSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "relevance must be an integer from 0 through 3" });
    const entry = casesById.get(request.params.auditId);
    if (!entry) return reply.code(404).send({ error: "unknown human review case" });
    const record: HumanAuditRecord = {
      auditId: entry.auditId,
      candidateId: entry.candidateId,
      datasetId: entry.datasetId,
      evidence: {
        ...(entry.evidence.chunkIndex !== undefined ? { chunkIndex: entry.evidence.chunkIndex } : {}),
        endLine: lineNumber(entry.evidence.endLocation ?? entry.evidence.location),
        ...(entry.evidence.passageId ? { passageId: entry.evidence.passageId } : {}),
        sessionId: entry.evidence.sessionId,
        sourcePath: entry.evidence.sourcePath,
        startLine: lineNumber(entry.evidence.location),
      },
      human: {
        relevance: parsed.data.relevance,
        reviewedAt: new Date().toISOString(),
        reviewer: options.reviewer,
      },
      original: entry.original,
      poolGeneratedAt: pool.generatedAt,
      poolSha256,
      qrelsSha256,
      schemaVersion: 1,
      status: parsed.data.relevance === entry.original.relevance ? "confirmed" : "corrected",
    };
    records.set(entry.auditId, record);
    await writeAuditRecords(options.outputFile, cases.flatMap((value) => {
      const saved = records.get(value.auditId);
      return saved ? [saved] : [];
    }));
    return publicCase(entry, record);
  });
  return { app, completed: records.size, outputFile: options.outputFile, total: cases.length };
}

export async function startHumanReviewServer(options: HumanReviewServerOptions & { port: number }): Promise<HumanReviewServer & { url: string }> {
  const server = await buildHumanReviewServer(options);
  const shutdown = async () => {
    await server.app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.app.addHook("onClose", async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  });
  try {
    await server.app.listen({ host: "127.0.0.1", port: options.port });
  } catch (error) {
    await server.app.close();
    throw error;
  }
  return { ...server, url: `http://127.0.0.1:${options.port}/` };
}
