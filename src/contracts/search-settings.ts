import { z } from "zod";

export const searchSettingsSchema = z.object({
  rerankerEnabled: z.boolean(),
}).strict();

export type SearchSettings = z.infer<typeof searchSettingsSchema>;
