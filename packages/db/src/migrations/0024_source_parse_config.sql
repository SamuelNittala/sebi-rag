-- Per-source PDF parser selection from the access-scope manifest `parse` block.
-- NULL means the default unpdf parser, so existing sources are unchanged.
ALTER TABLE "sources" ADD COLUMN "parse_config" jsonb;
