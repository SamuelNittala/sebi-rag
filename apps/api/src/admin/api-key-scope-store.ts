import { apiKeyTenantScopes } from "@mf-rag/db/schema";
import type { Database } from "@mf-rag/db/client";
import { createTenantId, type TenantId } from "@mf-rag/types";

declare const apiKeyIdBrand: unique symbol;

export type ApiKeyId = string & { readonly [apiKeyIdBrand]: true };

export interface ApiKeyScopeSummary {
  readonly id: ApiKeyId;
  readonly name: string | null;
  readonly tier: string;
  readonly isActive: boolean;
  readonly tenantIds: readonly TenantId[];
}

export interface ApiKeyScopeStore {
  listApiKeys(): Promise<readonly ApiKeyScopeSummary[]>;
  grantTenant(apiKeyId: ApiKeyId, tenantId: TenantId): Promise<boolean>;
}

const API_KEY_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createApiKeyId(value: string): ApiKeyId {
  if (!API_KEY_ID_PATTERN.test(value)) {
    throw new Error("API key ID must be a UUID.");
  }
  return value as ApiKeyId;
}

export class ApiKeyNotFoundError extends Error {
  constructor() {
    super("API key not found.");
    this.name = "ApiKeyNotFoundError";
  }
}

export class DrizzleApiKeyScopeStore implements ApiKeyScopeStore {
  constructor(private readonly db: Database) {}

  async listApiKeys(): Promise<readonly ApiKeyScopeSummary[]> {
    const rows = await this.db.query.apiKeys.findMany({
      columns: { id: true, name: true, tier: true, isActive: true },
      with: {
        tenantScopes: {
          columns: { tenantId: true },
          orderBy: (scopes, { asc }) => [asc(scopes.tenantId)],
        },
      },
      orderBy: (keys, { desc }) => [desc(keys.createdAt)],
    });

    return rows.map((row) => ({
      id: createApiKeyId(row.id),
      name: row.name,
      tier: row.tier,
      isActive: row.isActive,
      tenantIds: row.tenantScopes.map((scope) => createTenantId(scope.tenantId)),
    }));
  }

  async grantTenant(apiKeyId: ApiKeyId, tenantId: TenantId): Promise<boolean> {
    const key = await this.db.query.apiKeys.findFirst({
      columns: { id: true },
      where: (keys, { eq }) => eq(keys.id, apiKeyId),
    });
    if (!key) throw new ApiKeyNotFoundError();

    const inserted = await this.db
      .insert(apiKeyTenantScopes)
      .values({ apiKeyId, tenantId })
      .onConflictDoNothing()
      .returning({ tenantId: apiKeyTenantScopes.tenantId });
    return inserted.length === 1;
  }
}
