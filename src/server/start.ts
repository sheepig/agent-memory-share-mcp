import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildServer } from "./app.js";
import { acquireInstanceLock, DaemonAlreadyRunningError, readInstanceLock } from "./instance-lock.js";
import { getDataDirectory, isLoopbackHost } from "./paths.js";
import {
  logPath,
  processIsRunning,
  readRuntime,
  removeRuntime,
  type DaemonRuntime,
  writeRuntime,
} from "./runtime-state.js";

export interface StartServerOptions {
  dataDirectory?: string;
  host: string;
  homeDirectory?: string;
  port: number;
  scanIntervalMs?: number;
  writeLogs?: boolean;
}

export interface StartServerResult extends DaemonRuntime {
  alreadyRunning: boolean;
}

export async function startServer(options: StartServerOptions): Promise<StartServerResult> {
  if (!isLoopbackHost(options.host)) {
    throw new Error(`Refusing to listen on non-loopback host: ${options.host}`);
  }

  const dataDirectory = getDataDirectory(options.dataDirectory);
  let instanceLock;
  try {
    instanceLock = acquireInstanceLock(dataDirectory);
  } catch (error) {
    if (error instanceof DaemonAlreadyRunningError) {
      const existing = readRuntime(dataDirectory);
      const lock = readInstanceLock(dataDirectory);
      if (existing?.pid === error.pid && existing.instanceToken === lock?.token && processIsRunning(existing.pid)) {
        return { ...existing, alreadyRunning: true };
      }
    }
    throw error;
  }
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const daemonLogPath = logPath(dataDirectory);
  let app;
  try {
    app = await buildServer({
      dataDirectory,
      homeDirectory: options.homeDirectory,
      instanceToken: instanceLock.token,
      logFile: options.writeLogs ? daemonLogPath : undefined,
      publicDirectory: path.resolve(moduleDirectory, "../public"),
      scanIntervalMs: options.scanIntervalMs,
    });
  } catch (error) {
    instanceLock.release();
    throw error;
  }
  app.addHook("onClose", async () => {
    try {
      removeRuntime(dataDirectory, process.pid);
    } finally {
      instanceLock.release();
    }
  });

  const shutdown = async () => {
    await app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  app.addHook("onClose", async () => {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  });

  try {
    await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const runtime: DaemonRuntime = {
    host: options.host,
    instanceToken: instanceLock.token,
    logPath: daemonLogPath,
    mcpUrl: `http://${options.host === "::1" ? "[::1]" : options.host}:${options.port}/mcp`,
    pid: process.pid,
    port: options.port,
    startedAt: new Date().toISOString(),
  };
  try {
    writeRuntime(dataDirectory, runtime);
  } catch (error) {
    await app.close();
    throw error;
  }
  return { ...runtime, alreadyRunning: false };
}
