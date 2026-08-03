ALTER TABLE "api_keys" ALTER COLUMN "key_fingerprint" DROP EXPRESSION;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "key_fingerprint" SET NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "api_keys_key_idx";--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN "key";
