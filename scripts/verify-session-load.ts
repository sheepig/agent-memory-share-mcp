import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createSourceService } from "../src/application/source-service.js";
import type { SourceReference } from "../src/domain/source.js";
import { createSourceWorker } from "../src/server/source-worker.js";
import type { SessionSourceAdapter, SourceDiscoveryOptions } from "../src/sources/source-adapter.js";
import { openDatabase } from "../src/storage/database.js";

const project = fileURLToPath(new URL("../", import.meta.url));
const counts = process.argv.length > 2 ? process.argv.slice(2).map(Number) : [1_000, 10_000, 100_000];
if (counts.some((count) => !Number.isSafeInteger(count) || count < 1)) throw new Error("Counts must be positive integers.");
const agents = ["codex", "claude-code", "cursor", "opencode"];
const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-load-"));
const output = path.join(project, ".agent-memory-share-mcp/verification/session-auto-indexing/source-worker-load.json");
const codeFiles = ["application/source-service.ts", "application/session-capacity.ts", "application/discovery-cache.ts",
  "application/embedding-indexer.ts", "server/source-worker.ts", "storage/database.ts"];
const report = {
  scope: "Synthetic eligible references and one generated fragment each; no HTTP, file parsing, tokenizer, model or inference. Newest first, four Agents evenly distributed. Timer gaps measure scheduling responsiveness, not HTTP latency. RSS is sampled in one shared process.",
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
  sourceFingerprints: Object.fromEntries(await Promise.all(codeFiles.map(async (file) => [file,
    createHash("sha256").update(await fs.readFile(path.join(project, "src", file))).digest("hex")]))),
  results: [] as Array<Record<string, unknown>>,
};

try {
  for (const count of counts) {
    const database = openDatabase(path.join(root, String(count)));
    let extracted = 0;
    const sessions: SessionSourceAdapter[] = agents.map((agent, agentIndex) => {
      const reference = (index: number): SourceReference => ({ agent, sourceType: "session",
        sourceId: `${agent}-${index}`, sourcePath: `/synthetic/${agent}/${index}`, contentFingerprint: `synthetic-${index}`,
        updatedAt: new Date(Date.UTC(2026, 0, 1) - index * 1_000), discoveryCursor: String(index) });
      return {
        agent, key: `${agent}:session`,
        async *discover(options: SourceDiscoveryOptions = {}) {
          for (let index = options.after ? Number(options.after) + 4 : agentIndex; index < count; index += 4) yield reference(index);
        },
        async *discoverSteps(options: SourceDiscoveryOptions = {}) {
          for (let index = options.after ? Number(options.after) + 4 : agentIndex; index < count; index += 4) {
            yield { source: reference(index), cursor: String(index) };
          }
        },
        async *extract(source: SourceReference) {
          extracted += 1;
          yield { source, body: `Synthetic durable evidence ${source.sourceId}`, location: "line:1" };
        },
        async *readConversation() {},
      };
    });
    const service = createSourceService(database, { adapters: { sessions, memories: [] },
      sessionFragmentLimits: Object.fromEntries(agents.map((agent) => [agent, 5_000])) });
    const worker = createSourceWorker(service, { intervalMs: 0 });
    let peakRss = process.memoryUsage().rss;
    let lastTick = performance.now();
    let maxTimerGapMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxTimerGapMs = Math.max(maxTimerGapMs, now - lastTick);
      lastTick = now;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 10);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    try {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      await worker.start();
      const elapsedMs = performance.now() - start;
      const { candidates } = database.prepare("SELECT count(*) AS candidates FROM sources").get() as { candidates: number };
      const { fragments } = database.prepare("SELECT count(*) AS fragments FROM fragments").get() as { fragments: number };
      const { checkpoints } = database.prepare("SELECT count(*) AS checkpoints FROM scan_checkpoints").get() as { checkpoints: number };
      if (candidates !== count || fragments !== Math.min(count, 20_000) || checkpoints !== 0) throw new Error("Capacity or progress invariant failed.");
      const result = { count, startedAt, finishedAt: new Date().toISOString(), elapsedMs, candidates, fragments, extracted,
        maxTimerGapMs, longSchedulingGapObserved: maxTimerGapMs > 5_000,
        eventLoopP95Ms: delay.percentile(95) / 1e6, peakRssMiB: peakRss / 1024 / 1024,
        capacity: service.getIndexStatus().sessionCapacity };
      report.results.push(result);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify(report, null, 2));
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      clearInterval(timer);
      delay.disable();
      await worker.stop();
      database.close();
    }
  }
} finally { await fs.rm(root, { force: true, recursive: true }); }
