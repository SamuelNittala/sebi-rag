import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncSourceRegistryFromDirectory } from "./sync-source-registry.ts";

const validManifest = `
apiVersion: mf-rag/v1
kind: AccessScope
metadata:
  key: mirae-sif
  externalCode: "910"
ownership:
  visibilityScope: TENANT
  tenantId: "910"
classification:
  knowledgeDomain: sif
  sourceCollection: mirae_sif
  amcSlug: mirae-asset
sources: []
`;

describe("source registry sync", () => {
  test("validates the complete directory before opening reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "source-registry-sync-"));
    let reconciliations = 0;
    try {
      await writeFile(join(directory, "valid.yml"), validManifest);
      await writeFile(join(directory, "invalid.yml"), "apiVersion: mf-rag/v1\nkind: AccessScope\ninlineToken: secret");

      await expect(syncSourceRegistryFromDirectory(directory, async () => {
        reconciliations += 1;
        throw new Error("must not be reached");
      })).rejects.toThrow("invalid.yml");
      expect(reconciliations).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
