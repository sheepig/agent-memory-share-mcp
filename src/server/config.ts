import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { searchSettingsSchema, type SearchSettings } from "../contracts/search-settings.js";
import { defaultSourcePaths } from "../sources/source-paths.js";
import { isLoopbackHost } from "./paths.js";

const sourcePathSchema = z.string().min(1).max(4_096).refine(
  (value) => !value.includes("\0") && (path.isAbsolute(value) || value === "~" || value.startsWith("~/")),
  "source paths must be absolute or start with ~/",
);
const sourceRootsSchema = z.array(sourcePathSchema).max(64);
const sourcePathsSchema = z.object({
  codex: z.object({
    sessionRoots: sourceRootsSchema.default(defaultSourcePaths.codex.sessionRoots),
    memoryRoots: sourceRootsSchema.default(defaultSourcePaths.codex.memoryRoots),
  }).strict().default(defaultSourcePaths.codex),
  "claude-code": z.object({
    projectRoots: sourceRootsSchema.default(defaultSourcePaths["claude-code"].projectRoots),
    memoryRoots: sourceRootsSchema.optional(),
  }).strict().default(defaultSourcePaths["claude-code"]),
  cursor: z.object({
    sessionRoots: sourceRootsSchema.default(defaultSourcePaths.cursor.sessionRoots),
  }).strict().default(defaultSourcePaths.cursor),
  opencode: z.object({
    databasePath: sourcePathSchema.default(defaultSourcePaths.opencode.databasePath),
  }).strict().default(defaultSourcePaths.opencode),
}).strict().default(defaultSourcePaths);

export const defaultSessionFragmentLimits = { codex: 5_000, "claude-code": 5_000, cursor: 5_000, opencode: 5_000 };
const sessionFragmentLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sessionFragmentLimitsSchema = z.object({
  codex: sessionFragmentLimitSchema.default(defaultSessionFragmentLimits.codex),
  "claude-code": sessionFragmentLimitSchema.default(defaultSessionFragmentLimits["claude-code"]),
  cursor: sessionFragmentLimitSchema.default(defaultSessionFragmentLimits.cursor),
  opencode: sessionFragmentLimitSchema.default(defaultSessionFragmentLimits.opencode),
}).strict().default(defaultSessionFragmentLimits);

export const daemonConfigSchema = z.object({
  host: z.string().refine(isLoopbackHost, "host must be a loopback address"),
  port: z.number().int().min(1).max(65_535),
  rerankerEnabled: searchSettingsSchema.shape.rerankerEnabled.default(false),
  scanIntervalSeconds: z.number().int().min(0),
  sources: sourcePathsSchema,
  sessionFragmentLimits: sessionFragmentLimitsSchema,
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 43_110,
  rerankerEnabled: false,
  scanIntervalSeconds: 60,
  sources: defaultSourcePaths,
  sessionFragmentLimits: defaultSessionFragmentLimits,
};

function environmentDaemonConfig(): DaemonConfig {
  return daemonConfigSchema.parse({
    host: process.env.AGENT_MEMORY_HOST ?? defaultDaemonConfig.host,
    port: process.env.AGENT_MEMORY_PORT ? Number(process.env.AGENT_MEMORY_PORT) : defaultDaemonConfig.port,
    scanIntervalSeconds: process.env.AGENT_MEMORY_SCAN_INTERVAL
      ? Number(process.env.AGENT_MEMORY_SCAN_INTERVAL)
      : defaultDaemonConfig.scanIntervalSeconds,
  });
}

export function configPath(dataDirectory: string): string {
  return path.join(dataDirectory, "config.json");
}

export function readDaemonConfig(dataDirectory: string): DaemonConfig {
  const file = configPath(dataDirectory);
  try {
    return daemonConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return environmentDaemonConfig();
    }
    throw error;
  }
}

export function writeDaemonConfig(dataDirectory: string, config: z.input<typeof daemonConfigSchema>): DaemonConfig {
  const parsed = daemonConfigSchema.parse(config);
  fs.mkdirSync(dataDirectory, { recursive: true });
  const file = configPath(dataDirectory);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return parsed;
}

export function readSearchSettings(dataDirectory: string): SearchSettings {
  return { rerankerEnabled: readDaemonConfig(dataDirectory).rerankerEnabled };
}

export function updateSearchSettings(dataDirectory: string, settings: SearchSettings): SearchSettings {
  const parsed = searchSettingsSchema.parse(settings);
  const saved = writeDaemonConfig(dataDirectory, { ...readDaemonConfig(dataDirectory), ...parsed });
  return { rerankerEnabled: saved.rerankerEnabled };
}

export function initializeDaemonConfig(dataDirectory: string): DaemonConfig {
  const file = configPath(dataDirectory);
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const config = daemonConfigSchema.parse(raw);
    return raw.sources === undefined || raw.sessionFragmentLimits === undefined ? writeDaemonConfig(dataDirectory, config) : config;
  }
  return writeDaemonConfig(dataDirectory, environmentDaemonConfig());
}
