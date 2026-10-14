export type SourceType = "memory" | "session";

export interface SourceReference {
  agent: string;
  contentFingerprint: string;
  projectPath?: string;
  sourceId: string;
  sourcePath: string;
  sourceType: SourceType;
  updatedAt: Date;
}

export interface IndexDocument {
  body: string;
  location: string;
  role?: "assistant" | "user";
  source: SourceReference;
  title?: string;
}
