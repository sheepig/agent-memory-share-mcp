import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { searchSettingsSchema, type SearchSettings } from "../contracts/search-settings.js";
import { isLoopbackHost } from "./paths.js";

export const daemonConfigSchema = z.object({
  host: z.string().refine(isLoopbackHost, "host must be a loopback address"),
  port: z.number().int().min(1).max(65_535),
  rerankerEnabled: searchSettingsSchema.shape.rerankerEnabled.default(false),
  scanIntervalSeconds: z.number().int().min(0),
});

export type DaemonConfig = z.infer<typeof daemonConfigSchema>;

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 43_110,
  rerankerEnabled: false,
  scanIntervalSeconds: 60,
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
    return readDaemonConfig(dataDirectory);
  }
  return writeDaemonConfig(dataDirectory, environmentDaemonConfig());
}
