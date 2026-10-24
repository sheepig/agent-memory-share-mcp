import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { z } from "zod";

import { redactSensitiveText } from "../security/sensitive-content.js";
import { writeJsonFile } from "./files.js";
import type { EvaluationConfig } from "./types.js";

const execute = promisify(execFile);
const PROTOCOL_VERSION = 1;
const disabled = ["apps", "plugins", "memories", "multi_agent", "multi_agent_v2", "shell_tool", "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image", "workspace_dependencies", "code_mode_host", "unified_exec", "skill_search", "sleep_tool", "goals", "hooks", "remote_plugin", "skill_mcp_dependency_install", "shell_snapshot", "tool_suggest", "mentions_v2"];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function assertSafeModelOutput(value: unknown): void {
  if (typeof value === "string" && redactSensitiveText(value).findings.length) throw new Error("Model input or output contains suspected sensitive content; nothing was saved.");
  if (Array.isArray(value)) value.forEach(assertSafeModelOutput);
  else if (value && typeof value === "object") Object.values(value).forEach(assertSafeModelOutput);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface Turn extends Pending {
  text?: string;
  usage?: unknown;
  tools: boolean;
}

interface Notification {
  threadId?: string;
  item?: { type: string; text?: string };
  turn?: { status: string; error?: unknown };
  tokenUsage?: unknown;
}

export class CodexEvaluationModel {
  private child?: ChildProcessWithoutNullStreams;
  private root?: string;
  private cwd?: string;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private turns = new Map<string, Turn>();
  private initialization?: Promise<void>;
  private inFlight = new Map<string, Promise<{ model: string; data: unknown }>>();
  private environmentAudit?: { inputSha256: string; externalInstructions: number };
  private readonly options;

  constructor(private readonly config: EvaluationConfig) {
    this.options = config.codex ?? { command: "codex", reasoningEffort: "high", timeoutMs: 180_000 };
  }

  private fail(error: Error): void {
    for (const entry of [...this.pending.values(), ...this.turns.values()]) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.turns.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timed out: ${method}`)); }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private async initialize(model: string): Promise<void> {
    this.root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-eval-codex-"));
    await fs.chmod(this.root, 0o700);
    const home = path.join(this.root, "home");
    const codexHome = path.join(this.root, "codex");
    this.cwd = path.join(this.root, "work");
    for (const directory of [home, codexHome, this.cwd]) await fs.mkdir(directory, { mode: 0o700 });
    const originalHome = this.options.homeDirectory ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const credentials = path.join(originalHome, "auth.json");
    try {
      await fs.access(credentials);
      if (process.platform === "win32") await fs.link(credentials, path.join(codexHome, "auth.json"));
      else await fs.symlink(credentials, path.join(codexHome, "auth.json"));
    } catch {
      throw new Error("Cannot link existing Codex file login into the isolated runtime. Log in with Codex CLI, set codex.homeDirectory if needed, and use a temporary directory supporting file links.");
    }
    try { await fs.copyFile(path.join(originalHome, "models_cache.json"), path.join(codexHome, "models_cache.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const skills = ["imagegen", "openai-docs", "skill-creator", "skill-installer"].flatMap((name) => [
      "[[skills.config]]", `path = ${JSON.stringify(path.join(codexHome, "skills", ".system", name, "SKILL.md"))}`, "enabled = false",
    ]);
    await fs.writeFile(path.join(codexHome, "config.toml"), [`model = ${JSON.stringify(model)}`, 'model_provider = "openai"', "project_doc_max_bytes = 1", 'web_search = "disabled"', 'cli_auth_credentials_store = "file"', ...skills].join("\n"), { mode: 0o600 });
    const environment = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      TMPDIR: this.root,
      TEMP: this.root,
      TMP: this.root,
      LANG: "en_US.UTF-8",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const flags = disabled.flatMap((feature) => ["--disable", feature]);
    const inspected = await execute(this.options.command, ["debug", "prompt-input", ...flags], { cwd: this.cwd, env: environment, timeout: this.options.timeoutMs, maxBuffer: 2 * 1024 * 1024 });
    const context: unknown = JSON.parse(inspected.stdout);
    const serialized = JSON.stringify(context);
    if (/<skills_instructions>|AGENTS\.md|<multi_agent|<collaboration_mode>|<memory/iu.test(serialized)) {
      throw new Error("Codex isolation inspection found unrelated instructions. Use a compatible CLI; no evidence was sent.");
    }
    this.environmentAudit = { inputSha256: hash(serialized), externalInstructions: 0 };
    this.child = spawn(this.options.command, ["app-server", "--stdio", ...flags], { cwd: this.cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(new Error("Cannot start Codex app-server. Check codex.command and CLI compatibility.")));
    this.child.on("exit", () => this.fail(new Error("Codex app-server exited before the request completed.")));
    this.child.stdin.on("error", () => this.fail(new Error("Codex app-server input closed.")));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: { id?: number; method?: string; result?: unknown; error?: unknown; params?: Notification };
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        for (const turn of this.turns.values()) turn.tools = true;
        this.child!.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "Evaluation does not permit tools or approvals" } })}\n`);
        return;
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error("Codex rejected the RPC request. Check model, effort and CLI compatibility."));
        else entry.resolve(message.result);
        return;
      }
      const event = message.params;
      const turn = event?.threadId ? this.turns.get(event.threadId) : undefined;
      if (!event || !turn) return;
      if (["item/started", "item/completed"].includes(message.method ?? "") && event.item) {
        if (event.item.type === "agentMessage") turn.text = event.item.text;
        else if (!["userMessage", "reasoning"].includes(event.item.type)) turn.tools = true;
      }
      if (message.method === "thread/tokenUsage/updated") turn.usage = event.tokenUsage;
      if (message.method === "turn/completed" && event.turn) {
        clearTimeout(turn.timer);
        this.turns.delete(event.threadId!);
        if (event.turn.status !== "completed" || turn.tools) turn.reject(new Error("Codex evaluation failed or attempted a tool."));
        else turn.resolve({ text: turn.text, usage: turn.usage });
      }
    });
    await this.request("initialize", { clientInfo: { name: "agent_memory_evaluation", version: "1.0" }, capabilities: { experimentalApi: true } });
    this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  }

  async json(model: string, instructions: string, input: string, schema: z.ZodType): Promise<{ model: string; data: unknown }> {
    const outputSchema = z.toJSONSchema(schema);
    const binding = hash(JSON.stringify({ protocol: PROTOCOL_VERSION, model, effort: this.options.reasoningEffort, instructions, input, schema: outputSchema }));
    const existing = this.inFlight.get(binding);
    if (existing) return existing;
    const pending = this.evaluate(model, instructions, input, schema, outputSchema, binding);
    this.inFlight.set(binding, pending);
    try { return await pending; }
    finally { this.inFlight.delete(binding); }
  }

  private async evaluate(model: string, instructions: string, input: string, schema: z.ZodType, outputSchema: unknown, binding: string): Promise<{ model: string; data: unknown }> {
    const receipt = path.join(this.config.outputDirectory, "codex-calls", `${binding}.json`);
    try {
      const saved = JSON.parse(await fs.readFile(receipt, "utf8")) as { binding: string; model: string; data: unknown };
      if (saved.binding !== binding || saved.model !== model) throw new Error("Codex response checkpoint mismatch.");
      schema.parse(saved.data);
      assertSafeModelOutput(saved.data);
      return saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await (this.initialization ??= this.initialize(model));
    const started = await this.request("thread/start", {
      model, modelProvider: "openai", allowProviderModelFallback: false, ephemeral: true,
      cwd: this.cwd, sandbox: "read-only", approvalPolicy: "never", environments: [], dynamicTools: [],
      baseInstructions: instructions, config: { project_doc_max_bytes: 1, model_reasoning_effort: this.options.reasoningEffort },
    }) as { model: string; reasoningEffort: string; instructionSources?: unknown[]; thread: { id: string; ephemeral: boolean; turns?: unknown[] } };
    if (started.model !== model || started.reasoningEffort !== this.options.reasoningEffort || !started.thread.ephemeral
      || !Array.isArray(started.instructionSources) || started.instructionSources.length !== 0
      || !Array.isArray(started.thread.turns) || started.thread.turns.length !== 0) throw new Error("Codex model, effort or independent context verification failed.");
    const threadId = started.thread.id;
    try {
      const finished = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.turns.delete(threadId); reject(new Error("Codex model inference timed out.")); }, this.options.timeoutMs);
        this.turns.set(threadId, { resolve, reject, timer, tools: false });
      });
      void finished.catch(() => {});
      await this.request("turn/start", { threadId, model, effort: this.options.reasoningEffort, environments: [], input: [{ type: "text", text: input }], outputSchema });
      const response = await finished as { text?: string; usage?: unknown };
      const data: unknown = schema.parse(JSON.parse(response.text ?? ""));
      assertSafeModelOutput(data);
      await writeJsonFile(receipt, { binding, model: started.model, effort: started.reasoningEffort, protocolVersion: PROTOCOL_VERSION, threadId, initialTurns: 0, instructionSources: [], toolsUsed: false, environment: this.environmentAudit, instructionsSha256: hash(instructions), inputSha256: hash(input), usage: response.usage, data });
      return { data, model: started.model };
    } finally {
      await this.request("thread/unsubscribe", { threadId });
    }
  }

  async close(): Promise<void> {
    this.fail(new Error("Codex evaluation client closed."));
    if (this.child) {
      this.child.stdin.end();
      this.child.kill();
      await new Promise<void>((resolve) => {
        if (this.child!.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 2_000);
        this.child!.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.root) await fs.rm(this.root, { recursive: true, force: true });
  }
}
