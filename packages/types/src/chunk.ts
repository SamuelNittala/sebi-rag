export interface Chunk {
  id: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
  documentId: string;
  documentFilename: string;
  pageNumbers: number[];
  fundName: string;
  amcName: string;
  schemeType: string;
  schemeCategory: string;
  docType: string;
  documentDate: string;
  hasTable: boolean;
  sectionHeader: string | null;
  /** SEBI scheme ID for citation linking (e.g., "16669") */
  sebiSchemeId: string;
  /** SEBI detail page URL for verification */
  sebiUrl: string;
}

export interface ChunkPayload {
  text: string;
  chunk_index: number;
  total_chunks: number;
  document_id: string;
  document_filename: string;
  page_numbers: number[];
  fund_name: string;
  amc_name: string;
  scheme_type: string;
  scheme_category: string;
  doc_type: string;
  document_date: string;
  has_table: boolean;
  section_header: string | null;
  /** SEBI scheme ID for citation linking (e.g., "16669") */
  sebi_scheme_id: string;
  /** SEBI detail page URL for verification */
  sebi_url: string;
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
