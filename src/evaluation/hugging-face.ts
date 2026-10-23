import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

import type { EvaluationAgent } from "./types.js";
import { writeJsonFile } from "./files.js";

const HUB_SERVER = "https://huggingface.co";

interface SweChatMaterializationOptions {
  agent: EvaluationAgent;
  maxSourceFiles?: number;
  repository: string;
  revision: string;
  root: string;
  tokenEnv: string;
  tokenFile?: string;
}

interface SweChatRow {
  agent?: unknown;
  prompt_count?: unknown;
  session_ended_at?: unknown;
  session_id?: unknown;
  session_started_at?: unknown;
  transcript_path?: unknown;
  turn_count?: unknown;
}

interface MaterializedSession {
  bytes: number;
  sessionEndedAt?: string;
  sessionId: string;
  sessionStartedAt?: string;
  sourcePath: string;
  transcriptPath: string;
}

async function tokenFor(options: SweChatMaterializationOptions): Promise<string> {
  const token = options.tokenFile
    ? (await fs.readFile(options.tokenFile, "utf8")).trim()
    : process.env[options.tokenEnv]?.trim();
  if (!token) {
    throw new Error(`Missing Hugging Face token. Set ${options.tokenEnv} or configure tokenFile.`);
  }
  return token;
}

async function fetchChecked(url: string, token: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 30_000) : Math.min(500 * 2 ** attempt, 8_000);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const message = (await response.text()).slice(0, 500);
    throw new Error(`Hugging Face request failed (${response.status}): ${message}`);
  }
  throw new Error("Hugging Face request exhausted its retry budget.");
}

async function downloadFile(url: string, target: string, token: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  const response = await fetchChecked(url, token);
  if (!response.body) throw new Error(`Hugging Face file has no body: ${url}`);
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { mode: 0o600 }));
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function selectedRows(options: SweChatMaterializationOptions, token: string): Promise<SweChatRow[]> {
  const metadataPath = path.join(options.root, `.sessions-${options.revision}.parquet`);
  try {
    await fs.access(metadataPath);
  } catch {
    const repositoryPath = options.repository.split("/").map(encodeURIComponent).join("/");
    await downloadFile(`${HUB_SERVER}/datasets/${repositoryPath}/resolve/${options.revision}/sessions.parquet?download=true`, metadataPath, token);
  }
  const file = await asyncBufferFromFile(metadataPath);
  const rows = await parquetReadObjects({
    columns: ["agent", "prompt_count", "session_ended_at", "session_id", "session_started_at", "transcript_path", "turn_count"],
    file,
  }) as SweChatRow[];
  return selectSweChatRows(rows, options.agent, options.maxSourceFiles);
}

export function selectSweChatRows(rows: readonly SweChatRow[], agent: EvaluationAgent, limit?: number): SweChatRow[] {
  const agentName = agent === "codex" ? "Codex" : "Claude Code";
  const matches = rows
    .filter((row) => row.agent === agentName && typeof row.session_id === "string"
      && typeof row.transcript_path === "string" && row.transcript_path.startsWith("transcripts/"))
    .sort((left, right) => Number(left.turn_count ?? 0) - Number(right.turn_count ?? 0)
      || String(left.session_started_at ?? "").localeCompare(String(right.session_started_at ?? ""))
      || String(left.session_id).localeCompare(String(right.session_id)));
  if (!limit || limit >= matches.length) return matches;
  return Array.from({ length: limit }, (_, index) => matches[Math.floor((index + 0.5) * matches.length / limit)]!);
}

function validTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

async function downloadSession(
  options: SweChatMaterializationOptions,
  token: string,
  row: SweChatRow,
): Promise<MaterializedSession> {
  const sessionId = String(row.session_id);
  if (!/^[A-Za-z0-9_-]+$/u.test(sessionId)) throw new Error(`Unsafe SWE-chat session id: ${sessionId}`);
  const transcriptPath = String(row.transcript_path);
  const target = path.join(options.root, `${sessionId}.jsonl`);
  const repositoryPath = options.repository.split("/").map(encodeURIComponent).join("/");
  const remotePath = transcriptPath.split("/").map(encodeURIComponent).join("/");
  let reusable = false;
  try {
    const information = await fs.lstat(target);
    reusable = information.isFile() && !information.isSymbolicLink() && information.size > 0;
  } catch {
    // Missing files are downloaded below.
  }
  if (!reusable) {
    await downloadFile(`${HUB_SERVER}/datasets/${repositoryPath}/resolve/${options.revision}/${remotePath}?download=true`, target, token);
  }
  const sessionEndedAt = validTime(row.session_ended_at);
  const sessionStartedAt = validTime(row.session_started_at);
  const sourceTime = sessionEndedAt ?? sessionStartedAt;
  if (sourceTime) {
    const value = new Date(sourceTime);
    await fs.utimes(target, value, value);
  }
  return {
    bytes: (await fs.stat(target)).size,
    ...(sessionEndedAt ? { sessionEndedAt } : {}),
    sessionId,
    ...(sessionStartedAt ? { sessionStartedAt } : {}),
    sourcePath: target,
    transcriptPath,
  };
}

export async function materializeSweChat(options: SweChatMaterializationOptions): Promise<{
  bytes: number;
  files: number;
  manifestPath: string;
}> {
  const token = await tokenFor(options);
  await fs.mkdir(options.root, { recursive: true });
  const identityPath = path.join(options.root, ".swe-chat-source.json");
  try {
    const identity = JSON.parse(await fs.readFile(identityPath, "utf8")) as { agent?: unknown; repository?: unknown; revision?: unknown };
    if (identity.agent !== options.agent || identity.repository !== options.repository || identity.revision !== options.revision) {
      throw new Error("SWE-chat root belongs to a different Agent, repository, or revision. Use a separate root.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existingTranscripts = (await fs.readdir(options.root)).filter((name) => name.endsWith(".jsonl"));
    if (existingTranscripts.length > 0) throw new Error("SWE-chat root has transcripts but no source identity. Use an empty root.");
    await writeJsonFile(identityPath, { agent: options.agent, repository: options.repository, revision: options.revision });
  }
  const manifestPath = path.join(options.root, ".swe-chat-materialization.json");
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { agent?: unknown; repository?: unknown; revision?: unknown };
    if (existing.agent !== options.agent || existing.repository !== options.repository || existing.revision !== options.revision) {
      throw new Error("SWE-chat root belongs to a different Agent, repository, or revision. Use a separate root.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rows = await selectedRows(options, token);
  const expectedFiles = new Set(rows.map((row) => `${String(row.session_id)}.jsonl`));
  const staleFiles = (await fs.readdir(options.root)).filter((name) => name.endsWith(".jsonl") && !expectedFiles.has(name));
  if (staleFiles.length > 0) {
    throw new Error(`SWE-chat root contains ${staleFiles.length} transcript(s) outside this materialization. Use an empty, revision-specific root.`);
  }
  const sessions: MaterializedSession[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(8, rows.length) }, async () => {
    while (next < rows.length) {
      const row = rows[next++]!;
      sessions.push(await downloadSession(options, token, row));
    }
  });
  await Promise.all(workers);
  sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  await writeJsonFile(manifestPath, {
    agent: options.agent,
    materializedAt: new Date().toISOString(),
    repository: options.repository,
    revision: options.revision,
    sessions,
  });
  return {
    bytes: sessions.reduce((total, session) => total + session.bytes, 0),
    files: sessions.length,
    manifestPath,
  };
}
