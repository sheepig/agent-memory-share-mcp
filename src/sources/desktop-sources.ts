import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import Database from "better-sqlite3";

import type { IndexDocument, SessionMessage, SourceReference } from "../domain/source.js";
import { redactSensitiveText } from "../security/sensitive-content.js";
import type { SessionSourceAdapter, SourceAdapter, SourceDiagnostic, SourceDiscoveryOptions, SourceDiscoveryStep } from "./source-adapter.js";
import { discoverFileSteps, type FileDiscoveryStep } from "./file-discovery.js";
import { resolveDesktopSourcePaths, type DesktopSourcePaths } from "./source-paths.js";
import { buildMemoryChunks } from "./memory-chunks.js";
import { parseMemoryMetadata } from "./memory-metadata.js";
import { buildSessionIndexDocuments, type ContentTokenCounter, type SessionChunkOptions } from "./session-turns.js";

const MAX_SESSION_BYTES = 16_000_000;
const MAX_MEMORY_BYTES = 2_000_000;
const SCAN_BATCH_SIZE = 200;
const MIN_SESSION_USER_CHARACTERS = 10;
const MIN_SESSION_ASSISTANT_CHARACTERS = 50;
const MIN_SESSION_TOTAL_CHARACTERS = 100;
const MEMORY_EXTENSIONS = new Set([".md"]);

type FileSessionProvider = "claude-session" | "codex-session" | "cursor-session";

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedMessage {
  body: string;
  line: number;
  nativeEventId?: string;
  role: "assistant" | "user";
  timestamp?: string;
}

function visibleCharacterCount(value: string): number {
  return [...value.replace(/\s/gu, "")].length;
}

function hasMinimumSessionContent(messages: ReadonlyArray<Pick<ParsedMessage, "body" | "role">>): boolean {
  let assistantCharacters = 0;
  let completeTurns = 0;
  let pendingUser = false;
  let userCharacters = 0;

  for (const message of messages) {
    const characters = visibleCharacterCount(message.body);
    if (message.role === "user") {
      userCharacters += characters;
      pendingUser = true;
      continue;
    }
    assistantCharacters += characters;
    if (pendingUser) {
      completeTurns += 1;
      pendingUser = false;
    }
  }

  return completeTurns >= 1
    && userCharacters >= MIN_SESSION_USER_CHARACTERS
    && assistantCharacters >= MIN_SESSION_ASSISTANT_CHARACTERS
    && userCharacters + assistantCharacters >= MIN_SESSION_TOTAL_CHARACTERS;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopedKey(key: string, roots?: readonly string[]): string {
  return roots ? `${key}:${digest(JSON.stringify(roots))}` : key;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const milliseconds = typeof value === "number" && Math.abs(value) < 100_000_000_000
    ? value * 1_000
    : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function cleanText(value: string): string {
  return redactSensitiveText(value).text;
}

function recordSensitiveDiagnostic(diagnostics: SourceDiagnostic[], raw: string, sourcePath: string): void {
  const findings = redactSensitiveText(raw).findings;
  if (findings.length > 0) {
    diagnostics.push({
      code: "sensitive_content_redacted",
      level: "warning",
      message: `Credential-like content was redacted before indexing (${findings.join(", ")}).`,
      sourcePath,
    });
  }
}

function parseJsonLines(raw: string): Array<{ line: number; record: JsonRecord }> {
  const records: Array<{ line: number; record: JsonRecord }> = [];
  raw.split("\n").forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    try {
      const record: unknown = JSON.parse(line);
      if (isRecord(record)) {
        records.push({ line: index + 1, record });
      }
    } catch {
      // Desktop persistent import omits malformed JSONL records and keeps the source usable.
    }
  });
  return records;
}

function malformedJsonLineCount(raw: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      count += 1;
    }
  }
  return count;
}

function textBlocks(content: unknown, allowedTypes: Set<string>, allowedIndexes?: Set<number>): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const values = content.flatMap((block, index) => {
    if (allowedIndexes && !allowedIndexes.has(index)) {
      return [];
    }
    if (!isRecord(block) || !allowedTypes.has(String(block.type)) || typeof block.text !== "string") {
      return [];
    }
    return [block.text];
  });
  return values.join("\n");
}

function visibleUserContent(content: string): string | undefined {
  const stripped = content.trimStart();
  if (stripped.startsWith("The following is the Codex agent history whose request action you are assessing.")
    || stripped.startsWith("The following is the Codex agent history added since your last approval assessment.")) {
    return undefined;
  }
  const requestMarker = "## My request:";
  if (stripped.includes(requestMarker)) {
    return stripped.split(requestMarker, 2)[1]?.trim();
  }
  if (stripped.startsWith("<codex_internal_context ")
    || stripped.startsWith("<environment_context>")
    || stripped.startsWith("<in-app-browser-context ")
    || stripped.startsWith("<recommended_plugins>")
    || stripped.startsWith("<system-reminder>")
    || stripped.startsWith("<permissions instructions>")
    || stripped.startsWith("<skills_instructions>")
    || stripped.startsWith("<app-context>")
    || stripped.startsWith("<apps_instructions>")
    || stripped.startsWith("<plugins_instructions>")
    || stripped.startsWith("<collaboration_mode>")
    || /^# AGENTS\.md instructions for /u.test(stripped)) {
    return undefined;
  }
  const nonEmptyLines = stripped.split("\n").filter((line) => line.trim());
  if (nonEmptyLines.length > 0 && nonEmptyLines.every((line) => /^## codex-clipboard-[\w-]+\.[A-Za-z0-9]+: /u.test(line.trim()))) {
    return undefined;
  }
  return content;
}

function isPolicyDecision(content: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    return keys[0] === "outcome" && ["allow", "deny"].includes(String(value.outcome));
  }
  if (keys.length !== 4) {
    return false;
  }
  return ["low", "medium", "high", "critical"].includes(String(value.risk_level))
    && ["unknown", "low", "medium", "high"].includes(String(value.user_authorization))
    && ["allow", "deny"].includes(String(value.outcome))
    && typeof value.rationale === "string";
}

function parseConversation(raw: string, provider: FileSessionProvider): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const { line, record } of parseJsonLines(raw)) {
    let message: JsonRecord | undefined;
    let allowedTypes = new Set(["text"]);
    if (provider === "codex-session") {
      const payload = record.payload;
      if (record.type !== "response_item" || !isRecord(payload) || payload.type !== "message") {
        continue;
      }
      if (![undefined, "final"].includes(payload.channel as undefined | string) || ![undefined, "final_answer"].includes(payload.phase as undefined | string)) {
        continue;
      }
      message = payload;
      allowedTypes = new Set(["input_text", "output_text"]);
    } else if (provider === "cursor-session") {
      const value = record.message;
      if (!isRecord(value)) {
        continue;
      }
      message = { role: record.role, content: value.content };
    } else {
      if (!["user", "assistant"].includes(String(record.type)) || record.isMeta === true || !isRecord(record.message)) {
        continue;
      }
      message = record.message;
    }
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    let allowedIndexes: Set<number> | undefined;
    if (provider === "codex-session" && role === "user" && isRecord(message.internal_chat_message_metadata_passthrough)) {
      const kinds = message.internal_chat_message_metadata_passthrough.content_item_kinds;
      if (Array.isArray(kinds)) {
        allowedIndexes = new Set(kinds.flatMap((kind, index) => kind === "user.text" ? [index] : []));
      }
    }
    let content = textBlocks(message.content, allowedTypes, allowedIndexes);
    if (!content?.trim()) {
      continue;
    }
    if (role === "user") {
      content = visibleUserContent(content);
      if (!content?.trim()) {
        continue;
      }
    } else if (isPolicyDecision(content)) {
      continue;
    }
    const timestamp = timestampValue(record.timestamp);
    const nativeEventId = provider === "codex-session"
      ? stringValue(record.id) ?? (isRecord(record.payload) ? stringValue(record.payload.id) : undefined)
      : stringValue(record.uuid);
    messages.push({ body: cleanText(content), line, role, ...(nativeEventId ? { nativeEventId } : {}), ...(timestamp ? { timestamp } : {}) });
  }
  return messages;
}

function firstVisibleTitle(messages: ParsedMessage[], fallback: string): string {
  const body = messages.find((message) => message.role === "user")?.body ?? messages[0]?.body ?? "";
  const request = body.includes("## My request:") ? body.split("## My request:", 2)[1] ?? body : body;
  for (const line of request.split("\n")) {
    const cleaned = line.replace(/^[#>*\s-]+/u, "").replaceAll(/[`*_]/gu, "").trim();
    if (cleaned && !cleaned.startsWith("<")) {
      return cleaned.slice(0, 88);
    }
  }
  return fallback.slice(0, 88) || "Untitled conversation";
}

async function readBoundedText(file: string, limit: number): Promise<string> {
  const information = await fs.lstat(file);
  if (!information.isFile() || information.isSymbolicLink() || information.size > limit) {
    throw new Error(`Source is not a regular text file within the ${limit} byte limit.`);
  }
  const raw = await fs.readFile(file, "utf8");
  if (raw.includes("\0")) {
    throw new Error("Source contains binary data.");
  }
  return raw;
}

function sourceReference(agent: string, sourceId: string, sourcePath: string, raw: string, updatedAt: Date, values: {
  discoveryCursor?: string;
  metadata?: Record<string, string | string[]>;
  originalSessionId?: string;
  projectPath?: string;
  title?: string;
  sourceType?: "memory" | "session";
} = {}): SourceReference {
  return {
    agent,
    contentFingerprint: digest(raw),
    discoveryCursor: values.discoveryCursor,
    metadata: values.metadata,
    originalSessionId: values.originalSessionId,
    projectPath: values.projectPath,
    sourceId,
    sourcePath,
    sourceType: values.sourceType ?? "session",
    title: values.title,
    updatedAt,
  };
}

abstract class FileSessionAdapter implements SessionSourceAdapter {
  abstract readonly agent: string;
  abstract readonly provider: FileSessionProvider;
  get key(): string { return scopedKey(`${this.agent}:session`, this.explicitRoots); }
  protected diagnostics: SourceDiagnostic[] = [];

  constructor(
    protected readonly homeDirectory: string,
    private readonly contentTokenCounter: ContentTokenCounter,
    protected readonly explicitRoots?: readonly string[],
    private readonly chunkOptions?: SessionChunkOptions,
  ) {}

  protected abstract fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep>;

  protected async prepareDiscovery(): Promise<void> {}

  protected decorateReference(reference: SourceReference): SourceReference {
    return reference;
  }

  async *discover(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceReference> {
    // Offline callers retain newest-first ordering; daemon discovery consumes resumable steps.
    const sources: SourceReference[] = [];
    for await (const step of this.discoverSteps(options)) {
      if (step.source) sources.push(step.source);
    }
    sources.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      || left.sourcePath.localeCompare(right.sourcePath));
    yield* sources;
  }

  async *discoverSteps(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceDiscoveryStep> {
    this.diagnostics = [];
    await this.prepareDiscovery();
    for await (const step of this.fileSteps(options)) {
      if (!step.file) {
        yield step;
        continue;
      }
      const file = step.file;
      let source: SourceReference | undefined;
      try {
        const information = await fs.lstat(file);
        const cached = options.cache?.get(file, information.size, information.mtimeMs);
        if (cached !== undefined) {
          source = cached ? this.decorateReference({ ...cached, discoveryCursor: file }) : undefined;
        } else {
          source = await this.referenceFromFile(file, information.mtime) ?? undefined;
          options.cache?.set(file, information.size, information.mtimeMs, source ?? null);
        }
      } catch (error) {
        this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: file });
      }
      yield { cursor: step.cursor, ...(source ? { source } : {}) };
    }
  }

  async refresh(source: SourceReference): Promise<SourceReference | null> {
    await this.prepareDiscovery();
    try {
      return await this.referenceFromFile(source.sourcePath, (await fs.lstat(source.sourcePath)).mtime);
    } catch (error) {
      this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: source.sourcePath });
      return null;
    }
  }

  private async referenceFromFile(file: string, updatedAt: Date): Promise<SourceReference | null> {
    const raw = await readBoundedText(file, MAX_SESSION_BYTES);
    recordSensitiveDiagnostic(this.diagnostics, raw, file);
    const malformed = malformedJsonLineCount(raw);
    if (malformed > 0) {
      this.diagnostics.push({ code: "malformed_jsonl_records", level: "warning", message: `${malformed} malformed JSONL record(s) were skipped.`, sourcePath: file });
    }
    const messages = parseConversation(raw, this.provider);
    if (messages.length === 0) {
      this.diagnostics.push({ code: "no_visible_content", level: "warning", message: "The session contains no visible indexable messages.", sourcePath: file });
    } else if (!hasMinimumSessionContent(messages)) {
      this.diagnostics.push({ code: "session_below_minimum_content", level: "warning", message: "The session does not contain one complete substantive user/assistant turn.", sourcePath: file });
    } else {
      const metadata = this.metadata(raw, file);
      return this.decorateReference(sourceReference(this.agent, metadata.sourceId, file, raw, updatedAt, {
        discoveryCursor: file,
        projectPath: metadata.projectPath,
        title: firstVisibleTitle(messages, path.basename(file, ".jsonl")),
      }));
    }
    return null;
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const raw = await readBoundedText(source.sourcePath, MAX_SESSION_BYTES);
    if (digest(raw) !== source.contentFingerprint) throw new Error("Session content changed after discovery; rediscovery is required.");
    const messages: SessionMessage[] = parseConversation(raw, this.provider).map((message) => ({
      ...message,
      location: `line:${message.line}`,
    }));
    for (const document of await buildSessionIndexDocuments(messages, source, this.contentTokenCounter, this.chunkOptions)) {
      yield document;
    }
  }

  async *readConversation(source: SourceReference): AsyncIterable<SessionMessage> {
    const raw = await readBoundedText(source.sourcePath, MAX_SESSION_BYTES);
    for (const message of parseConversation(raw, this.provider)) {
      yield {
        body: message.body,
        location: `line:${message.line}`,
        ...(message.nativeEventId ? { nativeEventId: message.nativeEventId } : {}),
        role: message.role,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      };
    }
  }

  protected metadata(raw: string, file: string): { projectPath?: string; sourceId: string } {
    let projectPath: string | undefined;
    let sourceId: string | undefined;
    for (const { record } of parseJsonLines(raw).slice(0, 200)) {
      if (this.provider === "codex-session" && record.type === "session_meta" && isRecord(record.payload)) {
        projectPath = stringValue(record.payload.cwd) ?? projectPath;
        sourceId = stringValue(record.payload.id) ?? stringValue(record.payload.session_id) ?? sourceId;
      } else if (this.provider === "claude-session") {
        projectPath = stringValue(record.cwd) ?? projectPath;
        sourceId = stringValue(record.sessionId) ?? sourceId;
      }
    }
    return { projectPath, sourceId: sourceId ?? digest(file) };
  }
}

export class CodexSessionAdapter extends FileSessionAdapter {
  readonly agent = "codex";
  readonly provider = "codex-session" as const;
  private metadataDatabase?: { file: string; cwd: boolean; id: boolean };

  protected override async prepareDiscovery(): Promise<void> {
    this.metadataDatabase = undefined;
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.homeDirectory, ".codex"));
    } catch {
      return;
    }
    const databases = names
      .filter((name) => /^state_\d+\.sqlite$/u.test(name))
      .sort((left, right) => Number.parseInt(right.slice(6), 10) - Number.parseInt(left.slice(6), 10));
    for (const name of databases) {
      let database: Database.Database;
      try {
        const file = path.join(this.homeDirectory, ".codex", name);
        const information = await fs.lstat(file);
        if (!information.isFile() || information.isSymbolicLink()) {
          continue;
        }
        database = openReadOnlyDatabase(file);
      } catch {
        continue;
      }
      try {
        const columns = new Set((database.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((column) => column.name));
        if (!columns.has("rollout_path") || !columns.has("title")) {
          continue;
        }
        this.metadataDatabase = { file: path.join(this.homeDirectory, ".codex", name), cwd: columns.has("cwd"), id: columns.has("id") };
        return;
      } catch {
        continue;
      } finally {
        database.close();
      }
    }
  }

  protected override decorateReference(reference: SourceReference): SourceReference {
    if (!this.metadataDatabase) return reference;
    let database: Database.Database | undefined;
    try {
      database = openReadOnlyDatabase(this.metadataDatabase.file);
      const cwd = this.metadataDatabase.cwd ? "cwd" : "NULL AS cwd";
      const saved = (this.metadataDatabase.id
        ? database.prepare(`SELECT title, ${cwd} FROM threads WHERE id = ? AND rollout_path = ? LIMIT 1`).get(reference.sourceId, reference.sourcePath)
        : database.prepare(`SELECT title, ${cwd} FROM threads WHERE rollout_path = ? LIMIT 1`).get(reference.sourcePath)) as { cwd?: string; title?: string } | undefined;
      return saved ? {
        ...reference,
        projectPath: stringValue(saved.cwd) ?? reference.projectPath,
        title: stringValue(saved.title)?.slice(0, 160) ?? reference.title,
      } : reference;
    } catch {
      return reference;
    } finally {
      database?.close();
    }
  }

  protected fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep> {
    return discoverFileSteps(this.explicitRoots ?? [
      path.join(this.homeDirectory, ".codex/sessions"),
      path.join(this.homeDirectory, ".codex/archived_sessions"),
    ], { ...options, extensions: new Set([".jsonl"]), onDiagnostic: (value) => this.diagnostics.push(value) });
  }
}

export class ClaudeSessionAdapter extends FileSessionAdapter {
  readonly agent = "claude-code";
  readonly provider = "claude-session" as const;

  protected fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep> {
    return discoverFileSteps(this.explicitRoots ?? [path.join(this.homeDirectory, ".claude/projects")], {
      ...options,
      accept: (file) => !file.split(path.sep).includes("subagents"),
      descend: (directory) => !directory.split(path.sep).includes("subagents"),
      extensions: new Set([".jsonl"]),
      onDiagnostic: (value) => this.diagnostics.push(value),
    });
  }
}

export class CursorSessionAdapter extends FileSessionAdapter {
  readonly agent = "cursor";
  readonly provider = "cursor-session" as const;

  protected fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep> {
    return discoverFileSteps(this.explicitRoots ?? [path.join(this.homeDirectory, ".cursor/projects")], {
      ...options,
      accept: (file) => path.basename(path.dirname(path.dirname(file))) === "agent-transcripts",
      extensions: new Set([".jsonl"]),
      onDiagnostic: (value) => this.diagnostics.push(value),
    });
  }
}

function openReadOnlyDatabase(file: string): Database.Database {
  return new Database(file, { fileMustExist: true, readonly: true });
}

function openCodeMessages(database: Database.Database, sessionId: string): {
  invalidRecords: number;
  messages: Array<{ body: string; role: "assistant" | "user"; timestamp?: string }>;
} {
  const rows = database.prepare(`
    SELECT m.id AS message_id, m.time_created, m.data AS message_data, p.data AS part_data
    FROM message m JOIN part p ON p.message_id = m.id
    WHERE m.session_id = ?
    ORDER BY m.time_created, p.time_created, p.id
    LIMIT 1200
  `).all(sessionId) as Array<{ message_data: string; message_id: string; part_data: string; time_created?: number }>;
  const grouped = new Map<string, { bodies: string[]; role: "assistant" | "user"; timestamp?: string }>();
  let invalidRecords = 0;
  for (const row of rows) {
    try {
      const message: unknown = JSON.parse(row.message_data);
      const part: unknown = JSON.parse(row.part_data);
      if (!isRecord(message) || !isRecord(part) || (message.role !== "user" && message.role !== "assistant") || part.type !== "text" || typeof part.text !== "string") {
        invalidRecords += 1;
        continue;
      }
      let body = cleanText(part.text);
      if (message.role === "user") {
        body = visibleUserContent(body) ?? "";
      } else if (isPolicyDecision(body)) {
        body = "";
      }
      if (body.trim()) {
        const timestamp = timestampValue(row.time_created);
        const current = grouped.get(row.message_id) ?? {
          bodies: [],
          role: message.role,
          ...(timestamp ? { timestamp } : {}),
        };
        current.bodies.push(body);
        grouped.set(row.message_id, current);
      }
    } catch {
      invalidRecords += 1;
      continue;
    }
  }
  return {
    invalidRecords,
    messages: [...grouped.values()].map(({ bodies, role, timestamp }) => ({
      body: bodies.join("\n"),
      role,
      ...(timestamp ? { timestamp } : {}),
    })),
  };
}

interface OpenCodeSessionRow {
  directory?: string;
  id: string;
  time_updated?: number;
  title?: string;
}

export class OpenCodeSessionAdapter implements SessionSourceAdapter {
  readonly agent = "opencode";
  readonly key: string;
  private readonly databasePath: string;
  private diagnostics: SourceDiagnostic[] = [];

  constructor(homeDirectory: string, private readonly contentTokenCounter: ContentTokenCounter, databasePath?: string) {
    this.databasePath = databasePath ?? path.join(homeDirectory, ".local/share/opencode/opencode.db");
    this.key = scopedKey("opencode:session", databasePath ? [databasePath] : undefined);
  }

  async *discover(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceReference> {
    for await (const step of this.discoverSteps(options)) {
      if (step.source) yield step.source;
    }
  }

  async *discoverSteps(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceDiscoveryStep> {
    this.diagnostics = [];
    let database: Database.Database;
    try {
      const information = await fs.lstat(this.databasePath);
      if (!information.isFile() || information.isSymbolicLink()) {
        this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: "The OpenCode database is not a regular file.", sourcePath: this.databasePath });
        yield { complete: false };
        return;
      }
      database = openReadOnlyDatabase(this.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: this.databasePath });
        yield { complete: false };
      }
      return;
    }
    try {
      let cursor = (() => {
        if (!options.after) return undefined;
        try {
          return JSON.parse(options.after) as { id: string; updated: number };
        } catch {
          return undefined;
        }
      })();
      const statement = database.prepare(`
        SELECT id, title, directory, time_updated
        FROM session
        WHERE time_archived IS NULL
          AND (? IS NULL OR time_updated < ? OR (time_updated = ? AND id > ?))
        ORDER BY time_updated DESC, id
        LIMIT ?
      `);
      while (true) {
        const rows = statement.all(
          cursor?.updated ?? null,
          cursor?.updated ?? null,
          cursor?.updated ?? null,
          cursor?.id ?? null,
          SCAN_BATCH_SIZE,
        ) as OpenCodeSessionRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          await setImmediate();
          cursor = { id: row.id, updated: row.time_updated ?? 0 };
          const discoveryCursor = JSON.stringify(cursor);
          const sourcePath = `${this.databasePath}#session/${row.id}`;
          // OpenCode's per-session update key invalidates qualification independently of other sessions.
          const cached = options.cache?.get(sourcePath, 0, cursor.updated);
          if (cached !== undefined) {
            yield { cursor: discoveryCursor, ...(cached ? { source: { ...cached, discoveryCursor } } : {}) };
            continue;
          }
          const source = this.referenceFromRow(database, row);
          options.cache?.set(sourcePath, 0, cursor.updated, source);
          yield { cursor: discoveryCursor, ...(source ? { source } : {}) };
        }
      }
    } catch (error) {
      this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: this.databasePath });
      yield { complete: false };
    } finally {
      database.close();
    }
  }

  async refresh(source: SourceReference): Promise<SourceReference | null> {
    let database: Database.Database | undefined;
    try {
      const information = await fs.lstat(this.databasePath);
      if (!information.isFile() || information.isSymbolicLink()) return null;
      database = openReadOnlyDatabase(this.databasePath);
      const row = database.prepare("SELECT id, title, directory, time_updated FROM session WHERE id = ? AND time_archived IS NULL")
        .get(source.sourceId) as OpenCodeSessionRow | undefined;
      return row ? this.referenceFromRow(database, row) : null;
    } catch (error) {
      this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: source.sourcePath });
      return null;
    } finally {
      database?.close();
    }
  }

  async isAvailable(source: SourceReference): Promise<boolean> {
    let database: Database.Database | undefined;
    try {
      const information = await fs.lstat(this.databasePath);
      if (!information.isFile() || information.isSymbolicLink()) return false;
      database = openReadOnlyDatabase(this.databasePath);
      return database.prepare("SELECT 1 FROM session WHERE id = ? AND time_archived IS NULL").get(source.sourceId) !== undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    } finally {
      database?.close();
    }
  }

  private referenceFromRow(database: Database.Database, row: OpenCodeSessionRow): SourceReference | null {
    const sourcePath = `${this.databasePath}#session/${row.id}`;
    const { invalidRecords, messages } = openCodeMessages(database, row.id);
    if (invalidRecords > 0) {
      this.diagnostics.push({ code: "malformed_database_records", level: "warning", message: `${invalidRecords} malformed OpenCode record(s) were skipped.`, sourcePath });
    }
    if (messages.length === 0) return null;
    if (!hasMinimumSessionContent(messages)) {
      this.diagnostics.push({ code: "session_below_minimum_content", level: "warning", message: "The session does not contain one complete substantive user/assistant turn.", sourcePath });
      return null;
    }
    const raw = messages.map((message) => JSON.stringify({ content: message.body, role: message.role, timestamp: message.timestamp })).join("\n");
    return sourceReference("opencode", row.id, sourcePath, raw, new Date(row.time_updated ?? 0), {
      discoveryCursor: JSON.stringify({ id: row.id, updated: row.time_updated ?? 0 }),
      projectPath: stringValue(row.directory),
      title: cleanText(row.title ?? row.id).slice(0, 160),
    });
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const database = openReadOnlyDatabase(this.databasePath);
    let messages: SessionMessage[];
    try {
      const parsed = openCodeMessages(database, source.sourceId).messages;
      const raw = parsed.map((message) => JSON.stringify({ content: message.body, role: message.role, timestamp: message.timestamp })).join("\n");
      if (digest(raw) !== source.contentFingerprint) throw new Error("Session content changed after discovery; rediscovery is required.");
      messages = parsed.map((message, index) => ({ ...message, location: `message:${index + 1}` }));
    } finally {
      database.close();
    }
    for (const document of await buildSessionIndexDocuments(messages, source, this.contentTokenCounter)) {
      yield document;
    }
  }

  async *readConversation(source: SourceReference): AsyncIterable<SessionMessage> {
    const database = openReadOnlyDatabase(this.databasePath);
    try {
      const { messages } = openCodeMessages(database, source.sourceId);
      for (const [index, message] of messages.entries()) {
        yield { ...message, location: `message:${index + 1}` };
      }
    } finally {
      database.close();
    }
  }
}

abstract class MemoryAdapter implements SourceAdapter {
  abstract readonly agent: string;
  get key(): string { return scopedKey(`${this.agent}:memory`, this.explicitRoots); }
  protected diagnostics: SourceDiagnostic[] = [];

  constructor(protected readonly homeDirectory: string, protected readonly explicitRoots?: readonly string[]) {}

  protected abstract fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep>;

  async *discover(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceReference> {
    // Offline callers retain newest-first ordering; daemon discovery consumes resumable steps.
    const sources: SourceReference[] = [];
    for await (const step of this.discoverSteps(options)) {
      if (step.source) sources.push(step.source);
    }
    sources.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime()
      || left.sourcePath.localeCompare(right.sourcePath));
    yield* sources;
  }

  async *discoverSteps(options: SourceDiscoveryOptions = {}): AsyncIterable<SourceDiscoveryStep> {
    this.diagnostics = [];
    for await (const step of this.fileSteps(options)) {
      if (!step.file) {
        yield step;
        continue;
      }
      const file = step.file;
      let source: SourceReference | undefined;
      try {
        source = await this.referenceFromFile(file);
      } catch (error) {
        this.diagnostics.push({ code: "memory_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: file });
      }
      yield { cursor: step.cursor, ...(source ? { source } : {}) };
    }
  }

  async refresh(source: SourceReference): Promise<SourceReference | null> {
    try {
      return await this.referenceFromFile(source.sourcePath);
    } catch (error) {
      this.diagnostics.push({ code: "memory_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: source.sourcePath });
      return null;
    }
  }

  private async referenceFromFile(file: string): Promise<SourceReference> {
    const raw = await readBoundedText(file, MAX_MEMORY_BYTES);
    recordSensitiveDiagnostic(this.diagnostics, raw, file);
    const information = await fs.stat(file);
    const parsed = parseMemoryMetadata(raw);
    return sourceReference(this.agent, digest(file), file, raw, parsed.updatedAt ?? information.mtime, {
      discoveryCursor: file,
      metadata: parsed.metadata,
      originalSessionId: parsed.originalSessionId,
      projectPath: parsed.projectPath,
      sourceType: "memory",
      title: parsed.title ?? path.basename(file),
    });
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const text = await readBoundedText(source.sourcePath, MAX_MEMORY_BYTES);
    if (digest(text) !== source.contentFingerprint) throw new Error("Memory content changed after discovery; rediscovery is required.");
    const parsed = parseMemoryMetadata(text);
    const raw = cleanText(parsed.body);
    const lineOffset = (parsed.bodyStartLine ?? 1) - 1;
    for (const chunk of buildMemoryChunks(raw, source.title ?? path.basename(source.sourcePath))) {
      yield {
        body: chunk.body,
        endLocation: `line:${chunk.endLine + lineOffset}`,
        location: `line:${chunk.startLine + lineOffset}`,
        source,
        title: chunk.title,
      };
    }
  }
}

export class CodexMemoryAdapter extends MemoryAdapter {
  readonly agent = "codex";

  protected fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep> {
    return discoverFileSteps(this.explicitRoots ?? [path.join(this.homeDirectory, ".codex/memories")], {
      ...options, extensions: MEMORY_EXTENSIONS, onDiagnostic: (value) => this.diagnostics.push(value),
    });
  }
}

export class ClaudeMemoryAdapter extends MemoryAdapter {
  readonly agent = "claude-code";

  constructor(homeDirectory: string, explicitRoots?: readonly string[], private readonly projectRoots?: readonly string[]) {
    super(homeDirectory, explicitRoots);
  }

  override get key(): string { return scopedKey(`${this.agent}:memory`, this.explicitRoots ?? this.projectRoots); }

  protected async *fileSteps(options: SourceDiscoveryOptions): AsyncIterable<FileDiscoveryStep> {
    const roots = this.explicitRoots ?? this.projectRoots ?? [path.join(this.homeDirectory, ".claude/projects")];
    for await (const step of discoverFileSteps(roots, {
      ...options,
      extensions: MEMORY_EXTENSIONS,
      ...(this.explicitRoots ? {} : { accept: (file: string) => {
        const root = roots.find((value) => file.startsWith(`${value}${path.sep}`));
        return root !== undefined && path.relative(root, file).split(path.sep)[1] === "memory";
      }, descend: (directory: string) => {
        if (roots.includes(directory)) return true;
        const root = roots.find((value) => directory.startsWith(`${value}${path.sep}`));
        if (root === undefined) return false;
        const parts = path.relative(root, directory).split(path.sep);
        return parts.length === 1 || parts[1] === "memory";
      } }),
      onDiagnostic: (value) => this.diagnostics.push(value),
    })) yield step;
  }
}

export function createDesktopAdapters(
  homeDirectory: string,
  contentTokenCounter: ContentTokenCounter,
  configuredPaths?: DesktopSourcePaths,
): { memories: SourceAdapter[]; sessions: SessionSourceAdapter[] } {
  const roots = configuredPaths ? resolveDesktopSourcePaths(homeDirectory, configuredPaths) : undefined;
  return {
    memories: [
      new CodexMemoryAdapter(homeDirectory, roots?.codex.memoryRoots),
      new ClaudeMemoryAdapter(homeDirectory, roots?.["claude-code"].memoryRoots, roots?.["claude-code"].projectRoots),
    ],
    sessions: [
      new CodexSessionAdapter(homeDirectory, contentTokenCounter, roots?.codex.sessionRoots),
      new ClaudeSessionAdapter(homeDirectory, contentTokenCounter, roots?.["claude-code"].projectRoots),
      new CursorSessionAdapter(homeDirectory, contentTokenCounter, roots?.cursor.sessionRoots),
      new OpenCodeSessionAdapter(homeDirectory, contentTokenCounter, roots?.opencode.databasePath),
    ],
  };
}
