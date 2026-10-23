import fs from "node:fs/promises";
import path from "node:path";

import { createSourceService } from "../application/source-service.js";
import { LocalContentTokenizer, LocalEmbeddingProvider } from "../search/embedding.js";
import type { SourceScanResult } from "../application/source-service.js";
import { openDatabase, type AppDatabase } from "../storage/database.js";
import { ManifestSessionAdapter } from "./benchmark.js";
import { passageIdFor } from "./identity.js";
import type { ChunkVariant, EvaluationConfig, EvaluationManifestDataset } from "./types.js";

export interface IndexedPassage {
  body: string;
  chunkIndex?: number;
  contentTokenCount?: number;
  endLocation: string;
  fragmentId: string;
  location: string;
  passageId: string;
  sessionId: string;
  sourcePath: string;
}

export interface ChunkVariantIndex {
  close(): void;
  database: AppDatabase;
  passages: IndexedPassage[];
  peakRssBytes(): number;
  scan: SourceScanResult;
  search(query: string, mode: EvaluationConfig["benchmark"]["modes"][number]): ReturnType<ReturnType<typeof createSourceService>["searchFragments"]>;
  summary: {
    databaseBytes: number;
    databaseScanMs: number;
    fragments: number;
    indexMs: number;
    peakRssBytes: number;
    sessions: number;
  };
}

function indexedPassages(database: AppDatabase, datasetId: string): IndexedPassage[] {
  const rows = database.prepare(`
    SELECT f.id AS fragmentId, f.body, f.chunk_index AS chunkIndex,
           f.content_tokens AS contentTokenCount, f.location,
           f.end_location AS endLocation, s.external_source_id AS sessionId,
           s.source_path AS sourcePath
    FROM fragments f JOIN sources s ON s.id = f.source_id
    WHERE s.source_type = 'session' AND s.disposition = 'selected'
    ORDER BY s.external_source_id, f.ordinal
  `).all() as Array<{
    body: string;
    chunkIndex: number | null;
    contentTokenCount: number | null;
    endLocation: string | null;
    fragmentId: string;
    location: string;
    sessionId: string;
    sourcePath: string;
  }>;
  return rows.map((row) => ({
    body: row.body,
    ...(row.chunkIndex !== null ? { chunkIndex: row.chunkIndex } : {}),
    ...(row.contentTokenCount !== null ? { contentTokenCount: row.contentTokenCount } : {}),
    endLocation: row.endLocation ?? row.location,
    fragmentId: row.fragmentId,
    location: row.location,
    passageId: passageIdFor(datasetId, row.sessionId, row.location, row.endLocation ?? row.location, row.body),
    sessionId: row.sessionId,
    sourcePath: row.sourcePath,
  }));
}

export async function openChunkVariantIndex(
  config: EvaluationConfig,
  dataset: EvaluationManifestDataset,
  variant: ChunkVariant,
  dataDirectory: string,
): Promise<ChunkVariantIndex> {
  const database = openDatabase(dataDirectory);
  let peakRssBytes = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 25);
  try {
    const cacheDirectory = config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache");
    const embeddingProvider = config.benchmark.modes.some((mode) => mode !== "keyword")
      ? new LocalEmbeddingProvider(cacheDirectory)
      : undefined;
    const contentTokenCounter = embeddingProvider ?? new LocalContentTokenizer(cacheDirectory);
    const adapter = new ManifestSessionAdapter(dataset, contentTokenCounter, variant);
    const service = createSourceService(database, {
      adapters: { memories: [], sessions: [adapter] },
      contentTokenCounter,
      embeddingProvider,
      homeDirectory: "",
    });
    const scanStarted = performance.now();
    const scan = await service.scanSources();
    const databaseScanMs = performance.now() - scanStarted;
    const sessions = [];
    for (let offset = 0; ; offset += 200) {
      const page = await service.listSessions({ agent: dataset.agent, limit: 200, offset });
      sessions.push(...page.sessions);
      if (sessions.length >= page.total) break;
    }
    const indexStarted = performance.now();
    let fragments = 0;
    for (const session of sessions) {
      const indexed = await service.indexSession(session.candidateId);
      fragments += indexed.fragmentCount;
    }
    const indexMs = performance.now() - indexStarted;
    const passages = indexedPassages(database, dataset.id);
    database.pragma("wal_checkpoint(TRUNCATE)");
    const databaseBytes = (await fs.stat(path.join(dataDirectory, "agent-memory.sqlite"))).size;
    return {
      close() {
        clearInterval(sampler);
        database.close();
      },
      database,
      passages,
      peakRssBytes: () => Math.max(peakRssBytes, process.memoryUsage().rss),
      scan,
      search: (query, mode) => service.searchFragments({ agent: dataset.agent, limit: 20, mode, query, sourceType: "session" }),
      summary: { databaseBytes, databaseScanMs, fragments, indexMs, peakRssBytes, sessions: sessions.length },
    };
  } catch (error) {
    clearInterval(sampler);
    database.close();
    throw error;
  }
}
