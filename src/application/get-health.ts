import type { HealthResponse } from "../contracts/health.js";
import type { AppDatabase } from "../storage/database.js";

export function getHealth(database: AppDatabase): HealthResponse {
  database.prepare("SELECT 1").get();
  return {
    database: "ok",
    service: "agent-memory-share-mcp",
    status: "ok",
    version: "0.0.0",
  };
}
