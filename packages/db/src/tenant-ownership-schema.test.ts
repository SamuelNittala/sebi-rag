import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import {
  apiKeys,
  apiKeyTenantScopes,
  chunkCandidates,
  chunks,
  documents,
  htmlChunks,
  htmlDocuments,
  ingestionRuns,
  tenantOwnershipManifestApplications,
  usageRecords,
} from "./schema.ts";

describe("tenant ownership schema", () => {
  test("legacy knowledge rows expand as unclassified with immutable manifest snapshots", () => {
    for (const table of [
      documents,
      chunks,
      htmlDocuments,
      htmlChunks,
      ingestionRuns,
      chunkCandidates,
    ]) {
      const columns = getTableConfig(table).columns;
      const visibility = columns.find((column) => column.name === "visibility_scope");
      expect(visibility?.default).toBe("UNCLASSIFIED");
      expect(columns.map((column) => column.name)).toContain("tenant_id");
      expect(columns.map((column) => column.name)).toContain("ownership_manifest_id");
      expect(columns.map((column) => column.name)).toContain("ownership_manifest_version");
      expect(getTableConfig(table).checks).toHaveLength(1);
    }
  });

  test("one API key can hold multiple exact grants without duplicate grants", () => {
    const config = getTableConfig(apiKeyTenantScopes);
    expect(config.primaryKeys).toHaveLength(1);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "api_key_id",
      "tenant_id",
    ]);
    expect(apiKeys.keyFingerprint.name).toBe("key_fingerprint");
    expect(apiKeys.keyFingerprint.isUnique).toBe(true);
  });

  test("usage captures decision context without a raw credential or question column", () => {
    const columnNames = getTableConfig(usageRecords).columns.map((column) => column.name);
    expect(columnNames).toEqual(expect.arrayContaining([
      "api_key_id",
      "correlation_id",
      "tenant_id",
      "operation",
      "decision",
      "reason_code",
      "result_count",
    ]));
    expect(columnNames).not.toContain("credential");
    expect(columnNames).not.toContain("raw_question");
  });

  test("manifest applications have one immutable identity and checksum", () => {
    const config = getTableConfig(tenantOwnershipManifestApplications);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      "manifest_id",
      "manifest_version",
    ]);
    expect(config.columns.map((column) => column.name)).toContain("manifest_checksum");
  });
});
