import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceReference } from "../domain/source.js";
import { CodexMemoryAdapter, CodexSessionAdapter, OpenCodeSessionAdapter } from "./desktop-sources.js";

const temporaryDirectories: string[] = [];
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/codex-jsonl-v1.jsonl");
const counter = { async countContentTokens(text: string) { return [...text].length; } };
const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
};

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-source-discovery-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("resumable source qualification", () => {
  it("looks up Codex saved metadata by native identity without materializing the threads table", async () => {
    const root = await makeRoot();
    const file = path.join(root, "session.jsonl");
    await fs.copyFile(fixture, file);
    await fs.mkdir(path.join(root, ".codex"));
    const database = new Database(path.join(root, ".codex/state_5.sqlite"));
    database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, title TEXT, cwd TEXT)");
    database.prepare("INSERT INTO threads VALUES(?,?,?,?)").run("fixture-codex", file, "Saved title", "/synthetic/project");
    database.close();
    const adapter = new CodexSessionAdapter(root, counter, [root]);
    expect((await collect(adapter.discover()))[0]).toMatchObject({ title: "Saved title", projectPath: "/synthetic/project" });
  });

  it("advances invalid files and reuses both eligible and ineligible qualification without reading bodies", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "a.jsonl"), "{broken\n");
    await fs.copyFile(fixture, path.join(root, "b.jsonl"));
    const adapter = new CodexSessionAdapter(root, counter, [root]);
    const values = new Map<string, SourceReference | null>();
    const cache = {
      get(file: string, size: number, mtimeMs: number) { return values.get(`${file}:${size}:${mtimeMs}`); },
      set(file: string, size: number, mtimeMs: number, source: SourceReference | null) { values.set(`${file}:${size}:${mtimeMs}`, source); },
    };
    const first = await collect(adapter.discoverSteps({ cache }));
    expect(first.find((step) => step.cursor === path.join(root, "a.jsonl"))).toEqual({ cursor: path.join(root, "a.jsonl") });
    expect(first.filter((step) => step.source)).toHaveLength(1);
    const read = vi.spyOn(fs, "readFile");
    const second = await collect(adapter.discoverSteps({ cache }));
    expect(second).toEqual(first);
    expect(read).not.toHaveBeenCalled();
    const resumed = await collect(adapter.discoverSteps({ after: path.join(root, "a.jsonl"), cache }));
    expect(resumed.filter((step) => step.source)).toHaveLength(1);
  });

  it("rejects stale qualification at extraction while allowing current read-only conversation inspection", async () => {
    const root = await makeRoot();
    const file = path.join(root, "session.jsonl");
    await fs.copyFile(fixture, file);
    const adapter = new CodexSessionAdapter(root, counter, [root]);
    const [source] = await collect(adapter.discover());
    expect(source).toBeDefined();
    await fs.appendFile(file, "\n{}");
    await expect(collect(adapter.extract(source!))).rejects.toThrow("changed after discovery");
    expect((await collect(adapter.readConversation(source!))).length).toBeGreaterThan(0);
    const refreshed = await adapter.refresh(source!);
    expect(refreshed?.contentFingerprint).not.toBe(source!.contentFingerprint);
    expect((await collect(adapter.extract(refreshed!))).length).toBeGreaterThan(0);
    await fs.writeFile(file, "{}\n");
    expect(await adapter.refresh(source!)).toBeNull();
  });

  it("refreshes current Memory metadata and fingerprint directly without rescanning roots", async () => {
    const root = await makeRoot();
    const file = path.join(root, "evidence.md");
    await fs.writeFile(file, "---\ntitle: Original\n---\nOriginal evidence.");
    const adapter = new CodexMemoryAdapter("", [root]);
    const [source] = await collect(adapter.discover());
    await fs.writeFile(file, "---\ntitle: Updated\n---\nUpdated evidence.");
    const current = await adapter.refresh(source!);
    expect(current?.title).toBe("Updated");
    expect(current?.contentFingerprint).not.toBe(source!.contentFingerprint);
    await fs.rm(file);
    expect(await adapter.refresh(source!)).toBeNull();
  });

  it("pages OpenCode by update key, advances invalid sessions, and closes an interrupted iterator", async () => {
    const root = await makeRoot();
    const file = path.join(root, "opencode.db");
    const database = new Database(file);
    database.exec("CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, time_archived INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, time_created INTEGER, data TEXT);");
    const insert = database.prepare("INSERT INTO session VALUES(?,?,?,1,NULL)");
    for (let index = 0; index < 205; index += 1) insert.run(String(index).padStart(3, "0"), "Synthetic", "/synthetic");
    database.close();
    const adapter = new OpenCodeSessionAdapter(root, counter, file);
    const steps = await collect(adapter.discoverSteps());
    expect(steps).toHaveLength(205);
    expect(steps.every((step) => step.cursor && !step.source)).toBe(true);
    const resumed = await collect(adapter.discoverSteps({ after: steps[199]!.cursor }));
    expect(resumed).toEqual(steps.slice(200));
    const close = vi.spyOn(Database.prototype, "close");
    const iterator = adapter.discoverSteps()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(close).toHaveBeenCalledTimes(1);
    const reference: SourceReference = { agent: "opencode", contentFingerprint: "synthetic", sourceId: "200",
      sourcePath: `${file}#session/200`, sourceType: "session", updatedAt: new Date() };
    expect(await adapter.isAvailable(reference)).toBe(true);
    expect(await adapter.refresh(reference)).toBeNull(); // Existence is independent of content eligibility.
    const archived = new Database(file);
    archived.prepare("UPDATE session SET time_archived = 1 WHERE id = ?").run("200");
    archived.close();
    expect(await adapter.isAvailable(reference)).toBe(false);
    expect(await adapter.refresh(reference)).toBeNull();
  });
});
