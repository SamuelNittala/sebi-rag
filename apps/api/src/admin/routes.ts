import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { csrf } from "hono/csrf";

import { createTenantId } from "@mf-rag/types";
import type { ReviewAuthConfig } from "../review/routes.ts";
import {
  ApiKeyNotFoundError,
  createApiKeyId,
  type ApiKeyScopeStore,
} from "./api-key-scope-store.ts";
import { renderApiKeyScopeAdmin } from "./views.ts";

export interface ScopeGrantAuditRecord {
  readonly event: "api_key_tenant_scope_granted";
  readonly actor: string;
  readonly apiKeyId: string;
  readonly tenantId: string;
  readonly changed: boolean;
}

export type ScopeGrantAudit = (record: ScopeGrantAuditRecord) => void;

const logScopeGrant: ScopeGrantAudit = (record) => {
  console.info(JSON.stringify(record));
};

function formString(body: Record<string, string | File>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

export function createAdminApp(
  store: ApiKeyScopeStore,
  auth: ReviewAuthConfig,
  audit: ScopeGrantAudit = logScopeGrant,
): Hono {
  const app = new Hono();
  app.use("*", basicAuth({
    username: auth.username,
    password: auth.password,
    realm: "RAG Administration",
  }));
  app.use("*", csrf());

  app.get("/", async (c) => {
    return c.html(renderApiKeyScopeAdmin({ apiKeys: await store.listApiKeys() }));
  });

  app.post("/api-keys/:keyId/scopes", async (c) => {
    try {
      const apiKeyId = createApiKeyId(c.req.param("keyId"));
      const body = await c.req.parseBody();
      const tenantId = createTenantId(formString(body, "tenantId"));
      const changed = await store.grantTenant(apiKeyId, tenantId);
      audit({
        event: "api_key_tenant_scope_granted",
        actor: auth.username,
        apiKeyId,
        tenantId,
        changed,
      });
      return c.redirect(`/admin#key-${apiKeyId}`, 303);
    } catch (error) {
      if (error instanceof ApiKeyNotFoundError) return c.text(error.message, 404);
      if (error instanceof Error && (
        error.message.startsWith("API key ID")
        || error.message.startsWith("Tenant ID")
        || error.message.endsWith("is required.")
      )) {
        return c.text(error.message, 400);
      }
      console.error("Unable to grant API key tenant scope", error);
      return c.text("Unable to grant AMC scope.", 500);
    }
  });

  return app;
}
