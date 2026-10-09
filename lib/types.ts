import type { SuggestedLink } from "@/lib/links";

export type Project = {
  id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
};

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export type SourceType = "pdf" | "image" | "html" | "link" | "email";

export type DocumentRow = {
  id: string;
  project_id: string;
  user_id: string;
  source_type: SourceType;
  title: string | null;
  source_url: string | null;
  captured_at: string | null;
  storage_path: string | null;
  media_type: string | null;
  extracted_path: string | null;
  anthropic_file_id: string | null;
  page_count: number | null;
  token_count: number | null;
  status: DocumentStatus;
  error: string | null;
  content_hash: string | null;
  suggested_links: SuggestedLink[] | null;
  created_at: string;
};

/** A citation resolved back to one of our documents, ready to display. */
export type Citation = {
  documentId: string;
  title: string;
  sourceType: SourceType;
  citedText: string;
  startPage: number | null;
  endPage: number | null;
  sourceUrl: string | null;
  capturedAt: string | null;
};

/** One span of an answer, with the citations that back it. */
export type AnswerBlock = {
  text: string;
  citations: Citation[];
};

export type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; blocks: AnswerBlock[] };

/** Newline-delimited JSON events streamed from /api/chat. */
export type ChatEvent =
  | { type: "conversation"; conversationId: string; documentIds: string[] }
  | { type: "text"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: string };
