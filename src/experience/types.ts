export const EXPERIENCE_SCHEMA_VERSION = 1;
export const SCORE_VERSION = 1;

export interface HumanEvaluation {
  schema_version: number;
  quality: number | null;
  difficulty: number | null;
  score: number | null;
  score_version: number;
  evaluated_at: string | null;
}

export interface ExperienceMetadata {
  schema_version: number;
  seq: number;
  run_id: string;
  workflow: string;
  project_name: string;
  project_path: string;
  timestamp: string;
  sha: string;
  archive_path: string;
  session_path: string;
  model: string | null;
  reasoning: string | null;
  analysis_status: "pending" | "complete" | "failed";
  analysis_error?: string;
}

export interface ExperienceIndexEntry extends ExperienceMetadata {
  quality: number | null;
  difficulty: number | null;
  score: number | null;
  score_version: number;
  transcript_tokens: number;
  processed_tokens: number | null;
  duration_s: number | null;
  evaluation_status: "pending" | "evaluated";
}

export interface DistillState {
  schema_version: number;
  last_distilled_seq: number;
  pending_transcript_tokens: number;
  threshold_tokens: number;
  last_distilled_at: string | null;
  active_cutoff_seq: number | null;
  active_started_at: string | null;
}

export interface ExperienceSearchOptions {
  query?: string;
  workflow?: string;
  project_name?: string;
  project_path?: string;
  model?: string;
  reasoning?: string;
  min_quality?: number;
  max_quality?: number;
  min_difficulty?: number;
  max_difficulty?: number;
  min_score?: number;
  max_score?: number;
  timestamp_from?: string;
  timestamp_to?: string;
  min_transcript_tokens?: number;
  max_transcript_tokens?: number;
  min_processed_tokens?: number;
  max_processed_tokens?: number;
  min_duration_s?: number;
  max_duration_s?: number;
  evaluation_status?: "pending" | "evaluated";
  sort?: "relevance" | "score" | "quality" | "difficulty" | "timestamp" | "duration" | "transcript_tokens" | "processed_tokens";
  order?: "asc" | "desc";
  limit?: number;
}
