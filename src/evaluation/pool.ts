import path from "node:path";

import { createSourceService } from "../application/source-service.js";
import type { IndexDocument, SourceReference } from "../domain/source.js";
import { LocalContentTokenizer, LocalEmbeddingProvider } from "../search/embedding.js";
import { openDatabase } from "../storage/database.js";
import { ManifestSessionAdapter, validateCandidatesAgainstManifest } from "./benchmark.js";
import { readQueryCandidates, writeJsonFile } from "./files.js";
import { validateEvaluationManifest } from "./manifest-validation.js";
import type { CandidatePool, EvaluationConfig, EvaluationManifest } from "./types.js";

const POOL_DEPTH = 20;

type PoolResult = CandidatePool["queries"][number]["results"][number];

function lineNumber(location: string | undefined): number | undefined {
  const match = /^line:(\d+)$/u.exec(location ?? "");
  return match ? Number(match[1]) : undefined;
}

function overlaps(document: IndexDocument, span: { chunkIndex?: number; endLine: number; startLine: number }): boolean {
  const start = lineNumber(document.location);
  const end = lineNumber(document.endLocation) ?? start;
  return Boolean(
    start
    && end
    && (span.chunkIndex === undefined || span.chunkIndex === document.chunkIndex)
    && start <= span.endLine
    && end >= span.startLine,
  );
}

function evidenceKey(sessionId: string, document: IndexDocument): string {
  return `${sessionId}\0${document.location}\0${document.endLocation ?? document.location}\0${document.chunkIndex ?? 0}`;
}

function referenceFor(
  dataset: EvaluationManifest["datasets"][number],
  session: EvaluationManifest["datasets"][number]["sessions"][number],
): SourceReference {
  return {
    agent: dataset.agent,
    contentFingerprint: session.contentFingerprint,
    projectPath: session.projectPath,
    sourceId: session.sourceId,
    sourcePath: session.sourcePath,
    sourceType: "session",
    title: session.title,
    updatedAt: new Date(session.updatedAt),
  };
}

function pooledResult(sessionId: string, document: IndexDocument, mode: PoolResult["modes"][number], fragmentId?: string): PoolResult {
  return {
    ...(document.chunkIndex !== undefined ? { chunkIndex: document.chunkIndex } : {}),
    ...(document.contentTokenCount !== undefined ? { contentTokenCount: document.contentTokenCount } : {}),
    ...(document.endLocation ? { endLocation: document.endLocation } : {}),
    ...(document.endNativeEventId ? { endNativeEventId: document.endNativeEventId } : {}),
    ...(fragmentId ? { fragmentId } : {}),
    location: document.location,
    modes: [mode],
    ...(document.nativeEventId ? { nativeEventId: document.nativeEventId } : {}),
    sessionId,
    sourcePath: document.source.sourcePath,
    text: document.body,
  };
}

function addResult(results: Map<string, PoolResult>, result: PoolResult): void {
  const key = `${result.sessionId}\0${result.location}\0${result.endLocation ?? result.location}\0${result.chunkIndex ?? 0}`;
  const existing = results.get(key);
  if (!existing) {
    results.set(key, result);
    return;
  }
  result.modes.forEach((mode) => {
    if (!existing.modes.includes(mode)) existing.modes.push(mode);
  });
  if (!existing.fragmentId && result.fragmentId) existing.fragmentId = result.fragmentId;
}

export async function buildCandidatePool(
  config: EvaluationConfig,
  manifest: EvaluationManifest,
  candidatesFile: string,
): Promise<{ outputFile: string; queries: number }> {
  await validateEvaluationManifest(config, manifest);
  const candidates = await readQueryCandidates(candidatesFile);
  validateCandidatesAgainstManifest(candidates, manifest);
  const runId = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runDirectory = path.join(config.outputDirectory, `pool-${runId}`);
  const pooled = [];
  for (const dataset of manifest.datasets) {
    const requiresEmbeddings = config.benchmark.modes.some((mode) => mode !== "keyword");
    const embeddingProvider = requiresEmbeddings
      ? new LocalEmbeddingProvider(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"))
      : undefined;
    const contentTokenCounter = embeddingProvider
      ?? new LocalContentTokenizer(config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"));
    const database = openDatabase(path.join(runDirectory, dataset.id));
    const adapter = new ManifestSessionAdapter(dataset, contentTokenCounter);
    const service = createSourceService(database, {
      adapters: { memories: [], sessions: [adapter] },
      contentTokenCounter,
      embeddingProvider,
      homeDirectory: "",
    });
    try {
      const documentsBySession = new Map<string, IndexDocument[]>();
      const documentsByLocation = new Map<string, IndexDocument>();
      for (const session of dataset.sessions) {
        const documents: IndexDocument[] = [];
        for await (const document of adapter.extract(referenceFor(dataset, session))) {
          documents.push(document);
          documentsByLocation.set(evidenceKey(session.sourceId, document), document);
        }
        documentsBySession.set(session.sourceId, documents);
      }
      await service.scanSources();
      for (let offset = 0; ; offset += 200) {
        const page = await service.listSessions({ agent: dataset.agent, limit: 200, offset });
        for (const session of page.sessions) await service.indexSession(session.candidateId);
        if (offset + page.sessions.length >= page.total) break;
      }
      for (const candidate of candidates.filter((value) => value.datasetId === dataset.id
        && value.queryQuality?.status !== "rejected" && value.review.status !== "rejected")) {
        const results = new Map<string, PoolResult>();
        for (const span of candidate.goldSpans) {
          const matches = (documentsBySession.get(span.sessionId) ?? []).filter((document) => overlaps(document, span));
          if (matches.length === 0) throw new Error(`Gold span is outside extracted chunks: ${candidate.candidateId}/${span.sessionId}:${span.startLine}-${span.endLine}`);
          matches.forEach((document) => addResult(results, pooledResult(span.sessionId, document, "seed")));
        }
        for (const mode of config.benchmark.modes) {
          const response = await service.searchFragments({ agent: dataset.agent, limit: POOL_DEPTH, mode, query: candidate.query, sourceType: "session" });
          response.results.forEach((result) => {
            if (!result.sessionId) throw new Error(`Pooled Session result has no session ID: ${result.fragmentId}`);
            const key = `${result.sessionId}\0${result.location}\0${result.endLocation ?? result.location}\0${result.chunkIndex ?? 0}`;
            const document = documentsByLocation.get(key);
            if (!document) throw new Error(`Pooled result has no extracted chunk: ${key}`);
            addResult(results, pooledResult(result.sessionId, document, mode, result.fragmentId));
          });
        }
        pooled.push({ candidateId: candidate.candidateId, datasetId: dataset.id, query: candidate.query, results: [...results.values()] });
      }
    } finally {
      database.close();
    }
  }
  const outputFile = path.join(runDirectory, "candidate-pool.json");
  await writeJsonFile(outputFile, {
    depth: POOL_DEPTH,
    generatedAt: new Date().toISOString(),
    modes: config.benchmark.modes,
    queries: pooled,
    schemaVersion: 1,
  } satisfies CandidatePool);
  return { outputFile, queries: pooled.length };
}
