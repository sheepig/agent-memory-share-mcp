import path from "node:path";

export interface DesktopSourcePaths {
  codex?: { sessionRoots?: readonly string[]; memoryRoots?: readonly string[] };
  "claude-code"?: { projectRoots?: readonly string[]; memoryRoots?: readonly string[] };
  cursor?: { sessionRoots?: readonly string[] };
  opencode?: { databasePath?: string };
}

export const defaultSourcePaths = {
  codex: {
    sessionRoots: ["~/.codex/sessions", "~/.codex/archived_sessions"],
    memoryRoots: ["~/.codex/memories"],
  },
  "claude-code": { projectRoots: ["~/.claude/projects"] },
  cursor: { sessionRoots: ["~/.cursor/projects"] },
  opencode: { databasePath: "~/.local/share/opencode/opencode.db" },
};

export function resolveDesktopSourcePaths(homeDirectory: string, configured: DesktopSourcePaths = {}) {
  const resolve = (value: string): string => value === "~" ? homeDirectory
    : value.startsWith("~/") ? path.resolve(homeDirectory, value.slice(2)) : path.resolve(value);
  const roots = (values: readonly string[]): string[] => [...new Set(values.map(resolve))];
  return {
    codex: {
      sessionRoots: roots(configured.codex?.sessionRoots ?? defaultSourcePaths.codex.sessionRoots),
      memoryRoots: roots(configured.codex?.memoryRoots ?? defaultSourcePaths.codex.memoryRoots),
    },
    "claude-code": {
      projectRoots: roots(configured["claude-code"]?.projectRoots ?? defaultSourcePaths["claude-code"].projectRoots),
      memoryRoots: configured["claude-code"]?.memoryRoots === undefined ? undefined
        : roots(configured["claude-code"].memoryRoots),
    },
    cursor: { sessionRoots: roots(configured.cursor?.sessionRoots ?? defaultSourcePaths.cursor.sessionRoots) },
    opencode: { databasePath: resolve(configured.opencode?.databasePath ?? defaultSourcePaths.opencode.databasePath) },
  };
}
