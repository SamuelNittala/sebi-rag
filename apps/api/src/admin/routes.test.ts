import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import { createTenantId } from "@mf-rag/types";
import {
  createApiKeyId,
  type ApiKeyScopeStore,
} from "./api-key-scope-store.ts";
import { createAdminApp } from "./routes.ts";

const authorization = `Basic ${btoa("reviewer:secret")}`;
const keyId = createApiKeyId("73d13d16-6735-4203-a3ba-16ce14a53097");

function requestHeaders(): Record<string, string> {
  return {
    authorization,
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
  };
}

describe("API key scope admin routes", () => {
  test("requires the configured admin credentials", async () => {
    const store: ApiKeyScopeStore = {
      listApiKeys: mock(async () => []),
      grantTenant: mock(async () => true),
    };
    const app = createAdminApp(store, { username: "reviewer", password: "secret" });

    const response = await app.request("/");

    expect(response.status).toBe(401);
  });

  test("renders API keys and their current AMC scopes", async () => {
    const listApiKeys = mock(async () => [{
      id: keyId,
      name: "investor-agent-uat",
      tier: "free",
      isActive: true,
      tenantIds: [createTenantId("176"), createTenantId("910")],
    }]);
    const store: ApiKeyScopeStore = {
      listApiKeys,
      grantTenant: mock(async () => true),
    };
    const app = new Hono();
    app.route("/admin", createAdminApp(
      store,
      { username: "reviewer", password: "secret" },
    ));

    const response = await app.request("/admin", { headers: { authorization } });

    expect(response.status).toBe(200);
    expect(listApiKeys).toHaveBeenCalledTimes(1);
    expect(await response.text()).toContain("investor-agent-uat");
  });

  test("grants one canonical AMC scope and redirects to the edited key", async () => {
    const grantTenant = mock(async () => true);
    const audit = mock(() => undefined);
    const store: ApiKeyScopeStore = {
      listApiKeys: mock(async () => []),
      grantTenant,
    };
    const app = createAdminApp(
      store,
      { username: "reviewer", password: "secret" },
      audit,
    );

    const response = await app.request(`/api-keys/${keyId}/scopes`, {
      method: "POST",
      headers: requestHeaders(),
      body: new URLSearchParams({ tenantId: "176" }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/admin#key-${keyId}`);
    expect(grantTenant).toHaveBeenCalledWith(keyId, "176");
    expect(audit).toHaveBeenCalledWith({
      event: "api_key_tenant_scope_granted",
      actor: "reviewer",
      apiKeyId: keyId,
      tenantId: "176",
      changed: true,
    });
  });

  test("rejects wildcard and whitespace-variant AMC scopes", async () => {
    const grantTenant = mock(async () => true);
    const store: ApiKeyScopeStore = {
      listApiKeys: mock(async () => []),
      grantTenant,
    };
    const app = createAdminApp(store, { username: "reviewer", password: "secret" });

    for (const tenantId of ["*", " 176 "]) {
      const response = await app.request(`/api-keys/${keyId}/scopes`, {
        method: "POST",
        headers: requestHeaders(),
        body: new URLSearchParams({ tenantId }),
      });
      expect(response.status).toBe(400);
    }
    expect(grantTenant).not.toHaveBeenCalled();
  });
});
