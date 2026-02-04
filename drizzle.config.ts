import type { Config } from "drizzle-kit";

export default {
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/src/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/mf_rag",
  },
} satisfies Config;
