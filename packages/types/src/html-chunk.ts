export type ContentCategory = "education" | "procedural" | "regulatory";

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
}
