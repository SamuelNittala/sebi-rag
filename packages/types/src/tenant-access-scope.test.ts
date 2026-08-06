import { describe, expect, test } from "bun:test";
import {
  createAuthorizedTenantAccessScope,
  createTenantAccessScope,
  isOwnershipVisible,
  type KnowledgeOwnership,
  type TenantAccessScope,
} from "./index.ts";

const tenantOwnership = (tenantId: string): KnowledgeOwnership => ({
  visibilityScope: "TENANT",
  tenantId,
  ownershipManifestId: "tenant-access-scope-test",
  ownershipManifestVersion: 1,
});

describe("tenant access scope", () => {
  test("creates an exact tenant scope for an AMC", () => {
    const accessScope = createTenantAccessScope("176");

    expect(accessScope.kind).toBe("tenant");
    expect(accessScope.tenantId).toBe("176");
  });

  test("keeps raw RTA input scoped to the exact RTA tenant", () => {
    const accessScope = createTenantAccessScope("RTA");

    expect(accessScope.kind).toBe("tenant");
    expect(accessScope.tenantId).toBe("RTA");
    expect(isOwnershipVisible(tenantOwnership("176"), accessScope)).toBe(false);
  });

  test("expands authorized RTA to the configured AMC tenant set", () => {
    const rtaScope = createAuthorizedTenantAccessScope("RTA");
    const globalOwnership: KnowledgeOwnership = {
      visibilityScope: "GLOBAL",
      tenantId: null,
      ownershipManifestId: "tenant-access-scope-test",
      ownershipManifestVersion: 1,
    };
    const unclassifiedOwnership: KnowledgeOwnership = {
      visibilityScope: "UNCLASSIFIED",
      tenantId: null,
      ownershipManifestId: null,
      ownershipManifestVersion: null,
    };

    expect({
      ...rtaScope,
      tenantId: String(rtaScope.tenantId),
      tenantIds: rtaScope.kind === "tenant-set"
        ? rtaScope.tenantIds.map(String)
        : undefined,
    }).toEqual({
      kind: "tenant-set",
      tenantId: "RTA",
      tenantIds: ["101", "128", "183", "185", "RMF"],
    });
    expect(Object.isFrozen(rtaScope)).toBe(true);
    expect(Object.isFrozen(
      rtaScope.kind === "tenant-set" && rtaScope.tenantIds,
    )).toBe(true);
    expect(isOwnershipVisible(globalOwnership, rtaScope)).toBe(true);
    for (const tenantId of ["101", "128", "183", "185", "RMF"]) {
      expect(isOwnershipVisible(tenantOwnership(tenantId), rtaScope)).toBe(true);
    }
    expect(isOwnershipVisible(tenantOwnership("176"), rtaScope)).toBe(false);
    expect(isOwnershipVisible(tenantOwnership("RTA"), rtaScope)).toBe(false);
    expect(isOwnershipVisible(unclassifiedOwnership, rtaScope)).toBe(false);
  });

  test("keeps ordinary AMC scopes isolated", () => {
    const amcScope = createAuthorizedTenantAccessScope("176");

    expect(isOwnershipVisible(tenantOwnership("176"), amcScope)).toBe(true);
    expect(isOwnershipVisible(tenantOwnership("910"), amcScope)).toBe(false);
  });

  test("keeps near-miss rta scoped to the exact lowercase tenant", () => {
    const accessScope = createAuthorizedTenantAccessScope("rta");

    expect(accessScope.kind).toBe("tenant");
    expect(accessScope.tenantId).toBe("rta");
    expect(isOwnershipVisible(tenantOwnership("RTA"), accessScope)).toBe(false);
  });

  test("accepts legacy exact-tenant scopes without a kind discriminator", () => {
    const legacyScope: TenantAccessScope = {
      tenantId: createTenantAccessScope("176").tenantId,
    };

    expect(isOwnershipVisible(tenantOwnership("176"), legacyScope)).toBe(true);
    expect(isOwnershipVisible(tenantOwnership("910"), legacyScope)).toBe(false);
  });
});
