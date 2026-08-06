import type { KnowledgeOwnership } from "./knowledge-scope.ts";

declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };

export type TenantAccessScope = Readonly<
  | {
      kind?: "tenant";
      tenantId: TenantId;
    }
  | {
      kind: "tenant-set";
      tenantId: TenantId;
      tenantIds: readonly TenantId[];
    }
>;

const TENANT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;
const AUTHORIZED_RTA_SCOPE = "RTA";
const RTA_AMC_TENANT_IDS = Object.freeze(
  ["101", "128", "183", "185", "RMF"].map(createTenantId),
);

export function createTenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new Error("Tenant ID must be an exact canonical 1-100 character identifier.");
  }
  return value as TenantId;
}

export function createTenantAccessScope(tenantId: string): TenantAccessScope {
  return Object.freeze({
    kind: "tenant",
    tenantId: createTenantId(tenantId),
  });
}

/**
 * Converts a tenant ID that has already passed exact credential authorization
 * into its repository capability. Do not use this for raw configuration or
 * request input; those must remain exact-tenant scopes until authorized.
 */
export function createAuthorizedTenantAccessScope(
  tenantId: string,
): TenantAccessScope {
  const tenantScope = createTenantAccessScope(tenantId);
  if (tenantScope.tenantId !== AUTHORIZED_RTA_SCOPE) {
    return tenantScope;
  }
  return Object.freeze({
    kind: "tenant-set",
    tenantId: tenantScope.tenantId,
    tenantIds: RTA_AMC_TENANT_IDS,
  });
}

export function isOwnershipVisible(
  ownership: KnowledgeOwnership,
  accessScope: TenantAccessScope,
): boolean {
  if (ownership.visibilityScope === "GLOBAL") {
    return true;
  }
  if (ownership.visibilityScope === "UNCLASSIFIED") {
    return false;
  }
  if (accessScope.kind === "tenant-set") {
    return accessScope.tenantIds.some(
      (tenantId) => tenantId === ownership.tenantId,
    );
  }
  return ownership.tenantId === accessScope.tenantId;
}
