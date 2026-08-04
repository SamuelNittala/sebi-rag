import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAccessScopeManifests,
  parseAccessScopeManifestYaml,
} from "./access-scope-manifest.ts";
import { createLogicalDocumentKey } from "@mf-rag/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
});

describe("access-scope manifest validation", () => {
  test("loads the disabled 910 and 117 manifests as distinct immutable scopes", async () => {
    const configDirectory = new URL("../../../../config/access-scopes/", import.meta.url);

    const desiredState = await loadAccessScopeManifests(configDirectory);

    expect(desiredState.accessScopes.map((scope) => ({
      externalCode: String(scope.externalCode),
      key: String(scope.accessScopeKey),
    }))).toEqual([
      { externalCode: "117", key: "mirae-mf" },
      { externalCode: "910", key: "mirae-sif" },
    ]);
    expect(desiredState.accessScopes.every((scope) => (
      scope.sources.every((source) => !source.enabled && !source.schedule.enabled)
    ))).toBe(true);
    expect(Object.isFrozen(desiredState)).toBe(true);
    expect(Object.isFrozen(desiredState.accessScopes)).toBe(true);
    expect(Object.isFrozen(desiredState.accessScopes[0]?.sources)).toBe(true);
  });

  test("rejects an organization slug as the external access code", () => {
    const yaml = validManifest().replace('externalCode: "910"', "externalCode: mirae-asset");

    expect(() => parseAccessScopeManifestYaml(yaml, "bad-code.yml"))
      .toThrow(/externalCode/i);
  });

  test("rejects omitted TENANT ownership", () => {
    const yaml = validManifest().replace(
      /ownership:\n  visibilityScope: TENANT\n  tenantId: "910"\n/,
      "",
    );

    expect(() => parseAccessScopeManifestYaml(yaml, "missing-ownership.yml"))
      .toThrow(/ownership/i);
  });

  test("rejects inline secrets but accepts a deployment-managed secret reference", () => {
    const withSecretReference = validManifest().replace(
      "      allowedHosts:",
      "      secretRef: MIRAE_SIF_WEBSITE_AUTH\n      allowedHosts:",
    );
    const withInlineToken = withSecretReference.replace(
      "      secretRef: MIRAE_SIF_WEBSITE_AUTH",
      "      token: actual-secret-value",
    );

    expect(parseAccessScopeManifestYaml(withSecretReference, "secret-ref.yml")
      .sources[0]?.fetch.secretRef).toBe("MIRAE_SIF_WEBSITE_AUTH");
    expect(() => parseAccessScopeManifestYaml(withInlineToken, "inline-token.yml"))
      .toThrow(/inline secret|token/i);
  });

  test("rejects duplicate source keys", () => {
    const duplicateSource = sourceBlock().replace(
      "  - key: mirae-sif-public-pdfs",
      "  - key: mirae-sif-public-pdfs",
    );
    const yaml = validManifest().replace(
      sourceBlock(),
      `${sourceBlock()}${duplicateSource}`,
    );

    expect(() => parseAccessScopeManifestYaml(yaml, "duplicate-source.yml"))
      .toThrow(/duplicate source key/i);
  });

  test("rejects an unknown discovery strategy", () => {
    const yaml = validManifest().replace("strategy: explicit_urls", "strategy: ftp_listing");

    expect(() => parseAccessScopeManifestYaml(yaml, "unknown-strategy.yml"))
      .toThrow(/strategy/i);
  });

  test("requires human-pinned keys for explicit documents", () => {
    const parsed = parseAccessScopeManifestYaml(validManifest().replace(
      "      urls: []",
      "      urls:\n        - key: scheme-information-document\n          url: https://platinumsif.miraeassetmf.co.in/documents/sid.pdf",
    ));
    expect(parsed.sources[0]?.discovery).toEqual({
      strategy: "explicit_urls",
      urls: [{
        key: createLogicalDocumentKey("scheme-information-document"),
        url: "https://platinumsif.miraeassetmf.co.in/documents/sid.pdf",
      }],
    });

    const stringOnly = validManifest().replace(
      "      urls: []",
      "      urls:\n        - https://platinumsif.miraeassetmf.co.in/documents/sid.pdf",
    );
    expect(() => parseAccessScopeManifestYaml(stringOnly)).toThrow(/key|object/i);
  });

  test("rejects duplicate pinned identities and non-HTTP discovery URLs", () => {
    const duplicate = validManifest().replace(
      "      urls: []",
      "      urls:\n        - key: factsheet\n          url: https://platinumsif.miraeassetmf.co.in/a.pdf\n        - key: factsheet\n          url: https://platinumsif.miraeassetmf.co.in/b.pdf",
    );
    expect(() => parseAccessScopeManifestYaml(duplicate)).toThrow(/duplicate pinned document key/i);
    const ftp = validManifest().replace(
      "      urls: []",
      "      urls:\n        - key: factsheet\n          url: ftp://platinumsif.miraeassetmf.co.in/a.pdf",
    );
    expect(() => parseAccessScopeManifestYaml(ftp)).toThrow(/HTTP or HTTPS/i);
  });

  test("rejects configured query strings and secret-bearing identity parameters", () => {
    const configuredQuery = validManifest().replace(
      "      urls: []",
      "      urls:\n        - key: factsheet\n          url: https://platinumsif.miraeassetmf.co.in/a.pdf?token=secret",
    );
    expect(() => parseAccessScopeManifestYaml(configuredQuery)).toThrow(/query parameters/i);

    const identitySecret = validManifest()
      .replace("strategy: explicit_urls\n      urls: []", `strategy: sitemap
      sitemapUrls:
        - https://platinumsif.miraeassetmf.co.in/sitemap.xml
      includePathPrefixes:
        - /
      maxDocuments: 10
      identity:
        strategy: normalized_path
        queryParameters: [token]`);
    expect(() => parseAccessScopeManifestYaml(identitySecret)).toThrow(/secret-bearing query/i);
  });

  test.each([
    ["invalid cron", 'cron: "0 2 * * *"', 'cron: "61 25 * * *"', /cron/i],
    ["invalid timezone", "timezone: Asia/Kolkata", "timezone: Mars/Olympus", /timezone/i],
  ])("rejects %s", (_name, valid, invalid, expected) => {
    const yaml = validManifest().replace(valid, invalid);

    expect(() => parseAccessScopeManifestYaml(yaml, "invalid-schedule.yml"))
      .toThrow(expected);
  });

  test("rejects unknown fields at every manifest boundary", () => {
    const yaml = validManifest().replace(
      "kind: AccessScope",
      "kind: AccessScope\norganization: mirae-asset",
    );

    expect(() => parseAccessScopeManifestYaml(yaml, "unknown-field.yml"))
      .toThrow(/organization|unrecognized/i);
  });

  test("rejects an empty manifest file", () => {
    expect(() => parseAccessScopeManifestYaml("", "empty.yml"))
      .toThrow(/manifest|object/i);
  });

  test("rejects an empty manifest directory", async () => {
    const directory = await createTemporaryDirectory();

    await expect(loadAccessScopeManifests(directory)).rejects.toThrow(/no access-scope manifests/i);
  });

  test("validates every file before returning desired state", async () => {
    const directory = await createTemporaryDirectory();
    await Bun.write(join(directory, "910-valid.yml"), validManifest());
    await Bun.write(join(directory, "117-invalid.yml"), validManifest({
      externalCode: "117",
      key: "mirae-mf",
    }).replace('cron: "0 2 * * *"', 'cron: "broken"'));

    await expect(loadAccessScopeManifests(directory)).rejects.toThrow(/117-invalid\.yml.*cron/is);
  });

  test("rejects duplicate scope keys and external codes across files", async () => {
    const directory = await createTemporaryDirectory();
    await Bun.write(join(directory, "first.yml"), validManifest());
    await Bun.write(join(directory, "second.yml"), validManifest());

    await expect(loadAccessScopeManifests(directory)).rejects.toThrow(
      /duplicate access-scope key|duplicate external code/i,
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mf-rag-manifests-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validManifest(overrides: { key?: string; externalCode?: string } = {}): string {
  const key = overrides.key ?? "mirae-sif";
  const externalCode = overrides.externalCode ?? "910";

  return `apiVersion: mf-rag/v1
kind: AccessScope
metadata:
  key: ${key}
  externalCode: "${externalCode}"
ownership:
  visibilityScope: TENANT
  tenantId: "${externalCode}"
classification:
  knowledgeDomain: sif
  sourceCollection: mirae_sif
  amcSlug: mirae-asset
sources:
${sourceBlock()}`;
}

function sourceBlock(): string {
  return `  - key: mirae-sif-public-pdfs
    connector: website_pdf
    enabled: false
    discovery:
      strategy: explicit_urls
      urls: []
    schedule:
      enabled: false
      cron: "0 2 * * *"
      timezone: Asia/Kolkata
    fetch:
      allowedHosts:
        - platinumsif.miraeassetmf.co.in
      allowedPathPrefixes:
        - /
      maxBytes: 26214400
      timeoutMs: 30000
      maxRedirects: 3
    review:
      policy: risk_based
`;
}
