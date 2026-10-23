import type { SourceType } from "../domain/source.js";

export interface FragmentRow {
  agent: string;
  body: string;
  chunk_index: number | null;
  content_fingerprint: string;
  content_tokens: number | null;
  embedding?: Buffer;
  end_location: string | null;
  ended_at: string | null;
  external_source_id: string;
  fragment_id: string;
  fragment_title: string | null;
  location: string;
  original_session_id: string | null;
  project_path: string | null;
  role: "assistant" | "user" | null;
  source_id: string;
  source_path: string;
  source_title: string | null;
  source_type: SourceType;
  source_updated_at: string;
  started_at: string | null;
  turn_count: number | null;
}
