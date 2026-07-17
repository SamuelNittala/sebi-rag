import type { KnowledgeDomain, SourceCollection } from "./knowledge-scope.ts";
import type { CandidateChunkMetadata } from "./chunk-review.ts";

export type ContentCategory =
  | "education"
  | "procedural"
  | "regulatory"
  | "product"
  | "faq"
  | "form_instructions";

export interface HtmlChunkPayload {
  text: string;
  chunk_index: number;
  total_chunks: number;
  document_id: string;
  document_title: string;
  source_url: string;
  content_category: ContentCategory;
  section_heading: string | null;
  has_table: boolean;
  knowledge_domain?: KnowledgeDomain;
  source_collection?: SourceCollection;
  amc_slug?: string | null;
  ingestion_run_id?: string | null;
  publication_status?: "staged" | "published" | "retired";
  retrieval_metadata?: CandidateChunkMetadata | null;
}
