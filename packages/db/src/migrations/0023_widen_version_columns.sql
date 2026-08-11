-- Widen version columns from varchar(50) to varchar(200).
-- The combined parserVersion+tableExtractorVersion format can reach
-- 64+1+64 = 129 chars when using SHA-256 checksums as version identifiers.
ALTER TABLE ingestion_runs
  ALTER COLUMN parser_version TYPE varchar(200),
  ALTER COLUMN chunker_version TYPE varchar(200),
  ALTER COLUMN inspector_version TYPE varchar(200);

ALTER TABLE document_publication_generations
  ALTER COLUMN parser_version TYPE varchar(200),
  ALTER COLUMN chunker_version TYPE varchar(200),
  ALTER COLUMN inspector_version TYPE varchar(200);
