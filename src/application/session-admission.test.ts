import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceReference } from "../domain/source.js";
import type { SessionSourceAdapter } from "../sources/source-adapter.js";
import { openDatabase } from "../storage/database.js";
import { createSourceService } from "./source-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

function source(id: string, agent = "codex", day = 1): SourceReference {
  return { agent, contentFingerprint: id, sourceId: id, sourcePath: `/synthetic/${id}`, sourceType: "session",
    updatedAt: new Date(Date.UTC(2026, 0, day)) };
}

function adapter(agent: string, sources: SourceReference[], counts: Record<string, number> = {}): SessionSourceAdapter {
  return {
    agent, key: `${agent}:session`,
    async *discover() { yield* sources; },
    extract: vi.fn(async function* (reference: SourceReference) {
      for (let index = 0; index < (counts[reference.sourceId] ?? 1); index += 1) {
        yield { body: `Durable evidence ${reference.sourceId} part ${index}`, location: `line:${index + 1}`, source: reference };
      }
    }),
    async *readConversation() {},
  };
}

async function workspace(adapters: SessionSourceAdapter[], limits: Record<string, number>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-admission-"));
  roots.push(root);
  const database = openDatabase(root);
  const service = createSourceService(database, { adapters: { memories: [], sessions: adapters }, sessionFragmentLimits: limits });
  return { root, database, service };
}

describe("automatic Session admission", () => {
  it("discovers priorities before generating vectors so old-first discovery does not embed evicted history", async () => {
    const sessions = adapter("codex", [source("old"), source("middle", "codex", 2), source("new", "codex", 3)]);
    const { database } = await workspace([sessions], { codex: 2 });
    const embedded: string[] = [];
    const service = createSourceService(database, { adapters: { memories: [], sessions: [sessions] }, sessionFragmentLimits: { codex: 2 },
      embeddingProvider: { modelId: "synthetic", async countContentTokens() { return 1; }, async embedQuery() { return Float32Array.from([1, 0]); },
        async embedPassages(texts) { embedded.push(...texts); return texts.map(() => Float32Array.from([1, 0])); } } });
    try {
      await service.scanSources();
      expect(embedded).toHaveLength(2);
      expect(embedded.every((text) => !text.includes("old"))).toBe(true);
    } finally { database.close(); }
  });

  it("automatically indexes more than 200 sessions within the fragment budget", async () => {
    const sessions = Array.from({ length: 205 }, (_, index) => source(`session-${index}`));
    const { database, service } = await workspace([adapter("codex", sessions)], { codex: 500 });
    try {
      await service.scanSources();
      const listed = await service.listSessions({ limit: 1, offset: 0 });
      expect(listed.counts.selected).toBe(205);
      expect(service.getIndexStatus()).toMatchObject({ sessionCapacity: { codex: { fragments: 205, fragmentLimit: 500 } } });
    } finally { database.close(); }
  });

  it("counts all text fragments, replaces older whole sessions, and isolates agent budgets", async () => {
    const codex = adapter("codex", [source("old"), source("new", "codex", 2)], { old: 2, new: 2 });
    const claude = adapter("claude-code", [source("claude", "claude-code")], { claude: 2 });
    const { database, service } = await workspace([codex, claude], { codex: 3, "claude-code": 2 });
    try {
      await service.scanSources();
      const listed = await service.listSessions({ limit: 20, offset: 0 });
      expect(listed.sessions.find((item) => item.sessionId === "old")).toMatchObject({ disposition: "discovered", admissionReason: "capacity" });
      expect(listed.sessions.filter((item) => item.disposition === "selected").map((item) => item.sessionId).sort()).toEqual(["claude", "new"]);
      expect(service.getIndexStatus()).toMatchObject({ sessionCapacity: { codex: { fragments: 2 }, "claude-code": { fragments: 2 } } });
    } finally { database.close(); }
  });

  it("preserves exclusions, fills freed capacity, and restores only within the budget", async () => {
    const sessions = adapter("codex", [source("old"), source("new", "codex", 2)]);
    const { database, service } = await workspace([sessions], { codex: 1 });
    try {
      await service.scanSources();
      const newest = (await service.listSessions({ limit: 20, offset: 0 })).sessions.find((item) => item.sessionId === "new")!;
      service.excludeSession(newest.candidateId);
      await service.scanSources();
      expect((await service.listSessions({ limit: 20, offset: 0 })).sessions.find((item) => item.sessionId === "old")?.disposition).toBe("selected");
      await service.scanSources();
      expect((await service.listSessions({ limit: 20, offset: 0 })).sessions.find((item) => item.sessionId === "new")?.disposition).toBe("excluded");
      expect(await service.restoreSession(newest.candidateId)).toMatchObject({ disposition: "selected", fragmentCount: 1 });
      expect(service.getIndexStatus()).toMatchObject({ sessionCapacity: { codex: { fragments: 1 } } });
    } finally { database.close(); }
  });

  it("keeps oversized sessions visible without repeatedly extracting unchanged content", async () => {
    const sessions = adapter("codex", [source("huge")], { huge: 4 });
    const { database, service } = await workspace([sessions], { codex: 3 });
    try {
      await service.scanSources();
      await service.scanSources();
      expect((await service.listSessions({ limit: 20, offset: 0 })).sessions[0]).toMatchObject({ disposition: "discovered", admissionReason: "oversized" });
      expect(sessions.extract).toHaveBeenCalledTimes(1);
      expect(service.getIndexStatus()).toMatchObject({ fragments: 0 });
    } finally { database.close(); }
  });

  it("converges to a reduced fragment budget after reopening without losing exclusions or audit", async () => {
    const sessions = adapter("codex", [source("old"), source("new", "codex", 2), source("excluded", "codex", 3)]);
    const { database, root, service } = await workspace([sessions], { codex: 5 });
    await service.scanSources();
    const excluded = (await service.listSessions({ limit: 20, offset: 0 })).sessions.find((item) => item.sessionId === "excluded")!;
    service.excludeSession(excluded.candidateId);
    database.close();
    const reopened = openDatabase(root);
    try {
      const reduced = createSourceService(reopened, { adapters: { sessions: [sessions], memories: [] }, sessionFragmentLimits: { codex: 1 } });
      await reduced.scanSources();
      expect((await reduced.listSessions({ limit: 20, offset: 0 })).sessions.find((item) => item.sessionId === "excluded")?.disposition).toBe("excluded");
      expect(reduced.getIndexStatus()).toMatchObject({ sessionCapacity: { codex: { fragments: 1 } } });
      expect(reopened.prepare("SELECT count(*) AS n FROM source_audit WHERE action = 'excluded'").get()).toEqual({ n: 1 });
    } finally { reopened.close(); }
  });
});
