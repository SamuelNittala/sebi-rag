import { drizzle } from "drizzle-orm/bun-sql";
import { SQL } from "bun";
import * as schema from "./schema.ts";

// Get database URL from environment (Bun auto-loads .env)
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Create Bun SQL client
const client = new SQL(databaseUrl);

// Create Drizzle instance with schema for relational queries
export const db = drizzle({ client, schema });

// Export client for direct access if needed
export { client };

// Export schema for convenience
export { schema };

// Type for the database instance
export type Database = typeof db;
