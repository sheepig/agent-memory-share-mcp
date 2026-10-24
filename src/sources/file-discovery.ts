import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import type { SourceDiagnostic } from "./source-adapter.js";

const deniedNames = new Set(["auth.json", "credentials.json", "secrets.json", "tokens.json", "settings.json", "config.json", "mcp.json"]);
const instructionNames = new Set(["agent.md", "agents.md", "claude.md", "command.md", "commands.md"]);

export interface FileDiscoveryStep {
  cursor?: string;
  file?: string;
  complete?: boolean;
}

/** Path order is independent of mtime, so changed files cannot move across a resume cursor. */
export async function* discoverFileSteps(
  roots: readonly string[],
  options: {
    after?: string;
    accept?: (file: string) => boolean;
    descend?: (directory: string) => boolean;
    extensions: ReadonlySet<string>;
    maxDirectories?: number;
    onDiagnostic: (diagnostic: SourceDiagnostic) => void;
  },
): AsyncIterable<FileDiscoveryStep> {
  let directories = 0;
  let incomplete = false;
  const limit = options.maxDirectories ?? 3_000;
  const after = options.after;
  const seenRoots: string[] = [];

  async function* visit(location: string): AsyncIterable<FileDiscoveryStep> {
    await setImmediate();
    let information: import("node:fs").Stats;
    try {
      information = await fs.lstat(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        incomplete = true;
        options.onDiagnostic({ code: "source_directory_unreadable", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: location });
      }
      if (!after || location > after) yield { cursor: location };
      return;
    }
    if (information.isSymbolicLink()) {
      if (after && location <= after) return;
      options.onDiagnostic({ code: "symbolic_link_skipped", level: "warning", message: "Symbolic links are not scanned.", sourcePath: location });
      yield { cursor: location };
      return;
    }
    if (information.isDirectory()) {
      const directoryCursor = `${location}${path.sep}`;
      if (after && directoryCursor < after && !after.startsWith(directoryCursor)) return;
      if (!(options.descend?.(location) ?? true)) {
        if (!after || directoryCursor > after) yield { cursor: directoryCursor };
        return;
      }
      const previouslyEntered = after !== undefined && directoryCursor <= after;
      if (!previouslyEntered && directories >= limit) {
        incomplete = true;
        options.onDiagnostic({ code: "scan_limit_reached", level: "warning", message: "The bounded scan reached its directory limit.", sourcePath: location });
        return;
      }
      if (!previouslyEntered) directories += 1;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(location, { withFileTypes: true });
      } catch (error) {
        incomplete = true;
        options.onDiagnostic({ code: "source_directory_unreadable", level: "warning", message: error instanceof Error ? error.message : String(error), sourcePath: location });
        return;
      }
      // A directory cursor advances even when every contained file is ineligible.
      if (!after || directoryCursor > after) yield { cursor: directoryCursor };
      entries.sort((left, right) => {
        const leftKey = left.name + (left.isDirectory() ? path.sep : "");
        const rightKey = right.name + (right.isDirectory() ? path.sep : "");
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      for (const entry of entries) {
        if (incomplete) break;
        if (entry.name.startsWith(".") || ["node_modules", "__pycache__", "skills"].includes(entry.name)) continue;
        const child = path.join(location, entry.name);
        if (after) {
          const key = child + (entry.isDirectory() ? path.sep : "");
          if (entry.isDirectory() ? key < after && !after.startsWith(key) : key <= after) continue;
        }
        yield* visit(child);
      }
      return;
    }
    if (after && location <= after) return;
    const name = path.basename(location).toLowerCase();
    const accepted = information.isFile() && !deniedNames.has(name) && !instructionNames.has(name)
      && options.extensions.has(path.extname(location).toLowerCase()) && (options.accept?.(location) ?? true);
    yield { cursor: location, ...(accepted ? { file: location } : {}) };
  }

  for (const root of [...new Set(roots)].sort()) {
    if (seenRoots.some((seen) => root.startsWith(`${seen}${path.sep}`))) continue;
    seenRoots.push(root);
    yield* visit(root);
    if (incomplete) break;
  }
  if (incomplete) yield { complete: false };
}
