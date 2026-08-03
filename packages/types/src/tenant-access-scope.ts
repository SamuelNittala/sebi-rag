import type { KnowledgeOwnership } from "./knowledge-scope.ts";

declare const tenantIdBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: true };

export interface TenantAccessScope {
  readonly tenantId: TenantId;
}

const TENANT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,98}[A-Za-z0-9])?$/;

export function createTenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new Error("Tenant ID must be an exact canonical 1-100 character identifier.");
  }
  return value as TenantId;
}

export function createTenantAccessScope(tenantId: string): TenantAccessScope {
  return Object.freeze({ tenantId: createTenantId(tenantId) });
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
  return ownership.tenantId === accessScope.tenantId;
}
