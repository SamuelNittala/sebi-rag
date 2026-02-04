CREATE TABLE "document_funds" (
	"document_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	CONSTRAINT "document_funds_document_id_fund_id_pk" PRIMARY KEY("document_id","fund_id")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" varchar(255) NOT NULL,
	"filepath" varchar(500) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"doc_type" varchar(50),
	"document_date" date,
	"page_count" integer,
	"chunk_count" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "documents_file_hash_unique" UNIQUE("file_hash")
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"amc_name" varchar(255),
	"scheme_type" varchar(50),
	"scheme_category" varchar(100),
	"isin_growth" varchar(20),
	"isin_dividend" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_funds" ADD CONSTRAINT "document_funds_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_funds" ADD CONSTRAINT "document_funds_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;