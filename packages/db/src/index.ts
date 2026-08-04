// Database package - PostgreSQL with Drizzle ORM and Bun SQL driver

// Re-export client
export { db, client, schema, type Database } from "./client.ts";

// Re-export schema
export * from "./schema.ts";

// Re-export query helpers
export * from "./queries.ts";
export * from "./review-queries.ts";
export * from "./source-registry-queries.ts";

// Re-export drizzle-orm utilities for consumers to use the same version
export { eq, and, or, sql, desc, asc } from "drizzle-orm";
