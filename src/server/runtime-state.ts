import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

export const daemonRuntimeSchema = z.object({
  host: z.string(),
  instanceToken: z.string().uuid(),
  logPath: z.string(),
  mcpUrl: z.string().url(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  startedAt: z.string().datetime(),
});

export type DaemonRuntime = z.infer<typeof daemonRuntimeSchema>;

export function runtimePath(dataDirectory: string): string {
  return path.join(dataDirectory, "runtime.json");
}

export function logPath(dataDirectory: string): string {
  return path.join(dataDirectory, "daemon.log");
}

export function readRuntime(dataDirectory: string): DaemonRuntime | undefined {
  try {
    return daemonRuntimeSchema.parse(JSON.parse(fs.readFileSync(runtimePath(dataDirectory), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function writeRuntime(dataDirectory: string, runtime: DaemonRuntime): void {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const file = runtimePath(dataDirectory);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(daemonRuntimeSchema.parse(runtime), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function removeRuntime(dataDirectory: string, pid: number): void {
  const runtime = readRuntime(dataDirectory);
  if (runtime?.pid === pid) {
    fs.unlinkSync(runtimePath(dataDirectory));
  }
}

export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
