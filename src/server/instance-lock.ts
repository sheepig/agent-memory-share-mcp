import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LockRecord {
  pid: number;
  token: string;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(`Another daemon is already running with PID ${pid}.`);
    this.name = "DaemonAlreadyRunningError";
  }
}

export interface InstanceLock {
  path: string;
  token: string;
  release(): void;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(lockPath: string): LockRecord {
  const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
  if (!Number.isInteger(value.pid) || typeof value.token !== "string") {
    throw new Error(`Invalid daemon lock file: ${lockPath}`);
  }
  return value as LockRecord;
}

export function readInstanceLock(dataDirectory: string): LockRecord | undefined {
  try {
    return readLock(path.join(dataDirectory, "daemon.lock"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function acquireInstanceLock(dataDirectory: string): InstanceLock {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const lockPath = path.join(dataDirectory, "daemon.lock");
  const record: LockRecord = { pid: process.pid, token: randomUUID() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record));
      } finally {
        fs.closeSync(descriptor);
      }
      return {
        path: lockPath,
        token: record.token,
        release() {
          try {
            const current = readLock(lockPath);
            if (current.pid === record.pid && current.token === record.token) {
              fs.unlinkSync(lockPath);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = readLock(lockPath);
      if (processExists(existing.pid)) {
        throw new DaemonAlreadyRunningError(existing.pid);
      }
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error("Unable to acquire the daemon instance lock.");
}
