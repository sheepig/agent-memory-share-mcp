import fs from "node:fs/promises";
import path from "node:path";

import { ClaudeSessionAdapter, CodexSessionAdapter } from "../sources/desktop-sources.js";
import { LocalContentTokenizer } from "../search/embedding.js";
import { INDEX_RULE_VERSION } from "../application/source-service.js";
import { SENSITIVE_CONTENT_RULE_VERSION } from "../security/sensitive-content.js";
import { APP_VERSION } from "../version.js";
import type { SessionSourceAdapter, SourceDiagnostic } from "../sources/source-adapter.js";
import type { ContentTokenCounter } from "../sources/session-turns.js";
import { writeJsonFile } from "./files.js";
import type {
  EvaluationConfig,
  EvaluationDataset,
  EvaluationManifest,
  EvaluationManifestDataset,
  EvaluationManifestSession,
} from "./types.js";

function rootsFor(dataset: EvaluationDataset): string[] {
  return dataset.type === "local" ? dataset.roots : [dataset.root];
}

function adapterFor(dataset: EvaluationDataset, contentTokenCounter: ContentTokenCounter): SessionSourceAdapter {
  const roots = rootsFor(dataset);
  return dataset.agent === "codex"
    ? new CodexSessionAdapter("", contentTokenCounter, roots)
    : new ClaudeSessionAdapter("", contentTokenCounter, roots);
}

async function validateRoot(root: string): Promise<void> {
  const information = await fs.lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`Evaluation source root must be a real directory: ${root}`);
  }
}

function rootLocation(roots: readonly string[], sourcePath: string): { relativePath: string; rootIndex: number } {
  for (let index = 0; index < roots.length; index += 1) {
    const relativePath = path.relative(roots[index]!, sourcePath);
    if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
      return { relativePath, rootIndex: index };
    }
  }
  throw new Error(`Discovered source is outside configured roots: ${sourcePath}`);
}

function diagnosticCounts(diagnostics: readonly SourceDiagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
  return counts;
}

async function scanDataset(dataset: EvaluationDataset, contentTokenCounter: ContentTokenCounter): Promise<EvaluationManifestDataset> {
  const roots = rootsFor(dataset);
  await Promise.all(roots.map(validateRoot));
  if (dataset.type === "swe-chat") {
    const materialization = JSON.parse(await fs.readFile(path.join(dataset.root, ".swe-chat-materialization.json"), "utf8")) as { revision?: unknown };
    if (materialization.revision !== dataset.revision) {
      throw new Error(`SWE-chat materialization revision does not match config for ${dataset.id}.`);
    }
  }
  const adapter = adapterFor(dataset, contentTokenCounter);
  const started = performance.now();
  const sessionsById = new Map<string, EvaluationManifestSession>();
  const visitedPaths = new Set<string>();
  const duplicateDiagnostics: SourceDiagnostic[] = [];
  for await (const source of adapter.discover()) {
    visitedPaths.add(source.sourcePath);
    if (sessionsById.has(source.sourceId)) {
      duplicateDiagnostics.push({
        code: "duplicate_source_id",
        level: "warning",
        message: "A later discovered file replaced an earlier file with the same source ID.",
        sourcePath: source.sourcePath,
      });
    }
    const chunks = [];
    let ordinal = 0;
    for await (const document of adapter.extract(source)) {
      chunks.push({
        characters: [...document.body].length,
        ...(document.chunkIndex !== undefined ? { chunkIndex: document.chunkIndex } : {}),
        ...(document.contentTokenCount !== undefined ? { contentTokenCount: document.contentTokenCount } : {}),
        ...(document.endLocation ? { endLocation: document.endLocation } : {}),
        ...(document.endNativeEventId ? { endNativeEventId: document.endNativeEventId } : {}),
        ...(document.endedAt ? { endedAt: document.endedAt } : {}),
        location: document.location,
        ...(document.nativeEventId ? { nativeEventId: document.nativeEventId } : {}),
        ordinal,
        ...(document.startedAt ? { startedAt: document.startedAt } : {}),
        ...(document.turnCount ? { turnCount: document.turnCount } : {}),
      });
      ordinal += 1;
    }
    const location = rootLocation(roots, source.sourcePath);
    sessionsById.set(source.sourceId, {
      byteSize: (await fs.stat(source.sourcePath)).size,
      chunks,
      contentFingerprint: source.contentFingerprint,
      ...(source.projectPath ? { projectPath: source.projectPath } : {}),
      ...location,
      sourceId: source.sourceId,
      sourcePath: source.sourcePath,
      ...(source.title ? { title: source.title } : {}),
      updatedAt: source.updatedAt.toISOString(),
    });
    if (sessionsById.size >= (dataset.maxEligibleSessions ?? Number.POSITIVE_INFINITY)) break;
  }
  const sessions = [...sessionsById.values()];
  const diagnostics = [...(adapter.takeDiagnostics?.() ?? []), ...duplicateDiagnostics];
  diagnostics.forEach((diagnostic) => {
    if (diagnostic.sourcePath) visitedPaths.add(diagnostic.sourcePath);
  });
  const sourceSizes = await Promise.all([...visitedPaths].map(async (sourcePath) => {
    try {
      return (await fs.stat(sourcePath)).size;
    } catch {
      // A source can disappear after discovery; the diagnostic count remains authoritative for this scan.
      return 0;
    }
  }));
  const sourceBytes = sourceSizes.reduce((total, size) => total + size, 0);
  return {
    agent: dataset.agent,
    diagnostics: diagnosticCounts(diagnostics),
    elapsedMs: performance.now() - started,
    eligibleSessions: sessions.length,
    id: dataset.id,
    ...(dataset.type === "swe-chat" ? { revision: dataset.revision } : {}),
    roots,
    sessions,
    sourceBytes,
    sourceFilesVisited: visitedPaths.size,
    type: dataset.type,
  };
}

export async function scanEvaluation(
  config: EvaluationConfig,
  outputFile = path.join(config.outputDirectory, "manifest.json"),
  contentTokenCounter: ContentTokenCounter = new LocalContentTokenizer(
    config.benchmark.embeddingCacheDirectory ?? path.join(config.outputDirectory, "embedding-cache"),
  ),
): Promise<{
  manifest: EvaluationManifest;
  outputFile: string;
}> {
  const datasets: EvaluationManifestDataset[] = [];
  for (const dataset of config.datasets) datasets.push(await scanDataset(dataset, contentTokenCounter));
  const manifest: EvaluationManifest = {
    datasets,
    generatedAt: new Date().toISOString(),
    rules: {
      applicationVersion: APP_VERSION,
      indexRuleVersion: INDEX_RULE_VERSION,
      sensitiveContentRuleVersion: SENSITIVE_CONTENT_RULE_VERSION,
    },
    schemaVersion: 1,
  };
  await writeJsonFile(outputFile, manifest);
  return { manifest, outputFile };
}
