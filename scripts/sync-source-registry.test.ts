import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceDocumentType, SourceParseConfig } from "@mf-rag/types";

import { loadAccessScopeManifests } from "../apps/pipeline/src/config/access-scope-manifest.ts";
import { prepareSourceRegistryRevision } from "../packages/db/src/source-registry-queries.ts";
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
  test("committed manifests without a parse block keep their pre-Docling checksums", async () => {
    const desired = await loadAccessScopeManifests(new URL("../config/access-scopes/", import.meta.url));
    const scopeChecksum = (key: string) => prepareSourceRegistryRevision({
      version: 1,
      accessScopes: desired.accessScopes.filter((scope) => scope.accessScopeKey === key),
    }).checksum;

    // axis-mf and mirae-sif are the baselines computed before `parse` and
    // `documentType` existed. mirae-mf and the registry changed only because
    // `mirae-mf-2026-factsheets` declares `documentType: Factsheet`; enabling
    // Docling on a source (T20) changes them again.
    expect(scopeChecksum("axis-mf")).toBe("4badf405b3c47129fdcc41f61eff55e799bcc92252ed60609b3aa5ad530e2d82");
    expect(scopeChecksum("mirae-sif")).toBe("d3a34e3089ce22b4d18154488b39ea9a298928463023f7c6ab83728fa464296a");
    expect(scopeChecksum("mirae-mf")).toBe("181255cdefafc2a47fe09bb252a2589c83ae0caa0de33e237747f842f4b37b60");
    expect(prepareSourceRegistryRevision(desired).checksum)
      .toBe("470458eb96c4477e96e134b36ec9d6dd9c86328d1394606a1b82dc2daba63461");
  });

  test("a parse block changes the checksum and is kept in canonical desired state", async () => {
    const desired = await loadAccessScopeManifests(new URL("../config/access-scopes/", import.meta.url));
    const [scope] = desired.accessScopes;
    const [source] = scope!.sources;
    const withParse = (parse: SourceParseConfig) => ({
      version: 1 as const,
      accessScopes: [{ ...scope!, sources: [{ ...source!, parse }] }],
    });
    const without = prepareSourceRegistryRevision({ version: 1, accessScopes: [scope!] });
    const docling = prepareSourceRegistryRevision(withParse({ parser: "docling" }));
    const unpdf = prepareSourceRegistryRevision(withParse({ parser: "unpdf" }));

    expect(docling.checksum).not.toBe(without.checksum);
    expect(unpdf.checksum).not.toBe(docling.checksum);
    expect(docling.desiredState.accessScopes[0]?.sources
      .find((candidate) => candidate.sourceKey === source!.sourceKey)?.parse).toEqual({ parser: "docling" });
    expect(without.desiredState.accessScopes[0]?.sources.every((candidate) => !Object.hasOwn(candidate, "parse")))
      .toBe(true);
  });

  test("a documentType changes the checksum and is kept in canonical desired state", async () => {
    const desired = await loadAccessScopeManifests(new URL("../config/access-scopes/", import.meta.url));
    const scope = desired.accessScopes.find((candidate) => candidate.accessScopeKey === "axis-mf")!;
    const [source] = scope.sources;
    const withType = (documentType: SourceDocumentType) => prepareSourceRegistryRevision({
      version: 1,
      accessScopes: [{ ...scope, sources: [{ ...source!, documentType }] }],
    });
    const without = prepareSourceRegistryRevision({ version: 1, accessScopes: [scope] });
    const sid = withType("SID");
    const factsheet = withType("Factsheet");

    expect(sid.checksum).not.toBe(without.checksum);
    expect(factsheet.checksum).not.toBe(sid.checksum);
    const canonical = factsheet.desiredState.accessScopes[0]?.sources[0];
    expect(canonical?.documentType).toBe("Factsheet");
    expect(Object.hasOwn(canonical!, "parse")).toBe(false);
    expect(without.desiredState.accessScopes[0]?.sources.every((candidate) => !Object.hasOwn(candidate, "documentType")))
      .toBe(true);
  });

  test("removing the committed documentType restores the pre-documentType checksums", async () => {
    const desired = await loadAccessScopeManifests(new URL("../config/access-scopes/", import.meta.url));
    const stripped = {
      version: 1 as const,
      accessScopes: desired.accessScopes.map((scope) => ({
        ...scope,
        sources: scope.sources.map(({ documentType: _documentType, ...source }) => source),
      })),
    };
    const mirae = stripped.accessScopes.filter((scope) => scope.accessScopeKey === "mirae-mf");

    expect(prepareSourceRegistryRevision({ version: 1, accessScopes: mirae }).checksum)
      .toBe("69933238f3022afa780dbbcfd9bfd2f140593bed4d7b8954b4a4d2aa7c5e92d5");
    expect(prepareSourceRegistryRevision(stripped).checksum)
      .toBe("92557eddaf610f648c3e36e9e21f012d9cea31cfdc15c91b2d32e918faadb90e");
  });

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
