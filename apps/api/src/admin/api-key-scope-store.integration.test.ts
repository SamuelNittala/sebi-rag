import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Database } from "@mf-rag/db/client";
import { createTenantId } from "@mf-rag/types";
import {
  createApiKeyId,
  DrizzleApiKeyScopeStore,
} from "./api-key-scope-store.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

integrationDescribe("API key scope store", () => {
  let db: Database;
  let client: Awaited<typeof import("@mf-rag/db/client")>["client"];
  let store: DrizzleApiKeyScopeStore;
  let keyId = createApiKeyId("00000000-0000-0000-0000-000000000000");

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const dbModule = await import("@mf-rag/db/client");
    db = dbModule.db;
    client = dbModule.client;
    store = new DrizzleApiKeyScopeStore(db);
    const fingerprint = crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
    const [key] = await client`
      INSERT INTO api_keys (key_fingerprint, name, tier, is_active)
      VALUES (${fingerprint}, 'admin-scope-store-test', 'free', true)
      RETURNING id
    `;
    if (!key) throw new Error("Failed to create test API key");
    keyId = createApiKeyId(key.id as string);
  });

  afterAll(async () => {
    await client`DELETE FROM api_keys WHERE id = ${keyId}`;
    await client.close();
  });

  test("adds an exact tenant grant once and includes it in the key listing", async () => {
    const tenantId = createTenantId("176");

    expect(await store.grantTenant(keyId, tenantId)).toBe(true);
    expect(await store.grantTenant(keyId, tenantId)).toBe(false);

    const key = (await store.listApiKeys()).find((candidate) => candidate.id === keyId);
    expect(key?.tenantIds).toEqual([tenantId]);
  });
});
