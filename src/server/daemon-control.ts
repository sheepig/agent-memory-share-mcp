import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import type { DaemonConfig } from "./config.js";
import { readInstanceLock } from "./instance-lock.js";
import { getDataDirectory } from "./paths.js";
import {
  logPath,
  processIsRunning,
  readRuntime,
  removeRuntime,
  type DaemonRuntime,
} from "./runtime-state.js";

export interface DaemonStatus {
  mcpUrl?: string;
  pid?: number;
  reachable: boolean;
  running: boolean;
  startedAt?: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function identityIsReachable(runtime: DaemonRuntime): Promise<boolean> {
  try {
    const response = await fetch(`http://${runtime.host === "::1" ? "[::1]" : runtime.host}:${runtime.port}/api/daemon/identity`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const identity = await response.json() as { instanceToken?: unknown; pid?: unknown };
    return identity.instanceToken === runtime.instanceToken && identity.pid === runtime.pid;
  } catch {
    return false;
  }
}

function runtimeIsOwned(dataDirectory: string, runtime: DaemonRuntime): boolean {
  const lock = readInstanceLock(dataDirectory);
  return lock?.pid === runtime.pid && lock.token === runtime.instanceToken;
}

export async function getDaemonStatus(dataDirectoryOverride?: string): Promise<DaemonStatus> {
  const dataDirectory = getDataDirectory(dataDirectoryOverride);
  const runtime = readRuntime(dataDirectory);
  if (!runtime) {
    return { reachable: false, running: false };
  }
  if (!runtimeIsOwned(dataDirectory, runtime) || !processIsRunning(runtime.pid)) {
    removeRuntime(dataDirectory, runtime.pid);
    return { reachable: false, running: false };
  }
  const reachable = await identityIsReachable(runtime);
  return {
    mcpUrl: runtime.mcpUrl,
    pid: runtime.pid,
    reachable,
    running: true,
    startedAt: runtime.startedAt,
  };
}

export async function startDaemon(
  config: DaemonConfig,
  dataDirectoryOverride?: string,
  options: { cliPath?: string; sourceHome?: string; timeoutMs?: number } = {},
): Promise<DaemonStatus & { alreadyRunning: boolean }> {
  const dataDirectory = getDataDirectory(dataDirectoryOverride);
  const current = await getDaemonStatus(dataDirectory);
  if (current.running) {
    return { ...current, alreadyRunning: true };
  }
  fs.mkdirSync(dataDirectory, { recursive: true });
  const cliPath = options.cliPath ?? fileURLToPath(new URL("../cli/index.js", import.meta.url));
  const output = fs.openSync(logPath(dataDirectory), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [
      cliPath,
      "serve",
      "--host", config.host,
      "--port", String(config.port),
      "--scan-interval", String(config.scanIntervalSeconds),
      "--data-dir", dataDirectory,
      "--daemon-child",
      ...(options.sourceHome ? ["--source-home", options.sourceHome] : []),
    ], {
      detached: true,
      stdio: ["ignore", output, output],
    });
  } finally {
    fs.closeSync(output);
  }
  child.unref();

  const timeoutAt = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < timeoutAt) {
    const status = await getDaemonStatus(dataDirectory);
    if (status.running && status.reachable) {
      return { ...status, alreadyRunning: false };
    }
    await delay(100);
  }
  throw new Error(`Daemon did not become ready. Check ${logPath(dataDirectory)}.`);
}

export async function stopDaemon(dataDirectoryOverride?: string, timeoutMs = 10_000): Promise<DaemonStatus> {
  const dataDirectory = getDataDirectory(dataDirectoryOverride);
  const runtime = readRuntime(dataDirectory);
  if (!runtime || !runtimeIsOwned(dataDirectory, runtime) || !processIsRunning(runtime.pid)) {
    if (runtime) {
      removeRuntime(dataDirectory, runtime.pid);
    }
    return { reachable: false, running: false };
  }
  if (!await identityIsReachable(runtime)) {
    throw new Error(`Refusing to signal PID ${runtime.pid} because daemon identity could not be verified.`);
  }
  process.kill(runtime.pid, "SIGTERM");
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (!processIsRunning(runtime.pid)) {
      removeRuntime(dataDirectory, runtime.pid);
      return { reachable: false, running: false };
    }
    await delay(100);
  }
  throw new Error(`Daemon PID ${runtime.pid} did not stop within ${timeoutMs}ms.`);
}

export function readDaemonLogs(dataDirectoryOverride?: string, lines = 100): { logPath: string; lines: string[] } {
  const file = logPath(getDataDirectory(dataDirectoryOverride));
  try {
    const values = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    return { logPath: file, lines: values.slice(-lines) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { logPath: file, lines: [] };
    }
    throw error;
  }
}
