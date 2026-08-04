CREATE TABLE "document_publication_chunk_search_documents" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"search_tokens" text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_publication_chunk_search_documents"
  ADD CONSTRAINT "document_publication_chunk_search_documents_chunk_id_fk"
  FOREIGN KEY ("chunk_id") REFERENCES "public"."document_publication_chunks"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_document_publication_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO document_publication_chunk_search_documents (chunk_id, search_tokens)
  VALUES (
    NEW.id,
    bm25_tokens(
      coalesce(NEW.retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'topic', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'topic', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'documentTitle', '') || ' ' ||
      coalesce(NEW.retrieval_metadata ->> 'publisher', '') || ' ' ||
      coalesce(NEW.section_header, '') || ' ' ||
      coalesce(NEW.section_header, '') || ' ' ||
      NEW.text
    )
  )
  ON CONFLICT (chunk_id) DO UPDATE
  SET search_tokens = EXCLUDED.search_tokens;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_publication_chunk_search_sync
AFTER INSERT OR UPDATE OF text, section_header, retrieval_metadata
ON document_publication_chunks
FOR EACH ROW EXECUTE FUNCTION sync_document_publication_chunk_search_document();
--> statement-breakpoint
INSERT INTO document_publication_chunk_search_documents (chunk_id, search_tokens)
SELECT
  id,
  bm25_tokens(
    coalesce(retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'originalQuestion', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'topic', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'topic', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'documentTitle', '') || ' ' ||
    coalesce(retrieval_metadata ->> 'publisher', '') || ' ' ||
    coalesce(section_header, '') || ' ' ||
    coalesce(section_header, '') || ' ' ||
    text
  )
FROM document_publication_chunks
ON CONFLICT (chunk_id) DO UPDATE SET search_tokens = EXCLUDED.search_tokens;
--> statement-breakpoint
CREATE INDEX "document_publication_chunk_search_tokens_idx"
  ON "document_publication_chunk_search_documents" USING gin ("search_tokens");
--> statement-breakpoint
CREATE INDEX "document_publication_chunks_embedding_hnsw_idx"
  ON "document_publication_chunks" USING hnsw ("embedding" vector_cosine_ops);
