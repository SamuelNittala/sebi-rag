export interface Chunk {
  id: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
  documentId: string;
  documentFilename: string;
  pageNumbers: number[];
  fundName: string | null;
  amcName: string | null;
  schemeType: string | null;
  schemeCategory: string | null;
  docType: string;
  documentDate: string | null;
  hasTable: boolean;
  sectionHeader: string | null;
  /** SEBI scheme ID for citation linking (e.g., "16669") */
  sebiSchemeId: string | null;
  /** SEBI detail page URL for verification */
  sebiUrl: string | null;
  documentKind: "scheme" | "FAQ" | "generic_pdf";
  documentTitle: string | null;
  publisher: string | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  authority: string | null;
  topic: string | null;
  questionNumber: string | null;
  normalizedQuestionKey: string | null;
  originalQuestion: string | null;
  continuationIndex: number | null;
}

import type { CandidateChunkMetadata } from "./chunk-review.ts";

export interface ChunkPayload {
  text: string;
  chunk_index: number;
  total_chunks: number;
  document_id: string;
  document_filename: string;
  page_numbers: number[];
  fund_name: string | null;
  amc_name: string | null;
  scheme_type: string | null;
  scheme_category: string | null;
  doc_type: string;
  document_date: string | null;
  has_table: boolean;
  section_header: string | null;
  /** SEBI scheme ID for citation linking (e.g., "16669") */
  sebi_scheme_id: string | null;
  /** SEBI detail page URL for verification */
  sebi_url: string | null;
  document_kind?: "scheme" | "FAQ" | "generic_pdf";
  document_title?: string | null;
  publisher?: string | null;
  source_url?: string | null;
  source_date?: string | null;
  authority?: string | null;
  topic?: string | null;
  question_number?: string | null;
  normalized_question_key?: string | null;
  original_question?: string | null;
  continuation_index?: number | null;
  knowledge_domain?: "mutual_fund" | "sif";
  source_collection?: "default_corpus" | "mirae_sif" | "sebi_regulatory" | "general_mf_faq";
  amc_slug?: string | null;
  ingestion_run_id?: string | null;
  publication_status?: "staged" | "published" | "retired";
  retrieval_metadata?: CandidateChunkMetadata | null;
  visibility_scope?: "GLOBAL" | "TENANT" | "UNCLASSIFIED";
  tenant_id?: string | null;
  ownership_manifest_id?: string | null;
  ownership_manifest_version?: number | null;
}

export interface ChunkConfig {
  targetTokens: number;
  maxTokens: number;
  tableMaxTokens: number;
  overlapTokens: number;
  minTokens: number;
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  targetTokens: 450,
  maxTokens: 512,
  tableMaxTokens: 1024,
  overlapTokens: 50,
  minTokens: 100,
};
