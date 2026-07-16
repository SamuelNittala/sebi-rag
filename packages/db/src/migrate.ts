import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { SQL } from "bun";
import { resolve } from "node:path";

// Get database URL from environment (Bun auto-loads .env)
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}

async function runMigrations() {
  console.log("Running migrations...");

  const client = new SQL(databaseUrl!);
  const db = drizzle({ client });

  try {
    await migrate(db, {
      migrationsFolder: resolve(import.meta.dir, "migrations"),
    });
    console.log("Migrations completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

runMigrations();
