import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { CodexMemoryAdapter, createDesktopAdapters } from "./desktop-sources.js";

const temporaryDirectories: string[] = [];
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { force: true, recursive: true })));
});

describe("source format compatibility matrix", () => {
  it("locates Memory chunks in the original file including frontmatter and blank lines", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-lines-"));
    temporaryDirectories.push(home);
    const sourcePath = path.join(home, ".codex/memories/example.md");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, ["---", "title: Example", "---", "", "# Body", "first", "", "# Next", "second", ""].join("\n"));
    const adapter = new CodexMemoryAdapter(home);
    const documents = [];
    for await (const source of adapter.discover()) {
      for await (const document of adapter.extract(source)) documents.push(document);
    }
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ location: "line:5", endLocation: "line:9", title: "Example" });
  });

  it("discovers every declared synthetic format fixture", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-formats-"));
    temporaryDirectories.push(home);
    const copies = [
      ["codex-jsonl-v1.jsonl", ".codex/sessions/fixture.jsonl"],
      ["claude-jsonl-v1.jsonl", ".claude/projects/fixture/session.jsonl"],
      ["cursor-transcript-v1.jsonl", ".cursor/projects/fixture/agent-transcripts/chat/session.jsonl"],
    ] as const;
    for (const [fixture, destination] of copies) {
      const output = path.join(home, destination);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(path.join(fixtures, fixture), output);
    }
    const openCodeFixture = JSON.parse(await fs.readFile(path.join(fixtures, "opencode-sqlite-v1.json"), "utf8")) as {
      messages: Array<{ id: string; role: string; text: string; timeCreated: number }>;
      session: { directory: string; id: string; timeUpdated: number; title: string };
    };
    const databasePath = path.join(home, ".local/share/opencode/opencode.db");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.exec("CREATE TABLE session(id TEXT, title TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);");
    database.prepare("INSERT INTO session VALUES(?,?,?,?,NULL)").run(openCodeFixture.session.id, openCodeFixture.session.title, openCodeFixture.session.directory, openCodeFixture.session.timeUpdated);
    for (const message of openCodeFixture.messages) {
      database.prepare("INSERT INTO message VALUES(?,?,?,?)").run(message.id, openCodeFixture.session.id, message.timeCreated, JSON.stringify({ role: message.role }));
      database.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run(`${message.id}-part`, message.id, openCodeFixture.session.id, message.timeCreated, JSON.stringify({ type: "text", text: message.text }));
    }
    database.close();

    const adapters = createDesktopAdapters(home, {
      async countContentTokens(text) {
        return [...text].length;
      },
    });
    const discovered: string[] = [];
    for (const adapter of adapters.sessions) {
      for await (const source of adapter.discover()) discovered.push(source.agent);
    }
    expect(discovered.sort()).toEqual(["claude-code", "codex", "cursor", "opencode"]);
  });
});
