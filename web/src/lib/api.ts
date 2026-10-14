import { z } from "zod";

const healthSchema = z.object({
  database: z.literal("ok"),
  service: z.literal("agent-memory-share-mcp"),
  status: z.literal("ok"),
  version: z.string(),
});

export type Health = z.infer<typeof healthSchema>;

export async function getHealth(): Promise<Health> {
  const response = await fetch("/api/health");
  if (!response.ok) {
    throw new Error(`Health request failed with ${response.status}`);
  }
  return healthSchema.parse(await response.json());
}
