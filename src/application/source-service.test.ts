import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSourceService as createSourceServiceBase, INDEX_RULE_VERSION } from "./source-service.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { openDatabase } from "../storage/database.js";

const temporaryDirectories: string[] = [];
const DISCOVERY_ASSISTANT_REPLY = "This final response records enough concrete implementation detail to remain useful when the session is searched again later.";
const SEARCH_ASSISTANT_REPLY = "已完成公开文本索引，并保留来源、角色、原文位置和内容指纹，后续可以按项目、Agent 与证据类型过滤，同时检查每条命中的可解释匹配信息。检索结果会继续指向原始文件，便于核对上下文和判断证据是否仍然适用。";
const UPDATED_ASSISTANT_REPLY = "更新后的事实已经重新建立索引，旧版本片段已在同一事务中替换，查询只会看到当前来源对应的公开正文与准确位置，不会混入此前版本。重新扫描仍会保留用户的选取决定和审计历史，并根据当前内容指纹验证派生数据。";

const testContentTokenCounter = {
  async countContentTokens(text: string) {
    return [...text].length;
  },
};

function createSourceService(
  database: Parameters<typeof createSourceServiceBase>[0],
  options: Parameters<typeof createSourceServiceBase>[1] = {},
) {
  return createSourceServiceBase(database, { contentTokenCounter: testContentTokenCounter, ...options });
}

const testEmbeddingProvider: EmbeddingProvider = {
  ...testContentTokenCounter,
  modelId: "test-embedding-v1",
  async embedPassages(texts) {
    return texts.map((text) => vectorFor(text));
  },
  async embedQuery(text) {
    return vectorFor(text);
  },
};

function vectorFor(text: string): Float32Array {
  if (/会话搜索|find prior conversations/iu.test(text)) return Float32Array.from([1, 0]);
  if (/数据库迁移/iu.test(text)) return Float32Array.from([0, 1]);
  return Float32Array.from([0.5, 0.5]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-sources-"));
  temporaryDirectories.push(root);
  const homeDirectory = path.join(root, "home");
  const dataDirectory = path.join(root, "data");
  await fs.mkdir(homeDirectory);
  const database = openDatabase(dataDirectory);
  return { dataDirectory, database, homeDirectory, root };
}

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
}

describe("source service", () => {
  it("uses Desktop persistent-import discovery rules and filters nested subagents", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const codexPath = path.join(homeDirectory, ".codex/sessions/2026/10/14/codex.jsonl");
    await writeJsonl(codexPath, [
      { type: "session_meta", payload: { id: "codex-main", cwd: "/project/codex" } },
      { timestamp: "2026-10-14T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex task with details" }] } },
      { timestamp: "2026-10-14T01:01:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: DISCOVERY_ASSISTANT_REPLY }] } },
    ]);
    const codexState = new Database(path.join(homeDirectory, ".codex/state_5.sqlite"));
    codexState.exec("CREATE TABLE threads(rollout_path TEXT, title TEXT, cwd TEXT)");
    codexState.prepare("INSERT INTO threads VALUES(?,?,?)").run(codexPath, "Saved Codex title", "/project/from-state");
    codexState.close();
    await writeJsonl(path.join(homeDirectory, ".claude/projects/demo/claude.jsonl"), [
      { timestamp: "2026-10-14T02:00:00.000Z", type: "user", sessionId: "claude-main", cwd: "/project/claude", message: { role: "user", content: "Claude task with details" } },
      { timestamp: "2026-10-14T02:01:00.000Z", type: "assistant", sessionId: "claude-main", message: { role: "assistant", content: DISCOVERY_ASSISTANT_REPLY } },
    ]);
    await writeJsonl(path.join(homeDirectory, ".claude/projects/demo/subagents/agent-researcher.jsonl"), [
      { type: "user", sessionId: "claude-child", message: { role: "user", content: "hidden child" } },
    ]);
    await writeJsonl(path.join(homeDirectory, ".cursor/projects/demo/agent-transcripts/chat/chat.jsonl"), [
      { timestamp: "2026-10-14T03:00:00.000Z", role: "user", message: { content: "Cursor task with details" } },
      { timestamp: "2026-10-14T03:01:00.000Z", role: "assistant", message: { content: DISCOVERY_ASSISTANT_REPLY } },
    ]);
    await writeJsonl(path.join(homeDirectory, ".cursor/projects/demo/agent-transcripts/chat/subagents/researcher.jsonl"), [
      { role: "user", message: { content: "hidden cursor child" } },
    ]);

    const openCodePath = path.join(homeDirectory, ".local/share/opencode/opencode.db");
    await fs.mkdir(path.dirname(openCodePath), { recursive: true });
    const openCode = new Database(openCodePath);
    openCode.exec(`
      CREATE TABLE session(id TEXT, title TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    openCode.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run("open-main", "OpenCode task", "/project/open", 1_700_000_000_000);
    openCode.prepare("INSERT INTO message VALUES(?,?,?,?)").run("m1", "open-main", 1_728_353_600_000, JSON.stringify({ role: "user" }));
    openCode.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p1", "m1", "open-main", 1, JSON.stringify({ type: "text", text: "OpenCode task with details" }));
    openCode.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p2", "m1", "open-main", 2, "{broken}");
    openCode.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p3", "m1", "open-main", 3, JSON.stringify({ type: "text", text: "<environment_context>hidden context</environment_context>" }));
    openCode.prepare("INSERT INTO message VALUES(?,?,?,?)").run("m2", "open-main", 1_728_353_660_000, JSON.stringify({ role: "assistant" }));
    openCode.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p4", "m2", "open-main", 4, JSON.stringify({ type: "text", text: DISCOVERY_ASSISTANT_REPLY }));
    openCode.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p5", "m2", "open-main", 5, JSON.stringify({ type: "text", text: "Additional visible detail." }));
    openCode.close();

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const result = await service.listSessions({ limit: 20, offset: 0 });

    expect(result.sessions.map((session) => session.agent).sort()).toEqual(["claude-code", "codex", "cursor", "opencode"]);
    expect(JSON.stringify(result)).not.toContain("child");
    expect(result.sessions.every((session) => session.disposition === "discovered")).toBe(true);
    expect(result.sessions.find((session) => session.agent === "codex")).toMatchObject({
      projectPath: "/project/from-state",
      title: "Saved Codex title",
    });
    const openCodeSession = result.sessions.find((session) => session.agent === "opencode")!;
    expect((await service.getSessionConversation(openCodeSession.candidateId)).messages).toEqual([
      { body: "OpenCode task with details", location: "message:1", role: "user", timestamp: "2024-10-08T02:13:20.000Z" },
      { body: `${DISCOVERY_ASSISTANT_REPLY}\nAdditional visible detail.`, location: "message:2", role: "assistant", timestamp: "2024-10-08T02:14:20.000Z" },
    ]);
    for (const session of result.sessions.filter((candidate) => candidate.agent !== "opencode")) {
      expect((await service.getSessionConversation(session.candidateId)).messages.every((message) => message.timestamp !== undefined)).toBe(true);
    }
    expect(service.listDiagnostics({ limit: 20 }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed_database_records", sourcePath: `${openCodePath}#session/open-main` }),
    ]));
    database.close();
  });

  it("requires one complete turn and the default visible-character thresholds", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const sessions = path.join(homeDirectory, ".codex/sessions/thresholds");
    const writeSession = async (id: string, user: string, assistant?: string) => {
      await writeJsonl(path.join(sessions, `${id}.jsonl`), [
        { type: "session_meta", payload: { id } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
        ...(assistant === undefined ? [] : [
          { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: assistant }] } },
        ]),
      ]);
    };

    await writeSession("eligible", "用".repeat(10), "答".repeat(90));
    await writeSession("no-assistant", "用".repeat(100));
    await writeSession("short-user", "用".repeat(9), "答".repeat(91));
    await writeSession("short-assistant", "用".repeat(51), "答".repeat(49));
    await writeSession("short-total", "用".repeat(10), "答".repeat(89));

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();

    expect((await service.listSessions({ limit: 20, offset: 0 })).sessions.map((session) => session.sessionId)).toEqual(["eligible"]);
    expect(service.listDiagnostics({ limit: 20 }).diagnostics.filter((diagnostic) => diagnostic.code === "session_below_minimum_content"))
      .toHaveLength(4);
    database.close();
  });

  it("omits machine-only policy sessions while preserving ordinary JSON messages", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const policyPath = path.join(homeDirectory, ".codex/sessions/2026/10/14/policy.jsonl");
    await writeJsonl(policyPath, [
      { type: "session_meta", payload: { id: "policy-only", cwd: "/project/security" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are a policy reviewer." }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>generated context</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "The following is the Codex agent history added since your last approval assessment.\ngenerated transcript" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify({
        outcome: "allow",
        rationale: "The requested test is bounded and non-destructive.",
        risk_level: "low",
        user_authorization: "high",
      }) }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "{\"outcome\":\"allow\"}" }] } },
    ]);
    const jsonPath = path.join(homeDirectory, ".codex/sessions/2026/10/14/json.jsonl");
    await writeJsonl(jsonPath, [
      { type: "session_meta", payload: { id: "ordinary-json", cwd: "/project/json" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "<recommended_plugins>generated</recommended_plugins>" },
        { type: "input_text", text: "# AGENTS.md instructions for /project/json\n<INSTRUCTIONS>generated</INSTRUCTIONS>" },
        { type: "input_text", text: "<environment_context>generated</environment_context>" },
      ] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "# AGENTS.md instructions for /project/json\n<INSTRUCTIONS>generated</INSTRUCTIONS>" },
        { type: "input_text", text: "{\"feature\":\"search\",\"enabled\":true}" },
      ], internal_chat_message_metadata_passthrough: { content_item_kinds: ["agents_md.instructions", "user.text"] } } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: DISCOVERY_ASSISTANT_REPLY }] } },
    ]);

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const initial = await service.listSessions({ limit: 20, offset: 0 });
    expect(initial.sessions.map((session) => session.sessionId)).toEqual(["ordinary-json"]);
    expect((await service.getSessionConversation(initial.sessions[0]!.candidateId)).messages[0]?.body)
      .toBe("{\"feature\":\"search\",\"enabled\":true}");

    await writeJsonl(jsonPath, [
      { type: "session_meta", payload: { id: "ordinary-json", cwd: "/project/json" } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify({
        outcome: "deny",
        rationale: "The action is outside the authorized scope.",
        risk_level: "high",
        user_authorization: "low",
      }) }] } },
    ]);
    await service.scanSources();
    expect((await service.listSessions({ limit: 20, offset: 0 })).sessions).toHaveLength(0);
    database.close();
  });

  it("auto-indexes memory but indexes a session only after explicit selection", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const sessionPath = path.join(homeDirectory, ".codex/sessions/2026/10/14/session.jsonl");
    await writeJsonl(sessionPath, [
      { type: "session_meta", payload: { id: "codex-search", cwd: "/project/search" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>private injected context</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "The following is the Codex agent history whose request action you are assessing.\nprivate approval transcript\n## My request:\nprivate nested request" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "实现准确的跨会话搜索功能" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "private reasoning" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: SEARCH_ASSISTANT_REPLY }] } },
      { type: "response_item", payload: { type: "custom_tool_call_output", output: "private tool output" } },
    ]);
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(memoryPath, "# Durable memory\n保留数据库迁移事实。");

    const embeddedPassages: string[] = [];
    const embeddingProvider: EmbeddingProvider = {
      ...testEmbeddingProvider,
      async embedPassages(texts) {
        embeddedPassages.push(...texts);
        return texts.map((text) => vectorFor(text));
      },
    };
    const service = createSourceService(database, { embeddingProvider, homeDirectory });
    await service.scanSources();
    const before = await service.searchFragments({ limit: 20, query: "会话搜索" });
    expect(before.results).toHaveLength(0);
    const memory = await service.searchFragments({ limit: 20, query: "数据库迁移", sourceType: "memory" });
    expect(memory.results).toHaveLength(1);
    expect(memory.results[0]?.sourcePath).toBe(memoryPath);
    expect((await service.searchFragments({
      limit: 20,
      query: "数据库迁移",
      updatedAfter: "2999-01-01T00:00:00.000Z",
    })).results).toHaveLength(0);
    expect((await service.searchFragments({
      limit: 20,
      query: "数据库迁移",
      updatedBefore: "2999-01-01T00:00:00.000Z",
    })).results).toHaveLength(1);

    const sessions = await service.listSessions({ limit: 20, offset: 0 });
    const candidate = sessions.sessions.find((session) => session.sessionId === "codex-search");
    expect(candidate).toBeDefined();
    const conversation = await service.getSessionConversation(candidate!.candidateId);
    expect(conversation.session.disposition).toBe("discovered");
    expect(conversation.messages).toEqual([
      { body: "实现准确的跨会话搜索功能", location: "line:4", role: "user" },
      { body: SEARCH_ASSISTANT_REPLY, location: "line:6", role: "assistant" },
    ]);
    expect(JSON.stringify(conversation)).not.toContain("private");
    database.prepare("UPDATE sources SET title = ? WHERE id = ?").run("display-title-only-marker", candidate!.candidateId);
    await service.indexSession(candidate!.candidateId);
    await service.indexSession(candidate!.candidateId);

    expect(database.prepare(`
      SELECT f.title, f.chunk_index AS chunkIndex, f.content_tokens AS contentTokenCount
      FROM fragments f WHERE f.source_id = ?
    `).get(candidate!.candidateId)).toMatchObject({ chunkIndex: 0, title: null });
    expect(embeddedPassages.some((text) => text.includes("display-title-only-marker"))).toBe(false);
    expect((await service.searchFragments({ limit: 20, query: "display-title-only-marker", sourceType: "session" })).results)
      .toHaveLength(0);

    const result = await service.searchFragments({ limit: 20, query: "会话搜索", sourceType: "session" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      agent: "codex",
      endLocation: "line:6",
      location: "line:4",
      projectPath: "/project/search",
      sourcePath: sessionPath,
      sourceType: "session",
      title: "display-title-only-marker",
      turnCount: 1,
    });
    expect(result.results[0]?.chunkIndex).toBe(0);
    expect(result.results[0]?.contentTokenCount).toBeGreaterThan(0);
    expect(result.results[0]?.contentTokenCount).toBeLessThanOrEqual(1_024);
    const semantic = await service.searchFragments({
      limit: 20,
      mode: "semantic",
      query: "find prior conversations",
      sourceType: "session",
    });
    expect(semantic.results[0]).toMatchObject({
      matchReason: "semantic similarity",
      sessionId: "codex-search",
      sourcePath: sessionPath,
    });
    expect(semantic.results[0]?.score).toBeCloseTo(1);
    expect(JSON.stringify(await service.searchFragments({ limit: 20, query: "private" }))).not.toContain("private");
    expect(database.prepare("SELECT count(*) AS count FROM fragments").get()).toMatchObject({ count: 2 });

    database.prepare("UPDATE sources SET index_rule_version = 6 WHERE id = ?").run(candidate!.candidateId);
    expect(await service.scanSources()).toMatchObject({ indexed: 1 });
    expect(database.prepare("SELECT index_rule_version AS version FROM sources WHERE id = ?").get(candidate!.candidateId))
      .toMatchObject({ version: INDEX_RULE_VERSION });
    database.prepare("UPDATE sources SET security_rule_version = 1 WHERE id = ?").run(candidate!.candidateId);
    expect(await service.scanSources()).toMatchObject({ indexed: 1 });
    expect(database.prepare("SELECT security_rule_version AS version FROM sources WHERE id = ?").get(candidate!.candidateId))
      .toMatchObject({ version: 2 });

    service.excludeSession(candidate!.candidateId);
    await service.scanSources();
    expect((await service.searchFragments({ limit: 20, query: "会话搜索", sourceType: "session" })).results).toHaveLength(0);
    expect((await service.listSessions({ limit: 20, offset: 0 })).sessions[0]?.disposition).toBe("excluded");
    await service.restoreSession(candidate!.candidateId);
    expect((await service.searchFragments({ limit: 20, query: "会话搜索", sourceType: "session" })).results).toHaveLength(1);

    expect(service.prepareRebuild()).toBe(2);
    expect((await service.searchFragments({ limit: 20, query: "会话搜索" })).results).toHaveLength(0);
    expect(await service.scanSources()).toMatchObject({ indexed: 2 });
    expect((await service.searchFragments({ limit: 20, query: "会话搜索" })).results).toHaveLength(1);

    await writeJsonl(sessionPath, [
      { type: "session_meta", payload: { id: "codex-search", cwd: "/project/search" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "更新后的工作事实已经确认" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: UPDATED_ASSISTANT_REPLY }] } },
    ]);
    await service.scanSources();
    expect((await service.searchFragments({ limit: 20, query: "工作事实", sourceType: "session" })).results).toHaveLength(1);
    expect((await service.searchFragments({ limit: 20, query: "会话搜索", sourceType: "session" })).results).toHaveLength(0);
    database.close();
  });

  it("indexes only distilled Markdown memory locations", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const files = new Map([
      [path.join(homeDirectory, ".codex/memories/MEMORY.md"), "# Codex memory\nDistilled codex fact."],
      [path.join(homeDirectory, ".claude/projects/demo/memory/MEMORY.md"), "# Claude memory\nDistilled claude fact."],
      [path.join(homeDirectory, ".codex/AGENTS.md"), "# Instructions\nDo not index codex instructions."],
      [path.join(homeDirectory, ".cursor/rules/global.md"), "# Rule\nDo not index cursor rules."],
      [path.join(homeDirectory, ".config/opencode/commands/review.md"), "# Command\nDo not index opencode commands."],
      [path.join(homeDirectory, ".codex/memories/notes.txt"), "Do not index non-Markdown memory."],
    ]);
    for (const [file, body] of files) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    }

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();

    expect((database.prepare("SELECT agent, source_path FROM sources WHERE source_type = 'memory' ORDER BY agent").all()))
      .toEqual([
        { agent: "claude-code", source_path: path.join(homeDirectory, ".claude/projects/demo/memory/MEMORY.md") },
        { agent: "codex", source_path: path.join(homeDirectory, ".codex/memories/MEMORY.md") },
      ]);
    expect((await service.searchFragments({ limit: 20, query: "Distilled" })).results).toHaveLength(2);
    expect((await service.searchFragments({ limit: 20, query: "instructions rules commands" })).results).toHaveLength(0);

    const legacyId = "c".repeat(64);
    database.prepare(`
      INSERT INTO sources (
        id, source_type, agent, external_source_id, title, source_path, project_path,
        content_fingerprint, indexed_fingerprint, disposition, processing_state,
        source_updated_at, last_seen_at, error_message, index_rule_version,
        embedding_state, embedding_model_id, embedding_error
      ) VALUES (?, 'memory', 'cursor', 'legacy-rule', 'global.md', ?, NULL,
        'fingerprint', 'fingerprint', 'selected', 'indexed', ?, ?, NULL, 8,
        'disabled', NULL, NULL)
    `).run(legacyId, path.join(homeDirectory, ".cursor/rules/global.md"), new Date().toISOString(), new Date().toISOString());
    await service.scanSources();
    expect((database.prepare("SELECT processing_state FROM sources WHERE id = ?").get(legacyId) as { processing_state: string }).processing_state)
      .toBe("source_unavailable");
    database.close();
  });

  it("preserves explicit Memory frontmatter and uses project context only as a ranking preference", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const memoryDirectory = path.join(homeDirectory, ".codex/memories");
    await fs.mkdir(memoryDirectory, { recursive: true });
    await fs.writeFile(path.join(memoryDirectory, "first.md"), [
      "---",
      "title: Project Alpha",
      "project_path: /workspace/alpha",
      "session_id: source-session-alpha",
      "tags: [durable, project]",
      "---",
      "# Shared topic",
      "The same searchable ranking phrase belongs to alpha.",
    ].join("\n"));
    await fs.writeFile(path.join(memoryDirectory, "second.md"), [
      "---",
      "title: Project Beta",
      "project_path: /workspace/beta",
      "---",
      "# Shared topic",
      "The same searchable ranking phrase belongs to beta.",
    ].join("\n"));
    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();

    const preferred = await service.searchFragments({
      contextProjectPath: "/workspace/beta",
      limit: 20,
      query: "same searchable ranking phrase",
    });
    expect(preferred.results.map((result) => result.projectPath)).toEqual(["/workspace/beta", "/workspace/alpha"]);
    expect(preferred.results[0]?.matchReason).toContain("project context");
    const alpha = (await service.searchFragments({ limit: 20, projectPath: "/workspace/alpha", query: "searchable ranking" })).results[0];
    expect(alpha).toMatchObject({
      originalSessionId: "source-session-alpha",
      projectPath: "/workspace/alpha",
      title: "Project Alpha",
      location: "line:7",
      endLocation: "line:8",
    });
    expect(database.prepare("SELECT explicit_metadata_json AS metadata FROM sources WHERE project_path = '/workspace/alpha'").get())
      .toMatchObject({ metadata: expect.stringContaining('"tags":["durable","project"]') });
    database.close();
  });

  it("resumes a persisted adapter scan generation before deciding that sources disappeared", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const firstPath = path.join(homeDirectory, ".codex/sessions/first.jsonl");
    const secondPath = path.join(homeDirectory, ".codex/sessions/second.jsonl");
    for (const [sessionPath, id] of [[firstPath, "first"], [secondPath, "second"]] as const) {
      await writeJsonl(sessionPath, [
        { type: "session_meta", payload: { id } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Request ${id} with enough detail` }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: DISCOVERY_ASSISTANT_REPLY }] } },
      ]);
    }
    const now = new Date();
    await fs.utimes(firstPath, now, new Date(now.getTime() + 2_000));
    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const scanId = "persisted-scan-generation";
    database.prepare("UPDATE sources SET last_seen_scan_id = NULL WHERE agent = 'codex' AND source_type = 'session'").run();
    database.prepare("UPDATE sources SET last_seen_scan_id = ? WHERE source_path = ?").run(scanId, firstPath);
    database.prepare("INSERT INTO scan_checkpoints(adapter_key, scan_id, cursor, started_at) VALUES('codex:session', ?, ?, ?)")
      .run(scanId, firstPath, new Date().toISOString());

    const resumed = await service.scanSources();
    expect(resumed.unavailable).toBe(0);
    expect((await service.listSessions({ limit: 20, offset: 0 })).sessions.map((session) => session.sessionId).sort()).toEqual(["first", "second"]);
    expect(database.prepare("SELECT count(*) AS count FROM scan_checkpoints WHERE adapter_key = 'codex:session'").get()).toEqual({ count: 0 });
    database.close();
  });

  it("discovers file sessions across multiple scan batches", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    for (let index = 0; index < 205; index += 1) {
      await writeJsonl(path.join(homeDirectory, `.codex/sessions/batches/${index}.jsonl`), [
        { type: "session_meta", payload: { id: `batch-${index}` } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Batch request ${index}` }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: DISCOVERY_ASSISTANT_REPLY }] } },
      ]);
    }

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();

    expect((await service.listSessions({ limit: 1, offset: 0 })).total).toBe(205);
    database.close();
  });

  it("keeps keyword search usable and resumes only missing embedding batches after restart", async () => {
    const { dataDirectory, database, homeDirectory } = await makeWorkspace();
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(memoryPath, [...Array(17).keys()].map((index) => (
      `# Memory ${index + 1}\nDurable searchable fact ${index + 1}. ${"Supporting detail. ".repeat(10)}`
    )).join("\n\n"));
    let firstCalls = 0;
    const interruptedProvider: EmbeddingProvider = {
      ...testContentTokenCounter,
      modelId: "resume-model",
      async embedPassages(texts) {
        firstCalls += 1;
        if (firstCalls > 1) throw new Error("embedding process interrupted");
        return texts.map(() => Float32Array.from([1, 0]));
      },
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
    };
    const interrupted = createSourceService(database, { embeddingProvider: interruptedProvider, homeDirectory });
    await interrupted.scanSources();

    expect((await interrupted.searchFragments({ limit: 20, query: "17" })).results).toHaveLength(1);
    expect((database.prepare("SELECT count(*) AS count FROM fragment_embeddings").get() as { count: number }).count).toBe(16);
    expect((database.prepare("SELECT embedding_state FROM sources WHERE source_type = 'memory'").get() as { embedding_state: string }).embedding_state)
      .toBe("failed");
    expect(await interrupted.retryFailedEmbeddings()).toEqual({ attempted: 1, failed: 1, indexed: 0 });
    database.close();

    const reopened = openDatabase(dataDirectory);
    const resumedBatchSizes: number[] = [];
    const resumedProvider: EmbeddingProvider = {
      ...testContentTokenCounter,
      modelId: "resume-model",
      async embedPassages(texts) {
        resumedBatchSizes.push(texts.length);
        return texts.map(() => Float32Array.from([1, 0]));
      },
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
    };
    const resumed = createSourceService(reopened, { embeddingProvider: resumedProvider, homeDirectory });
    await resumed.scanSources();

    expect(resumedBatchSizes).toEqual([1]);
    expect((reopened.prepare("SELECT count(*) AS count FROM fragment_embeddings").get() as { count: number }).count).toBe(17);
    expect((reopened.prepare("SELECT embedding_state FROM sources WHERE source_type = 'memory'").get() as { embedding_state: string }).embedding_state)
      .toBe("indexed");
    reopened.close();

    const finalDatabase = openDatabase(dataDirectory);
    let unexpectedEmbeddingCalls = 0;
    const finalProvider: EmbeddingProvider = {
      ...testContentTokenCounter,
      modelId: "resume-model",
      async embedPassages(texts) {
        unexpectedEmbeddingCalls += 1;
        return texts.map(() => Float32Array.from([1, 0]));
      },
      async embedQuery() {
        return Float32Array.from([1, 0]);
      },
    };
    await createSourceService(finalDatabase, { embeddingProvider: finalProvider, homeDirectory }).scanSources();
    expect(unexpectedEmbeddingCalls).toBe(0);
    finalDatabase.close();
  });

  it("looks past many matching chunks from one turn before filling top-k with repeats", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const sessionPath = path.join(homeDirectory, ".codex/sessions/diversity.jsonl");
    await writeJsonl(sessionPath, [
      { type: "session_meta", payload: { id: "diversity" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "needle ".repeat(10_000) }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: SEARCH_ASSISTANT_REPLY }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${"z".repeat(950)} needle` }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: SEARCH_ASSISTANT_REPLY }] } },
    ]);
    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const candidate = (await service.listSessions({ limit: 20, offset: 0 })).sessions[0]!;
    await service.indexSession(candidate.candidateId);

    const result = await service.searchFragments({ limit: 2, query: "needle", sourceType: "session" });

    expect(result.results.map((item) => item.location)).toEqual(["line:2", "line:4"]);
    database.close();
  });

  it("keeps valid records from malformed JSONL and skips symlinks and oversized sessions", async () => {
    const { database, homeDirectory, root } = await makeWorkspace();
    const sessions = path.join(homeDirectory, ".claude/projects/demo");
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(path.join(sessions, "valid.jsonl"), [
      "{broken}",
      JSON.stringify({ type: "user", sessionId: "valid", message: { role: "user", content: "Retain valid records for indexing" } }),
      JSON.stringify({ type: "assistant", sessionId: "valid", message: { role: "assistant", content: DISCOVERY_ASSISTANT_REPLY } }),
    ].join("\n"));
    const outside = path.join(root, "outside.jsonl");
    await writeJsonl(outside, [{ type: "user", sessionId: "outside", message: { role: "user", content: "Do not follow" } }]);
    await fs.symlink(outside, path.join(sessions, "linked.jsonl"));
    const oversized = await fs.open(path.join(sessions, "oversized.jsonl"), "w");
    await oversized.truncate(16_000_001);
    await oversized.close();

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const result = await service.listSessions({ limit: 20, offset: 0 });

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["valid"]);
    const diagnostics = service.listDiagnostics({ limit: 20 }).diagnostics;
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "malformed_jsonl_records", sourcePath: path.join(sessions, "valid.jsonl") }),
      expect.objectContaining({ code: "symbolic_link_skipped", sourcePath: path.join(sessions, "linked.jsonl") }),
      expect.objectContaining({ code: "session_source_skipped", sourcePath: path.join(sessions, "oversized.jsonl") }),
    ]));
    await service.scanSources();
    expect(service.listDiagnostics({ limit: 20 }).diagnostics).toHaveLength(diagnostics.length);
    expect(service.listDiagnostics({ limit: 20 }).diagnostics.find((diagnostic) => diagnostic.code === "malformed_jsonl_records"))
      .toMatchObject({ occurrenceCount: 2, resolvedAt: null });
    await writeJsonl(path.join(sessions, "valid.jsonl"), [
      { type: "user", sessionId: "valid", message: { role: "user", content: "Retain valid records for indexing" } },
      { type: "assistant", sessionId: "valid", message: { role: "assistant", content: DISCOVERY_ASSISTANT_REPLY } },
    ]);
    await service.scanSources();
    expect(service.listDiagnostics({ limit: 20 }).diagnostics.find((diagnostic) => diagnostic.code === "malformed_jsonl_records"))
      .toMatchObject({ occurrenceCount: 2, resolvedAt: expect.any(String) });
    database.close();
  });

  it("redacts credential-like lines before persistence", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(memoryPath, "# Authentication\napi_key=abcdefghijklmnopqrstuvwxyz123456\nUse the official login flow.");

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    await service.searchFragments({ limit: 20, query: "official login" });
    const bodies = database.prepare("SELECT body FROM fragments").all() as Array<{ body: string }>;

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.body).toContain("[credential-like content omitted]");
    expect(bodies[0]?.body).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(service.listDiagnostics({ limit: 20 }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "sensitive_content_redacted", sourcePath: memoryPath }),
    ]));
    expect(database.prepare("SELECT action FROM source_audit WHERE action = 'sensitive_content_redacted'").all())
      .toEqual([{ action: "sensitive_content_redacted" }]);
    database.close();
  });

  it("diagnoses bounded memory and database source failures without following links", async () => {
    const { database, homeDirectory, root } = await makeWorkspace();
    const memories = path.join(homeDirectory, ".codex/memories");
    await fs.mkdir(memories, { recursive: true });
    await fs.writeFile(path.join(memories, "valid.md"), "# Valid\nRetain bounded memory.");
    const outside = path.join(root, "outside.md");
    await fs.writeFile(outside, "Linked memory must not be read.");
    await fs.symlink(outside, path.join(memories, "linked.md"));
    const oversized = await fs.open(path.join(memories, "oversized.md"), "w");
    await oversized.truncate(2_000_001);
    await oversized.close();
    const openCodePath = path.join(homeDirectory, ".local/share/opencode/opencode.db");
    await fs.mkdir(path.dirname(openCodePath), { recursive: true });
    await fs.writeFile(openCodePath, "not a sqlite database");

    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();

    expect((await service.searchFragments({ limit: 20, query: "bounded memory" })).results).toHaveLength(1);
    expect((await service.searchFragments({ limit: 20, query: "Linked" })).results).toHaveLength(0);
    expect(service.listDiagnostics({ limit: 20 }).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "symbolic_link_skipped", sourcePath: path.join(memories, "linked.md") }),
      expect.objectContaining({ code: "memory_source_skipped", sourcePath: path.join(memories, "oversized.md") }),
      expect.objectContaining({ code: "session_source_skipped", sourcePath: openCodePath }),
    ]));
    database.close();
  });

  it("bounds retained diagnostics while keeping recent records", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const insert = database.prepare("INSERT INTO scan_diagnostics(level, code, message, created_at, last_seen_at) VALUES('warning', ?, ?, ?, ?)");
    const now = new Date().toISOString();
    database.transaction(() => {
      for (let index = 0; index < 1_005; index += 1) insert.run(`code-${index}`, `message-${index}`, now, now);
    })();
    await createSourceService(database, { homeDirectory }).scanSources();
    expect(database.prepare("SELECT count(*) AS count FROM scan_diagnostics").get()).toEqual({ count: 1_000 });
    expect(database.prepare("SELECT code FROM scan_diagnostics ORDER BY id DESC LIMIT 1").get()).toEqual({ code: "code-1004" });
    database.close();
  });

  it("recovers interrupted indexing so the worker can retry it", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const memoryPath = path.join(homeDirectory, ".codex/memories/MEMORY.md");
    await fs.mkdir(path.dirname(memoryPath), { recursive: true });
    await fs.writeFile(memoryPath, "# Recovery\nRetry interrupted indexing.");
    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    database.prepare("UPDATE sources SET processing_state = 'indexing'").run();

    expect(service.recoverInterrupted()).toBe(1);
    expect(database.prepare("SELECT processing_state AS state FROM sources").get()).toMatchObject({ state: "source_changed" });
    await service.scanSources();
    expect(database.prepare("SELECT processing_state AS state FROM sources").get()).toMatchObject({ state: "indexed" });
    expect(service.listDiagnostics({ limit: 10 }).diagnostics[0]).toMatchObject({ code: "index_interrupted" });
    database.close();
  });

  it("hides a missing selected source and reindexes it when it returns", async () => {
    const { database, homeDirectory } = await makeWorkspace();
    const sessionPath = path.join(homeDirectory, ".codex/sessions/session.jsonl");
    await writeJsonl(sessionPath, [
      { type: "session_meta", payload: { id: "returning-session", cwd: "/project/returning" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Original indexed fact with context" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: DISCOVERY_ASSISTANT_REPLY }] } },
    ]);
    const service = createSourceService(database, { homeDirectory });
    await service.scanSources();
    const candidate = (await service.listSessions({ limit: 20, offset: 0 })).sessions[0]!;
    await service.indexSession(candidate.candidateId);
    const auditCount = (database.prepare("SELECT count(*) AS count FROM source_audit").get() as { count: number }).count;

    await service.scanSources();
    expect((database.prepare("SELECT count(*) AS count FROM source_audit").get() as { count: number }).count).toBe(auditCount);

    expect((await service.searchFragments({ limit: 20, query: "Original" })).results).toHaveLength(1);
    await fs.unlink(sessionPath);
    expect(await service.scanSources()).toMatchObject({ unavailable: 1 });
    expect((await service.searchFragments({ limit: 20, query: "Original" })).results).toHaveLength(0);
    expect((await service.listSessions({ limit: 20, offset: 0 })).sessions[0]?.indexStatus).toBe("source_unavailable");
    expect(service.listDiagnostics({ limit: 10, sourceId: candidate.candidateId }).diagnostics[0]).toMatchObject({
      code: "source_unavailable",
    });

    await writeJsonl(sessionPath, [
      { type: "session_meta", payload: { id: "returning-session", cwd: "/project/returning" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Replacement indexed fact with context" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: UPDATED_ASSISTANT_REPLY }] } },
    ]);
    expect(await service.scanSources()).toMatchObject({ indexed: 1 });
    expect((await service.searchFragments({ limit: 20, query: "Replacement indexed fact" })).results).toHaveLength(1);
    expect((await service.searchFragments({ limit: 20, query: "Original" })).results).toHaveLength(0);
    database.close();
  });
});
