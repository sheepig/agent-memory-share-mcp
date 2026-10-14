import { z } from "zod";

export const healthResponseSchema = z.object({
  database: z.literal("ok"),
  service: z.literal("agent-memory-share-mcp"),
  status: z.literal("ok"),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
