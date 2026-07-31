CREATE OR REPLACE FUNCTION bm25_searchable_chunk(
  knowledge_domain_value text,
  source_collection_value text,
  publication_status_value text,
  visibility_scope_value text,
  tenant_id_value text,
  ownership_manifest_id_value text,
  ownership_manifest_version_value integer
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT
    publication_status_value = 'published'
    AND (
      (knowledge_domain_value = 'sif' AND source_collection_value = 'mirae_sif')
      OR (
        knowledge_domain_value = 'mutual_fund'
        AND source_collection_value = 'general_mf_faq'
      )
    )
    AND ownership_manifest_id_value IS NOT NULL
    AND btrim(ownership_manifest_id_value) <> ''
    AND ownership_manifest_version_value > 0
    AND (
      (visibility_scope_value = 'GLOBAL' AND tenant_id_value IS NULL)
      OR (
        visibility_scope_value = 'TENANT'
        AND tenant_id_value IS NOT NULL
        AND btrim(tenant_id_value) <> ''
      )
    );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF bm25_searchable_chunk(
    NEW.knowledge_domain,
    NEW.source_collection,
    NEW.publication_status,
    NEW.visibility_scope,
    NEW.tenant_id,
    NEW.ownership_manifest_id,
    NEW.ownership_manifest_version
  ) THEN
    INSERT INTO chunk_search_documents (chunk_id, search_tokens)
    VALUES (
      NEW.id,
      bm25_tokens(
        coalesce(NEW.original_question, '') || ' ' ||
        coalesce(NEW.original_question, '') || ' ' ||
        coalesce(NEW.original_question, '') || ' ' ||
        coalesce(NEW.topic, '') || ' ' ||
        coalesce(NEW.topic, '') || ' ' ||
        coalesce(NEW.document_title, '') || ' ' ||
        coalesce(NEW.publisher, '') || ' ' ||
        coalesce(NEW.section_header, '') || ' ' ||
        coalesce(NEW.section_header, '') || ' ' ||
        NEW.text
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
DROP TRIGGER IF EXISTS chunks_search_document_sync ON chunks;--> statement-breakpoint
CREATE TRIGGER chunks_search_document_sync
AFTER INSERT OR UPDATE OF
  text,
  section_header,
  document_title,
  publisher,
  topic,
  original_question,
  normalized_question_key,
  knowledge_domain,
  source_collection,
  publication_status,
  visibility_scope,
  tenant_id,
  ownership_manifest_id,
  ownership_manifest_version
ON chunks
FOR EACH ROW EXECUTE FUNCTION sync_chunk_search_document();--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_html_chunk_search_document()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF bm25_searchable_chunk(
    NEW.knowledge_domain,
    NEW.source_collection,
    NEW.publication_status,
    NEW.visibility_scope,
    NEW.tenant_id,
    NEW.ownership_manifest_id,
    NEW.ownership_manifest_version
  ) THEN
    INSERT INTO html_chunk_search_documents (chunk_id, search_tokens)
    VALUES (
      NEW.id,
      bm25_tokens(
        NEW.document_title || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' ||
        coalesce(NEW.section_heading, '') || ' ' ||
        NEW.text
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
DROP TRIGGER IF EXISTS html_chunks_search_document_sync ON html_chunks;--> statement-breakpoint
CREATE TRIGGER html_chunks_search_document_sync
AFTER INSERT OR UPDATE OF
  text,
  document_title,
  section_heading,
  knowledge_domain,
  source_collection,
  publication_status,
  visibility_scope,
  tenant_id,
  ownership_manifest_id,
  ownership_manifest_version
ON html_chunks
FOR EACH ROW EXECUTE FUNCTION sync_html_chunk_search_document();--> statement-breakpoint
DELETE FROM chunk_search_documents AS search_document
WHERE NOT EXISTS (
  SELECT 1
  FROM chunks
  WHERE chunks.id = search_document.chunk_id
    AND bm25_searchable_chunk(
      chunks.knowledge_domain,
      chunks.source_collection,
      chunks.publication_status,
      chunks.visibility_scope,
      chunks.tenant_id,
      chunks.ownership_manifest_id,
      chunks.ownership_manifest_version
    )
);--> statement-breakpoint
INSERT INTO chunk_search_documents (chunk_id, search_tokens)
SELECT
  id,
  bm25_tokens(
    coalesce(original_question, '') || ' ' ||
    coalesce(original_question, '') || ' ' ||
    coalesce(original_question, '') || ' ' ||
    coalesce(topic, '') || ' ' ||
    coalesce(topic, '') || ' ' ||
    coalesce(document_title, '') || ' ' ||
    coalesce(publisher, '') || ' ' ||
    coalesce(section_header, '') || ' ' ||
    coalesce(section_header, '') || ' ' ||
    text
  )
FROM chunks
WHERE bm25_searchable_chunk(
  knowledge_domain,
  source_collection,
  publication_status,
  visibility_scope,
  tenant_id,
  ownership_manifest_id,
  ownership_manifest_version
)
ON CONFLICT (chunk_id) DO UPDATE
SET search_tokens = EXCLUDED.search_tokens;--> statement-breakpoint
DELETE FROM html_chunk_search_documents AS search_document
WHERE NOT EXISTS (
  SELECT 1
  FROM html_chunks
  WHERE html_chunks.id = search_document.chunk_id
    AND bm25_searchable_chunk(
      html_chunks.knowledge_domain,
      html_chunks.source_collection,
      html_chunks.publication_status,
      html_chunks.visibility_scope,
      html_chunks.tenant_id,
      html_chunks.ownership_manifest_id,
      html_chunks.ownership_manifest_version
    )
);--> statement-breakpoint
INSERT INTO html_chunk_search_documents (chunk_id, search_tokens)
SELECT
  id,
  bm25_tokens(
    document_title || ' ' ||
    coalesce(section_heading, '') || ' ' ||
    coalesce(section_heading, '') || ' ' ||
    coalesce(section_heading, '') || ' ' ||
    text
  )
FROM html_chunks
WHERE bm25_searchable_chunk(
  knowledge_domain,
  source_collection,
  publication_status,
  visibility_scope,
  tenant_id,
  ownership_manifest_id,
  ownership_manifest_version
)
ON CONFLICT (chunk_id) DO UPDATE
SET search_tokens = EXCLUDED.search_tokens;
