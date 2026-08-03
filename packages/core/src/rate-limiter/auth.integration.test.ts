import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("API credential tenant authorization", () => {
  let packageClient: typeof import("@mf-rag/db/client")["client"];
  let keyId = "";
  const credential = "mf_test_fingerprint_only_secret";

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { client, db } = await import("@mf-rag/db/client");
    const { apiKeys, apiKeyTenantScopes } = await import("@mf-rag/db/schema");
    packageClient = client;
    const [key] = await db.insert(apiKeys).values({
      keyFingerprint: createHash("sha256").update(credential).digest("hex"),
      tier: "free",
      name: "U3 integration",
    }).returning();
    keyId = key!.id;
    await db.insert(apiKeyTenantScopes).values([
      { apiKeyId: keyId, tenantId: "tenant-a" },
      { apiKeyId: keyId, tenantId: "tenant-b" },
    ]);
  });

  afterAll(async () => {
    const { db } = await import("@mf-rag/db/client");
    const { apiKeys } = await import("@mf-rag/db/schema");
    await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
    await packageClient.close();
  });

  test("one fingerprinted key selects either exact grant and rejects another", async () => {
    const { RateLimiter } = await import("./index.ts");
    const authorizer = new RateLimiter();

    expect(await authorizer.authorize(credential, "tenant-a")).toMatchObject({
      decision: "authorized",
      keyId,
    });
    expect(await authorizer.authorize(credential, "tenant-b")).toMatchObject({
      decision: "authorized",
      keyId,
    });
    expect(await authorizer.authorize(credential, "tenant-c")).toEqual({
      decision: "unauthorized_scope",
    });
    expect(await authorizer.authorize("unknown-secret", "tenant-a")).toEqual({
      decision: "invalid_credential",
    });
  });

  test("grant removal and key deactivation affect the immediately following request", async () => {
    const { db } = await import("@mf-rag/db/client");
    const { apiKeys, apiKeyTenantScopes } = await import("@mf-rag/db/schema");
    const { RateLimiter } = await import("./index.ts");
    const authorizer = new RateLimiter();

    expect((await authorizer.authorize(credential, "tenant-a")).decision)
      .toBe("authorized");
    await db.delete(apiKeyTenantScopes).where(and(
      eq(apiKeyTenantScopes.apiKeyId, keyId),
      eq(apiKeyTenantScopes.tenantId, "tenant-a"),
    ));
    expect(await authorizer.authorize(credential, "tenant-a")).toEqual({
      decision: "unauthorized_scope",
    });

    expect((await authorizer.authorize(credential, "tenant-b")).decision)
      .toBe("authorized");
    await db.update(apiKeys)
      .set({ isActive: false })
      .where(eq(apiKeys.id, keyId));
    expect(await authorizer.authorize(credential, "tenant-b")).toEqual({
      decision: "inactive_credential",
    });
  });
});
