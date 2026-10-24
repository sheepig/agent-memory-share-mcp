import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { SourceReference } from "../domain/source.js";
import { createDesktopAdapters } from "./desktop-sources.js";
import type { SourceAdapter } from "./source-adapter.js";

const directories: string[] = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const counter = { async countContentTokens(text: string) { return text.length; } };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function collect(adapters: SourceAdapter[]): Promise<SourceReference[]> {
  const found: SourceReference[] = [];
  for (const adapter of adapters) for await (const source of adapter.discover()) found.push(source);
  return found;
}

async function copy(home: string, fixture: string, destination: string): Promise<string> {
  const file = path.join(home, destination);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(path.join(fixtures, fixture), file);
  return file;
}

describe("configured source paths", () => {
  it("relocates every Session format and retains Claude project Memory discovery", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-source-paths-"));
    directories.push(home);
    const codex = await copy(home, "codex-jsonl-v1.jsonl", "custom/codex/session.jsonl");
    const claude = await copy(home, "claude-jsonl-v1.jsonl", "custom/claude/project/session.jsonl");
    const cursor = await copy(home, "cursor-transcript-v1.jsonl", "custom/cursor/project/agent-transcripts/chat/session.jsonl");
    await copy(home, "codex-jsonl-v1.jsonl", ".codex/sessions/default.jsonl");
    await copy(home, "claude-jsonl-v1.jsonl", "custom/claude/project/subagents/ignored.jsonl");
    const memory = path.join(home, "custom/claude/project/memory/MEMORY.md");
    await fs.mkdir(path.dirname(memory));
    await fs.writeFile(memory, "# Evidence\nProject memory from the configured Claude project directory.");
    const databasePath = path.join(home, "custom/opencode.db");
    const fixture = JSON.parse(await fs.readFile(path.join(fixtures, "opencode-sqlite-v1.json"), "utf8"));
    const database = new Database(databasePath);
    database.exec("CREATE TABLE session(id TEXT, title TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);");
    database.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run(fixture.session.id, fixture.session.title, fixture.session.directory, fixture.session.timeUpdated);
    for (const message of fixture.messages) {
      database.prepare("INSERT INTO message VALUES(?,?,?,?)").run(message.id, fixture.session.id, message.timeCreated, JSON.stringify({ role: message.role }));
      database.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run(`${message.id}-part`, message.id, fixture.session.id, message.timeCreated, JSON.stringify({ type: "text", text: message.text }));
    }
    database.close();
    const adapters = createDesktopAdapters(home, counter, {
      codex: { sessionRoots: ["~/custom/codex"] },
      "claude-code": { projectRoots: ["~/custom/claude"] },
      cursor: { sessionRoots: [path.join(home, "custom/cursor")] },
      opencode: { databasePath },
    });

    const sessions = await collect(adapters.sessions);
    expect(sessions.map((source) => source.agent).sort()).toEqual(["claude-code", "codex", "cursor", "opencode"]);
    expect(sessions.map((source) => source.sourcePath)).toEqual(expect.arrayContaining([codex, claude, cursor, `${databasePath}#session/${fixture.session.id}`]));
    expect((await collect(adapters.memories)).map((source) => source.sourcePath)).toEqual([memory]);
  });

  it("supports independent Memory files and directories while preserving instruction and symlink filtering", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-memory-paths-"));
    directories.push(home);
    const root = path.join(home, "notes");
    await fs.mkdir(root);
    const codex = path.join(root, "codex.md");
    const claude = path.join(home, "claude-notes.md");
    await fs.writeFile(codex, "# Codex evidence\nConfigured portable memory.");
    await fs.writeFile(claude, "# Claude evidence\nConfigured portable memory.");
    await fs.writeFile(path.join(root, "AGENTS.md"), "Instruction files must remain excluded.");
    await fs.symlink(codex, path.join(root, "linked.md"));
    const adapters = createDesktopAdapters(home, counter, {
      codex: { sessionRoots: [], memoryRoots: ["~/notes"] },
      "claude-code": { projectRoots: [], memoryRoots: [claude] },
      cursor: { sessionRoots: [] },
    });

    const found = await collect(adapters.memories);
    expect(found.map((source) => source.sourcePath).sort()).toEqual([claude, codex].sort());
    expect(adapters.memories.flatMap((adapter) => adapter.takeDiagnostics?.() ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "symbolic_link_skipped" })]));
  });

  it("uses a distinct scan scope for changed paths but keeps equivalent paths stable", () => {
    const first = createDesktopAdapters("/source-home", counter, { codex: { sessionRoots: ["~/sessions"] } });
    const same = createDesktopAdapters("/source-home", counter, { codex: { sessionRoots: ["/source-home/sessions"] } });
    const changed = createDesktopAdapters("/source-home", counter, { codex: { sessionRoots: ["~/other"] } });
    expect(first.sessions[0]!.key).toBe(same.sessions[0]!.key);
    expect(first.sessions[0]!.key).not.toBe(changed.sessions[0]!.key);
  });
});
