import { describe, expect, test } from "bun:test";

import {
  auditOwnershipInventory,
  computeManifestChecksum,
  validateOwnershipManifest,
  type OwnershipInventory,
  type TenantOwnershipManifest,
} from "../../../scripts/audit-tenant-ownership.ts";

const PDF_ID = "11111111-1111-4111-8111-111111111111";
const HTML_ID = "22222222-2222-4222-8222-222222222222";

function inventory(): OwnershipInventory {
  return {
    rows: [
      {
        sourceType: "pdf",
        documentId: PDF_ID,
        fileHash: "a".repeat(64),
        knowledgeDomain: "mutual_fund",
        sourceCollection: "default_corpus",
        amcSlug: "tenant-a",
        publicationState: "published",
        table: "documents",
        count: 1,
        visibilityScope: "UNCLASSIFIED",
        tenantId: null,
        ownershipManifestId: null,
        ownershipManifestVersion: null,
      },
      {
        sourceType: "pdf",
        documentId: PDF_ID,
        fileHash: "a".repeat(64),
        knowledgeDomain: "mutual_fund",
        sourceCollection: "default_corpus",
        amcSlug: "tenant-a",
        publicationState: "published",
        table: "chunks",
        count: 2,
        visibilityScope: "UNCLASSIFIED",
        tenantId: null,
        ownershipManifestId: null,
        ownershipManifestVersion: null,
      },
      {
        sourceType: "html",
        documentId: HTML_ID,
        fileHash: "b".repeat(64),
        knowledgeDomain: "mutual_fund",
        sourceCollection: "default_corpus",
        amcSlug: null,
        publicationState: "completed",
        table: "html_documents",
        count: 1,
        visibilityScope: "UNCLASSIFIED",
        tenantId: null,
        ownershipManifestId: null,
        ownershipManifestVersion: null,
      },
    ],
    orphans: [],
  };
}

async function manifest(currentInventory = inventory()): Promise<TenantOwnershipManifest> {
  const unsigned = {
    manifestId: "legacy-ownership-review",
    manifestVersion: 1,
    approvedBy: "reviewer@example.com",
    approvedAt: "2026-07-30T12:00:00.000Z",
    inventoryChecksum: await computeManifestChecksum(currentInventory),
    entries: [
      {
        sourceType: "pdf" as const,
        documentId: PDF_ID,
        fileHash: "a".repeat(64),
        visibilityScope: "TENANT" as const,
        tenantId: "tenant-a",
        expectedCounts: {
          documents: 1,
          ingestionRuns: 0,
          chunkCandidates: 0,
          chunks: 2,
        },
      },
      {
        sourceType: "html" as const,
        documentId: HTML_ID,
        fileHash: "b".repeat(64),
        visibilityScope: "GLOBAL" as const,
        tenantId: null,
        expectedCounts: {
          htmlDocuments: 1,
          ingestionRuns: 0,
          chunkCandidates: 0,
          htmlChunks: 0,
        },
      },
    ],
  };
  return {
    ...unsigned,
    manifestChecksum: await computeManifestChecksum(unsigned),
  };
}

describe("tenant ownership manifest audit", () => {
  test("ships a checksum-valid operator manifest example", async () => {
    const example = await Bun.file("config/tenant-ownership.example.json").json();
    expect(await validateOwnershipManifest(example)).toEqual([]);
  });

  test("accepts a complete reviewed manifest and reconciles exact counts", async () => {
    const approved = await manifest();
    expect(await validateOwnershipManifest(approved)).toEqual([]);
    expect(await auditOwnershipInventory(inventory(), approved)).toMatchObject({
      canApply: true,
      unresolvedPublishedRows: 3,
      errors: [],
    });
  });

  test("rejects missing published mappings, mixed ownership, and orphans", async () => {
    const approved = await manifest();
    const broken = inventory();
    broken.rows = broken.rows.filter((row) => row.documentId !== HTML_ID);
    broken.rows.push({
      ...broken.rows[1]!,
      visibilityScope: "GLOBAL",
      tenantId: null,
      ownershipManifestId: "other-manifest",
      ownershipManifestVersion: 1,
    });
    broken.orphans.push({
      table: "chunks",
      rowId: "33333333-3333-4333-8333-333333333333",
      reason: "missing document",
    });

    const result = await auditOwnershipInventory(broken, approved);
    expect(result.canApply).toBe(false);
    expect(result.errors.join("\n")).toContain("count drift");
    expect(result.errors.join("\n")).toContain("mixed ownership");
    expect(result.errors.join("\n")).toContain("orphan");
  });

  test("rejects stale inventory and a conflicting manifest checksum", async () => {
    const approved = await manifest();
    const stale = inventory();
    stale.rows[1] = { ...stale.rows[1]!, count: 3 };
    expect((await auditOwnershipInventory(stale, approved)).errors.join("\n")).toContain(
      "inventory checksum",
    );

    const tampered = { ...approved, approvedBy: "other@example.com" };
    expect((await validateOwnershipManifest(tampered)).join("\n")).toContain(
      "manifest checksum",
    );
  });

  test("rejects invalid global and tenant ownership combinations", async () => {
    const approved = await manifest();
    const invalid = {
      ...approved,
      entries: [
        { ...approved.entries[0]!, visibilityScope: "GLOBAL" as const, tenantId: "tenant-a" },
        { ...approved.entries[1]!, visibilityScope: "TENANT" as const, tenantId: null },
      ],
    };
    invalid.manifestChecksum = await computeManifestChecksum({
      ...invalid,
      manifestChecksum: undefined,
    });

    const errors = await validateOwnershipManifest(invalid);
    expect(errors.join("\n")).toContain("GLOBAL");
    expect(errors.join("\n")).toContain("TENANT");
  });
});
