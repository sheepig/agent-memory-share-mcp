import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { CodexEvaluationModel } from "./codex-model.js";
import { evaluationConfigSchema } from "./types.js";

const roots: string[] = [];
const clients: CodexEvaluationModel[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(behavior = "normal") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-eval-test-"));
  roots.push(root);
  const homeDirectory = path.join(root, "login");
  await fs.mkdir(homeDirectory);
  await fs.writeFile(path.join(homeDirectory, "auth.json"), "{}", { mode: 0o600 });
  const command = path.join(root, "fake codex.cjs");
  const log = path.join(root, "events.jsonl");
  await fs.writeFile(command, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const log = ${JSON.stringify(log)};
const behavior = ${JSON.stringify(behavior)};
function record(value) { fs.appendFileSync(log, JSON.stringify(value) + "\\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
record({ args: process.argv.slice(2, 4), cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, inherited: process.env.EVAL_PARENT_ONLY });
if (process.argv[2] === "debug") {
  send(behavior === "injected" ? { instructions: "AGENTS.md" } : { instructions: [] });
} else {
  let count = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const rpc = JSON.parse(line);
    if (rpc.id === undefined) return;
    if (rpc.method === "thread/start") {
      record({ method: rpc.method, model: rpc.params.model, effort: rpc.params.config.model_reasoning_effort });
      send({ id: rpc.id, result: { model: behavior === "fallback" ? "wrong-model" : rpc.params.model, reasoningEffort: "high", instructionSources: behavior === "missing-audit" ? undefined : [], thread: { id: "thread-" + ++count, ephemeral: true, turns: [] } } });
    } else if (rpc.method === "turn/start") {
      send({ id: rpc.id, result: {} });
      const threadId = rpc.params.threadId;
      if (behavior === "tool") send({ method: "item/started", params: { threadId, item: { type: "commandExecution" } } });
      const data = behavior === "invalid" ? { relevance: "3" } : { relevance: 3 };
      send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: JSON.stringify(data) } } });
      send({ method: "turn/completed", params: { threadId, turn: { status: "completed" } } });
    } else send({ id: rpc.id, result: {} });
  });
}
`, { mode: 0o700 });
  const config = evaluationConfigSchema.parse({ schemaVersion: 1, outputDirectory: path.join(root, "output"), datasets: [{ type: "local", agent: "codex", id: "fixture", roots: [path.join(root, "sources")] }], codex: { command, homeDirectory, timeoutMs: 5000 } });
  const client = new CodexEvaluationModel(config);
  clients.push(client);
  return { client, root, log, config };
}
const schema = z.object({ relevance: z.number().int().min(0).max(3) });

it.skipIf(process.platform === "win32")("isolates native calls, verifies model/effort, caches exact inputs and removes the temporary login link", async () => {
  vi.stubEnv("EVAL_PARENT_ONLY", "unrelated-context");
  const { client, log, config } = await fixture();
  await Promise.all(["evidence A", "evidence B", "evidence A"].map((input) => client.json("fixture-model", "Fixture instruction", input, schema)));
  await client.json("fixture-model", "Fixture instruction", "evidence A", schema);
  const events = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const starts = events.filter((event) => event.method === "thread/start");
  expect(starts).toEqual(Array.from({ length: 2 }, () => ({ method: "thread/start", model: "fixture-model", effort: "high" })));
  const processEvent = events.find((event) => event.codexHome)!;
  expect(processEvent.cwd).not.toBe(process.cwd());
  expect(processEvent.home).not.toBe(os.homedir());
  expect(processEvent.inherited).toBeUndefined();
  expect(await fs.lstat(path.join(processEvent.codexHome, "auth.json")).then((stat) => stat.isSymbolicLink())).toBe(true);
  const files = await fs.readdir(path.join(config.outputDirectory, "codex-calls"));
  const receipts = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(config.outputDirectory, "codex-calls", file), "utf8"))));
  expect(new Set(receipts.map((receipt) => receipt.threadId)).size).toBe(2);
  expect(receipts.every((receipt) => receipt.initialTurns === 0 && !receipt.toolsUsed)).toBe(true);
  await client.close();
  await expect(fs.access(processEvent.codexHome)).rejects.toThrow();
});

it.skipIf(process.platform === "win32").each(["injected", "fallback", "missing-audit", "tool", "invalid"])("rejects %s responses without saving judgments", async (behavior) => {
  const { client, config } = await fixture(behavior);
  await expect(client.json("fixture-model", "Fixture instruction", "synthetic evidence", schema)).rejects.toThrow();
  await expect(fs.access(path.join(config.outputDirectory, "codex-calls"))).rejects.toThrow();
});
