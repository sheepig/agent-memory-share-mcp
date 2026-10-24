import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceReference } from "../domain/source.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import type { SessionSourceAdapter, SourceAdapter } from "../sources/source-adapter.js";
import { openDatabase } from "../storage/database.js";
import { createSourceService } from "./source-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true }))); });

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-resume-"));
  roots.push(root);
  return { database: openDatabase(root), root };
}

const reference: SourceReference = { agent: "codex", sourceId: "evidence", sourcePath: "/synthetic/evidence",
  sourceType: "session", contentFingerprint: "evidence-1", updatedAt: new Date("2026-01-01T00:00:00Z") };

function adapter(source: SourceReference): SessionSourceAdapter {
  return { agent: source.agent, key: `${source.agent}:${source.sourceType}`,
    async *discover(options = {}) { if (!options.after) yield { ...source, discoveryCursor: source.sourcePath }; },
    extract: vi.fn(async function* () { yield { source, body: "Inspect durable source evidence.", location: "line:1" }; }),
    async *readConversation() {},
  };
}

describe("incremental source recovery", () => {
  it("recovers Memory text work when interrupted after discovery checkpoint but before indexing", async () => {
    const { database, root } = await workspace();
    const memory = adapter({ ...reference, sourceType: "memory" });
    const first = createSourceService(database, { adapters: { sessions: [], memories: [memory] } });
    const steps = first.scanSteps();
    await steps.next();
    await steps.return({ failed: 0, indexed: 0, memories: 0, sessions: 0, unavailable: 0 });
    expect(database.prepare("SELECT count(*) AS n FROM fragments").get()).toEqual({ n: 0 });
    database.close();
    const reopened = openDatabase(root);
    try {
      await createSourceService(reopened, { adapters: { sessions: [], memories: [memory] } }).scanSources();
      expect(reopened.prepare("SELECT count(*) AS n FROM fragments").get()).toEqual({ n: 1 });
      expect(memory.extract).toHaveBeenCalledOnce();
    } finally { reopened.close(); }
  });

  it("does not declare unseen sources missing after an incomplete discovery scope", async () => {
    const { database } = await workspace();
    const sessions = adapter(reference);
    try {
      const initial = createSourceService(database, { adapters: { sessions: [sessions], memories: [] } });
      await initial.scanSources();
      const interrupted: SessionSourceAdapter = { ...sessions, async *discoverSteps() { yield { complete: false }; } };
      await createSourceService(database, { adapters: { sessions: [interrupted], memories: [] } }).scanSources();
      expect((await initial.listSessions({ limit: 1, offset: 0 })).sessions[0]?.indexStatus).toBe("indexed");
      expect(database.prepare("SELECT count(*) AS n FROM scan_checkpoints").get()).toEqual({ n: 1 });
    } finally { database.close(); }
  });

  it.each([false, true])("discards an in-flight vector batch after exclusion, including inference failure=%s", async (fail) => {
    const { database } = await workspace();
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const running = new Promise<void>((resolve) => { started = resolve; });
    const provider: EmbeddingProvider = {
      modelId: "synthetic", async countContentTokens() { return 1; }, async embedQuery() { return Float32Array.from([1, 0]); },
      async embedPassages(texts) { started(); await pending; if (fail) throw new Error("synthetic inference failed"); return texts.map(() => Float32Array.from([1, 0])); },
    };
    const service = createSourceService(database, { adapters: { sessions: [adapter(reference)], memories: [] }, embeddingProvider: provider });
    const scan = service.scanSources();
    try {
      await running;
      const id = (await service.listSessions({ limit: 1, offset: 0 })).sessions[0]!.candidateId;
      service.excludeSession(id);
      release();
      await scan;
      expect(database.prepare("SELECT count(*) AS n FROM fragment_embeddings").get()).toEqual({ n: 0 });
      expect(database.prepare("SELECT disposition, embedding_state FROM sources").get()).toEqual({ disposition: "excluded", embedding_state: "disabled" });
      expect(service.getIndexStatus()).toMatchObject({ sessionCapacity: { codex: { fragments: 0 } } });
    } finally { release(); await scan; database.close(); }
  });

  it("backs off unchanged failed text work instead of retrying on every scan", async () => {
    const { database } = await workspace();
    const sessions: SourceAdapter = { ...adapter(reference), extract: vi.fn(async function* () { throw new Error("synthetic parse failure"); }) };
    const service = createSourceService(database, { adapters: { sessions: [sessions as SessionSourceAdapter], memories: [] } });
    try {
      await service.scanSources();
      await service.scanSources();
      expect(sessions.extract).toHaveBeenCalledOnce();
      expect((await service.listSessions({ limit: 1, offset: 0 })).sessions[0]?.indexStatus).toBe("failed");
    } finally { database.close(); }
  });
});
