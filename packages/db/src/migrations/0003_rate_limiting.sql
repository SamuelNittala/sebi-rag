-- API keys table for rate limiting
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" varchar(64) UNIQUE NOT NULL,
  "tier" varchar(20) DEFAULT 'free' NOT NULL,
  "name" varchar(100),
  "email" varchar(255),
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

-- Usage records for tracking API usage
CREATE TABLE IF NOT EXISTS "usage_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "tool_name" varchar(50) NOT NULL,
  "query_hash" varchar(64),
  "response_time_ms" integer,
  "chunks_retrieved" integer,
  "timestamp" timestamp DEFAULT now() NOT NULL
);

-- Indexes for efficient rate limit checking
CREATE INDEX IF NOT EXISTS "api_keys_key_idx" ON "api_keys" ("key");
CREATE INDEX IF NOT EXISTS "api_keys_is_active_idx" ON "api_keys" ("is_active");
CREATE INDEX IF NOT EXISTS "usage_records_api_key_id_idx" ON "usage_records" ("api_key_id");
CREATE INDEX IF NOT EXISTS "usage_records_timestamp_idx" ON "usage_records" ("timestamp");
CREATE INDEX IF NOT EXISTS "usage_records_api_key_timestamp_idx" ON "usage_records" ("api_key_id", "timestamp");
