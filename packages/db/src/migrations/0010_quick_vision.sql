CREATE OR REPLACE FUNCTION bm25_tokens(input_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(token), ARRAY[]::text[])
  FROM regexp_split_to_table(lower(COALESCE(input_text, '')), '[^a-z0-9]+') AS token
  WHERE char_length(token) > 1
    AND NOT token = ANY (ARRAY[
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
      'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where',
      'which', 'who', 'why', 'with'
    ]::text[]);
$$;--> statement-breakpoint
CREATE TABLE "chunk_search_documents" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"search_tokens" text[] NOT NULL
);--> statement-breakpoint
CREATE TABLE "html_chunk_search_documents" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"search_tokens" text[] NOT NULL
);--> statement-breakpoint
ALTER TABLE "chunk_search_documents" ADD CONSTRAINT "chunk_search_documents_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "html_chunk_search_documents" ADD CONSTRAINT "html_chunk_search_documents_chunk_id_html_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."html_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.knowledge_domain = 'sif'
    AND NEW.source_collection = 'mirae_sif'
    AND NEW.publication_status = 'published' THEN
    INSERT INTO chunk_search_documents (chunk_id, search_tokens)
    VALUES (
      NEW.id,
      bm25_tokens(
        coalesce(NEW.section_header, '') || ' ' ||
        coalesce(NEW.section_header, '') || ' ' ||
        coalesce(NEW.section_header, '') || ' ' || NEW.text
      )
    )
    ON CONFLICT (chunk_id) DO UPDATE
    SET search_tokens = EXCLUDED.search_tokens;
  ELSE
    DELETE FROM chunk_search_documents WHERE chunk_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER chunks_search_document_sync
AFTER INSERT OR UPDATE OF text, section_header, knowledge_domain, source_collection, publication_status ON chunks
FOR EACH ROW EXECUTE FUNCTION sync_chunk_search_document();--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_html_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.knowledge_domain = 'sif'
    AND NEW.source_collection = 'mirae_sif'
    AND NEW.publication_status = 'published' THEN
    INSERT INTO html_chunk_search_documents (chunk_id, search_tokens)
    VALUES (
      NEW.id,
      bm25_tokens(
        NEW.document_title || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' || NEW.text
      )
    )
    ON CONFLICT (chunk_id) DO UPDATE
    SET search_tokens = EXCLUDED.search_tokens;
  ELSE
    DELETE FROM html_chunk_search_documents WHERE chunk_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER html_chunks_search_document_sync
AFTER INSERT OR UPDATE OF text, document_title, section_heading, knowledge_domain, source_collection, publication_status ON html_chunks
FOR EACH ROW EXECUTE FUNCTION sync_html_chunk_search_document();--> statement-breakpoint
INSERT INTO chunk_search_documents (chunk_id, search_tokens)
SELECT
  id,
  bm25_tokens(
    coalesce(section_header, '') || ' ' ||
    coalesce(section_header, '') || ' ' ||
    coalesce(section_header, '') || ' ' || text
  )
FROM chunks
WHERE knowledge_domain = 'sif'
  AND source_collection = 'mirae_sif'
  AND publication_status = 'published'
ON CONFLICT (chunk_id) DO NOTHING;--> statement-breakpoint
INSERT INTO html_chunk_search_documents (chunk_id, search_tokens)
SELECT
  id,
  bm25_tokens(
    document_title || ' ' ||
    coalesce(section_heading, '') || ' ' ||
    coalesce(section_heading, '') || ' ' ||
    coalesce(section_heading, '') || ' ' || text
  )
FROM html_chunks
WHERE knowledge_domain = 'sif'
  AND source_collection = 'mirae_sif'
  AND publication_status = 'published'
ON CONFLICT (chunk_id) DO NOTHING;--> statement-breakpoint
CREATE INDEX "chunk_search_documents_tokens_idx" ON "chunk_search_documents" USING gin ("search_tokens");--> statement-breakpoint
CREATE INDEX "html_chunk_search_documents_tokens_idx" ON "html_chunk_search_documents" USING gin ("search_tokens");
