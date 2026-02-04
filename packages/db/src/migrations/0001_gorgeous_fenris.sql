CREATE TABLE "amcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sebi_id" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "amcs_sebi_id_unique" UNIQUE("sebi_id")
);
--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "sebi_scheme_id" varchar(50);--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "sebi_fund_id" varchar(50);--> statement-breakpoint
ALTER TABLE "funds" ADD COLUMN "amc_id" uuid;--> statement-breakpoint
CREATE INDEX "amcs_sebi_id_idx" ON "amcs" USING btree ("sebi_id");--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_amc_id_amcs_id_fk" FOREIGN KEY ("amc_id") REFERENCES "public"."amcs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "funds_sebi_scheme_id_idx" ON "funds" USING btree ("sebi_scheme_id");--> statement-breakpoint
CREATE INDEX "funds_sebi_fund_id_idx" ON "funds" USING btree ("sebi_fund_id");--> statement-breakpoint
CREATE INDEX "funds_amc_id_idx" ON "funds" USING btree ("amc_id");--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_sebi_scheme_id_unique" UNIQUE("sebi_scheme_id");