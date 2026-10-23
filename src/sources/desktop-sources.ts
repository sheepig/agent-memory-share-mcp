import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import type { IndexDocument, SessionMessage, SourceReference } from "../domain/source.js";
import { redactSensitiveText } from "../security/sensitive-content.js";
import type { SessionSourceAdapter, SourceAdapter, SourceDiagnostic } from "./source-adapter.js";
import { buildMemoryChunks } from "./memory-chunks.js";
import { parseMemoryMetadata } from "./memory-metadata.js";
import { buildSessionIndexDocuments, type ContentTokenCounter, type SessionChunkOptions } from "./session-turns.js";

const MAX_SESSION_BYTES = 16_000_000;
const MAX_MEMORY_BYTES = 2_000_000;
const MAX_DIRECTORIES = 3_000;
const SCAN_BATCH_SIZE = 200;
const MIN_SESSION_USER_CHARACTERS = 10;
const MIN_SESSION_ASSISTANT_CHARACTERS = 50;
const MIN_SESSION_TOTAL_CHARACTERS = 100;
const MEMORY_EXTENSIONS = new Set([".md"]);
const deniedNames = new Set(["auth.json", "credentials.json", "secrets.json", "tokens.json", "settings.json", "config.json", "mcp.json"]);
const instructionNames = new Set(["agent.md", "agents.md", "claude.md", "command.md", "commands.md"]);

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

async function walkFiles(
  root: string,
  extensions: Set<string>,
  onDiagnostic?: (diagnostic: SourceDiagnostic) => void,
): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  let directories = 0;
  while (pending.length > 0 && directories < MAX_DIRECTORIES) {
    const directory = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      const information = await fs.lstat(directory);
      if (!information.isDirectory() || information.isSymbolicLink()) {
        continue;
      }
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    directories += 1;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        onDiagnostic?.({ code: "symbolic_link_skipped", level: "warning", message: "Symbolic links are not scanned.", sourcePath: child });
        continue;
      }
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !["node_modules", "__pycache__", "skills"].includes(entry.name)) {
          pending.push(child);
        }
      } else if (!entry.name.startsWith(".") && !deniedNames.has(entry.name.toLowerCase())
        && !instructionNames.has(entry.name.toLowerCase()) && extensions.has(path.extname(entry.name).toLowerCase())) {
        files.push(child);
      }
    }
  }
  if (directories >= MAX_DIRECTORIES) {
    onDiagnostic?.({ code: "scan_limit_reached", level: "warning", message: "The bounded scan reached its directory limit.", sourcePath: root });
  }
  return files;
}

async function newestFilesFirst(files: string[]): Promise<string[]> {
  const candidates = await Promise.all(files.map(async (file) => {
    try {
      return { file, modified: (await fs.lstat(file)).mtimeMs };
    } catch {
      return { file, modified: 0 };
    }
  }));
  return candidates
    .sort((left, right) => right.modified - left.modified || left.file.localeCompare(right.file))
    .map(({ file }) => file);
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

async function fileInformation(file: string): Promise<{ raw: string; updatedAt: Date }> {
  const raw = await readBoundedText(file, MAX_SESSION_BYTES);
  const information = await fs.stat(file);
  return { raw, updatedAt: information.mtime };
}

abstract class FileSessionAdapter implements SessionSourceAdapter {
  abstract readonly agent: string;
  abstract readonly provider: FileSessionProvider;
  get key(): string { return `${this.agent}:session`; }
  protected diagnostics: SourceDiagnostic[] = [];

  constructor(
    protected readonly homeDirectory: string,
    private readonly contentTokenCounter: ContentTokenCounter,
    protected readonly explicitRoots?: readonly string[],
    private readonly chunkOptions?: SessionChunkOptions,
  ) {}

  protected abstract files(): Promise<string[]>;

  protected async prepareDiscovery(): Promise<void> {}

  protected decorateReference(reference: SourceReference): SourceReference {
    return reference;
  }

  async *discover(options: { after?: string } = {}): AsyncIterable<SourceReference> {
    this.diagnostics = [];
    await this.prepareDiscovery();
    const files = await newestFilesFirst(await this.files());
    const cursorIndex = options.after ? files.indexOf(options.after) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    for (let offset = start; offset < files.length; offset += SCAN_BATCH_SIZE) {
      for (const file of files.slice(offset, offset + SCAN_BATCH_SIZE)) {
        try {
          const { raw, updatedAt } = await fileInformation(file);
          recordSensitiveDiagnostic(this.diagnostics, raw, file);
          const malformed = malformedJsonLineCount(raw);
          if (malformed > 0) {
            this.diagnostics.push({ code: "malformed_jsonl_records", level: "warning", message: `${malformed} malformed JSONL record(s) were skipped.`, sourcePath: file });
          }
          const messages = parseConversation(raw, this.provider);
          if (messages.length === 0) {
            this.diagnostics.push({ code: "no_visible_content", level: "warning", message: "The session contains no visible indexable messages.", sourcePath: file });
            continue;
          }
          if (!hasMinimumSessionContent(messages)) {
            this.diagnostics.push({
              code: "session_below_minimum_content",
              level: "warning",
              message: "The session does not contain one complete substantive user/assistant turn.",
              sourcePath: file,
            });
            continue;
          }
          const metadata = this.metadata(raw, file);
          yield this.decorateReference(sourceReference(this.agent, metadata.sourceId, file, raw, updatedAt, {
            discoveryCursor: file,
            projectPath: metadata.projectPath,
            title: firstVisibleTitle(messages, path.basename(file, ".jsonl")),
          }));
        } catch (error) {
          this.diagnostics.push({
            code: "session_source_skipped",
            level: "warning",
            message: error instanceof Error ? error.message : String(error),
            sourcePath: file,
          });
        }
      }
    }
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const messages: SessionMessage[] = [];
    for await (const message of this.readConversation(source)) {
      messages.push(message);
    }
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
  private savedMetadata = new Map<string, { projectPath?: string; title?: string }>();

  protected override async prepareDiscovery(): Promise<void> {
    this.savedMetadata = new Map();
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
        const cwd = columns.has("cwd") ? "cwd" : "NULL AS cwd";
        const rows = database.prepare(`SELECT rollout_path, title, ${cwd} FROM threads`).all() as Array<{ cwd?: string; rollout_path: string; title?: string }>;
        for (const row of rows) {
          this.savedMetadata.set(row.rollout_path, {
            projectPath: stringValue(row.cwd),
            title: stringValue(row.title)?.slice(0, 160),
          });
        }
        return;
      } catch {
        continue;
      } finally {
        database.close();
      }
    }
  }

  protected override decorateReference(reference: SourceReference): SourceReference {
    const saved = this.savedMetadata.get(reference.sourcePath);
    return saved ? {
      ...reference,
      projectPath: saved.projectPath ?? reference.projectPath,
      title: saved.title ?? reference.title,
    } : reference;
  }

  protected async files(): Promise<string[]> {
    if (this.explicitRoots) {
      return (await Promise.all(this.explicitRoots.map((root) => walkFiles(root, new Set([".jsonl"]), (value) => this.diagnostics.push(value))))).flat();
    }
    return [
      ...(await walkFiles(path.join(this.homeDirectory, ".codex/sessions"), new Set([".jsonl"]), (value) => this.diagnostics.push(value))),
      ...(await walkFiles(path.join(this.homeDirectory, ".codex/archived_sessions"), new Set([".jsonl"]), (value) => this.diagnostics.push(value))),
    ];
  }
}

export class ClaudeSessionAdapter extends FileSessionAdapter {
  readonly agent = "claude-code";
  readonly provider = "claude-session" as const;

  protected async files(): Promise<string[]> {
    const roots = this.explicitRoots ?? [path.join(this.homeDirectory, ".claude/projects")];
    return (await Promise.all(roots.map((root) => walkFiles(root, new Set([".jsonl"]), (value) => this.diagnostics.push(value))))).flat()
      .filter((file) => !file.split(path.sep).includes("subagents"));
  }
}

export class CursorSessionAdapter extends FileSessionAdapter {
  readonly agent = "cursor";
  readonly provider = "cursor-session" as const;

  protected async files(): Promise<string[]> {
    return (await walkFiles(path.join(this.homeDirectory, ".cursor/projects"), new Set([".jsonl"]), (value) => this.diagnostics.push(value)))
      .filter((file) => path.basename(path.dirname(path.dirname(file))) === "agent-transcripts");
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

export class OpenCodeSessionAdapter implements SessionSourceAdapter {
  readonly agent = "opencode";
  readonly key = "opencode:session";
  private readonly databasePath: string;
  private diagnostics: SourceDiagnostic[] = [];

  constructor(homeDirectory: string, private readonly contentTokenCounter: ContentTokenCounter) {
    this.databasePath = path.join(homeDirectory, ".local/share/opencode/opencode.db");
  }

  async *discover(options: { after?: string } = {}): AsyncIterable<SourceReference> {
    this.diagnostics = [];
    let database: Database.Database;
    try {
      const information = await fs.lstat(this.databasePath);
      if (!information.isFile() || information.isSymbolicLink()) {
        this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: "The OpenCode database is not a regular file.", sourcePath: this.databasePath });
        return;
      }
      database = openReadOnlyDatabase(this.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: this.databasePath });
      }
      return;
    }
    try {
      const cursor = (() => {
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
        LIMIT ? OFFSET ?
      `);
      for (let offset = 0; ; offset += SCAN_BATCH_SIZE) {
        const rows = statement.all(
          cursor?.updated ?? null,
          cursor?.updated ?? null,
          cursor?.updated ?? null,
          cursor?.id ?? null,
          SCAN_BATCH_SIZE,
          offset,
        ) as Array<{ directory?: string; id: string; time_updated?: number; title?: string }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          const { invalidRecords, messages } = openCodeMessages(database, row.id);
          if (invalidRecords > 0) {
            this.diagnostics.push({
              code: "malformed_database_records",
              level: "warning",
              message: `${invalidRecords} malformed OpenCode record(s) were skipped.`,
              sourcePath: `${this.databasePath}#session/${row.id}`,
            });
          }
          if (messages.length === 0) {
            continue;
          }
          if (!hasMinimumSessionContent(messages)) {
            this.diagnostics.push({
              code: "session_below_minimum_content",
              level: "warning",
              message: "The session does not contain one complete substantive user/assistant turn.",
              sourcePath: `${this.databasePath}#session/${row.id}`,
            });
            continue;
          }
          const raw = messages.map((message) => JSON.stringify({ content: message.body, role: message.role, timestamp: message.timestamp })).join("\n");
          yield sourceReference("opencode", row.id, `${this.databasePath}#session/${row.id}`, raw, new Date(row.time_updated ?? 0), {
            discoveryCursor: JSON.stringify({ id: row.id, updated: row.time_updated ?? 0 }),
            projectPath: stringValue(row.directory),
            title: cleanText(row.title ?? row.id).slice(0, 160),
          });
        }
      }
    } catch (error) {
      this.diagnostics.push({ code: "session_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: this.databasePath });
    } finally {
      database.close();
    }
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const messages: SessionMessage[] = [];
    for await (const message of this.readConversation(source)) {
      messages.push(message);
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
  get key(): string { return `${this.agent}:memory`; }
  protected diagnostics: SourceDiagnostic[] = [];

  constructor(protected readonly homeDirectory: string) {}

  protected abstract files(): Promise<string[]>;

  async *discover(options: { after?: string } = {}): AsyncIterable<SourceReference> {
    this.diagnostics = [];
    const files = await newestFilesFirst(await this.files());
    const cursorIndex = options.after ? files.indexOf(options.after) : -1;
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
    for (let offset = start; offset < files.length; offset += SCAN_BATCH_SIZE) {
      for (const file of files.slice(offset, offset + SCAN_BATCH_SIZE)) {
        try {
          const raw = await readBoundedText(file, MAX_MEMORY_BYTES);
          recordSensitiveDiagnostic(this.diagnostics, raw, file);
          const information = await fs.stat(file);
          const parsed = parseMemoryMetadata(raw);
          yield sourceReference(this.agent, digest(file), file, raw, parsed.updatedAt ?? information.mtime, {
            discoveryCursor: file,
            metadata: parsed.metadata,
            originalSessionId: parsed.originalSessionId,
            projectPath: parsed.projectPath,
            sourceType: "memory",
            title: parsed.title ?? path.basename(file),
          });
        } catch (error) {
          this.diagnostics.push({ code: "memory_source_skipped", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: file });
        }
      }
    }
  }

  takeDiagnostics(): SourceDiagnostic[] {
    return this.diagnostics.splice(0);
  }

  async *extract(source: SourceReference): AsyncIterable<IndexDocument> {
    const parsed = parseMemoryMetadata(await readBoundedText(source.sourcePath, MAX_MEMORY_BYTES));
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

async function existingPortableFiles(
  locations: string[],
  onDiagnostic?: (diagnostic: SourceDiagnostic) => void,
): Promise<string[]> {
  const files: string[] = [];
  for (const location of locations) {
    try {
      const information = await fs.lstat(location);
      if (information.isSymbolicLink()) {
        onDiagnostic?.({ code: "symbolic_link_skipped", level: "warning", message: "Symbolic links are not scanned.", sourcePath: location });
        continue;
      }
      if (information.isFile()) {
        if (!deniedNames.has(path.basename(location).toLowerCase())
          && !instructionNames.has(path.basename(location).toLowerCase())
          && MEMORY_EXTENSIONS.has(path.extname(location).toLowerCase())) {
          files.push(location);
        }
      } else if (information.isDirectory()) {
        files.push(...await walkFiles(location, MEMORY_EXTENSIONS, onDiagnostic));
      }
    } catch {
      continue;
    }
  }
  return [...new Set(files)];
}

export class CodexMemoryAdapter extends MemoryAdapter {
  readonly agent = "codex";

  protected files(): Promise<string[]> {
    return existingPortableFiles([
      path.join(this.homeDirectory, ".codex/memories"),
    ], (value) => this.diagnostics.push(value));
  }
}

export class ClaudeMemoryAdapter extends MemoryAdapter {
  readonly agent = "claude-code";

  protected async files(): Promise<string[]> {
    const locations: string[] = [];
    const projects = path.join(this.homeDirectory, ".claude/projects");
    try {
      for (const entry of await fs.readdir(projects, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          locations.push(path.join(projects, entry.name, "memory"));
        }
      }
    } catch {
      // No Claude project memories are present.
    }
    return existingPortableFiles(locations, (value) => this.diagnostics.push(value));
  }
}

export function createDesktopAdapters(
  homeDirectory: string,
  contentTokenCounter: ContentTokenCounter,
): { memories: SourceAdapter[]; sessions: SessionSourceAdapter[] } {
  return {
    memories: [
      new CodexMemoryAdapter(homeDirectory),
      new ClaudeMemoryAdapter(homeDirectory),
    ],
    sessions: [
      new CodexSessionAdapter(homeDirectory, contentTokenCounter),
      new ClaudeSessionAdapter(homeDirectory, contentTokenCounter),
      new CursorSessionAdapter(homeDirectory, contentTokenCounter),
      new OpenCodeSessionAdapter(homeDirectory, contentTokenCounter),
    ],
  };
}
