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
  test("loads enabled mutual-fund scopes and the disabled SIF scope", async () => {
    const configDirectory = new URL("../../../../config/access-scopes/", import.meta.url);

    const desiredState = await loadAccessScopeManifests(configDirectory);

    expect(desiredState.accessScopes.map((scope) => ({
      externalCode: String(scope.externalCode),
      key: String(scope.accessScopeKey),
    }))).toEqual([
      { externalCode: "117", key: "mirae-mf" },
      { externalCode: "128", key: "axis-mf" },
      { externalCode: "910", key: "mirae-sif" },
    ]);
    const enabledMutualFunds = desiredState.accessScopes.filter((scope) =>
      ["117", "128"].includes(String(scope.externalCode)));
    expect(enabledMutualFunds.every((scope) => (
      scope.sources.every((source) => source.enabled && source.schedule.enabled)
    ))).toBe(true);
    const miraeSifScope = desiredState.accessScopes.find((scope) => String(scope.externalCode) === "910");
    expect(miraeSifScope?.sources.every((source) => !source.enabled && !source.schedule.enabled)).toBe(true);
    expect(Object.isFrozen(desiredState)).toBe(true);
    expect(Object.isFrozen(desiredState.accessScopes)).toBe(true);
    expect(Object.isFrozen(desiredState.accessScopes[0]?.sources)).toBe(true);

    const miraeSif = desiredState.accessScopes.find((scope) => String(scope.externalCode) === "910");
    expect(miraeSif?.sources[0]?.discovery).toEqual({
      strategy: "mirae_sif_download_catalog",
      catalogUrl: "https://platinumsif.miraeassetmf.co.in/forms-downloads/forms",
      sections: "all",
      additionalTargets: [{
        section: "regulatory",
        subsection: "total-expense-ratio",
        endpoint: "ter",
      }],
      pageSize: 100,
      maxPages: 500,
      maxDocuments: 5_000,
      minimumDocuments: 40,
    });
    expect(miraeSif?.sources[0]?.fetch.allowedHosts).toEqual([
      "platinumsif.miraeassetmf.co.in",
      "miraeassetetf.co.in",
      "cms-dev.example.com",
    ]);
    expect(miraeSif?.sources[0]?.fetch.allowedPathPrefixes).toEqual([
      "/forms-downloads/forms",
      "/api/sif-dynamic-get",
      "/wp-content/uploads/",
    ]);

    const axisMf = desiredState.accessScopes.find((scope) => String(scope.externalCode) === "128");
    expect(axisMf?.classification).toEqual({
      knowledgeDomain: "mutual_fund",
      sourceCollection: "axis_mf",
      amcSlug: "axis",
    });
    expect(axisMf?.sources[0]?.discovery).toEqual({
      strategy: "sebi_sid_scraper",
      mfId: "3",
      maxSchemes: 100,
      maxDocuments: 100,
      minimumDocuments: 50,
    });
    expect(axisMf?.sources[0]?.fetch.allowedHosts).toEqual(["www.sebi.gov.in"]);
    expect(axisMf?.sources[0]?.fetch.allowedPathPrefixes).toEqual(["/sebi_data/", "/sebiweb/", "/web/"]);
    expect(Object.isFrozen(axisMf?.sources)).toBe(true);
  });

  test("accepts a manifest-driven Mirae SIF catalogue watcher without pinned documents", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: mirae_sif_download_catalog
      catalogUrl: https://platinumsif.miraeassetmf.co.in/forms-downloads/forms
      sections: all
      additionalTargets:
        - section: regulatory
          subsection: total-expense-ratio
          endpoint: ter
      pageSize: 100
      maxPages: 500
      maxDocuments: 5000
      minimumDocuments: 40`,
    );

    expect(parseAccessScopeManifestYaml(yaml).sources[0]?.discovery).toEqual({
      strategy: "mirae_sif_download_catalog",
      catalogUrl: "https://platinumsif.miraeassetmf.co.in/forms-downloads/forms",
      sections: "all",
      additionalTargets: [{
        section: "regulatory",
        subsection: "total-expense-ratio",
        endpoint: "ter",
      }],
      pageSize: 100,
      maxPages: 500,
      maxDocuments: 5_000,
      minimumDocuments: 40,
    });
  });

  test("accepts a bounded Mirae MF official download catalogue", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: mirae_mf_download_catalog
      catalogUrl: https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData
      moduleName: Factsheet
      fromDate: "2026-01-01"
      toDate: "2026-12-31"
      pageSize: 100
      maxPages: 5
      maxDocuments: 100
      minimumDocuments: 12`,
    );

    expect(parseAccessScopeManifestYaml(yaml).sources[0]?.discovery).toEqual({
      strategy: "mirae_mf_download_catalog",
      catalogUrl: "https://www.miraeassetmf.co.in/AjaxService/GetDownloadsData",
      moduleName: "Factsheet",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      pageSize: 100,
      maxPages: 5,
      maxDocuments: 100,
      minimumDocuments: 12,
    });
    expect(() => parseAccessScopeManifestYaml(yaml.replace("minimumDocuments: 12", "minimumDocuments: 101")))
      .toThrow(/minimumDocuments.*maxDocuments/i);
    expect(() => parseAccessScopeManifestYaml(yaml.replace("fromDate: \"2026-01-01\"", "fromDate: \"2027-01-01\"")))
      .toThrow(/fromDate.*toDate/i);
  });

  test("requires a bounded catalogue completeness guard and strict additional targets", () => {
    const watcher = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: mirae_sif_download_catalog
      catalogUrl: https://platinumsif.miraeassetmf.co.in/forms-downloads/forms
      sections: all
      additionalTargets: []
      pageSize: 100
      maxPages: 500
      maxDocuments: 50
      minimumDocuments: 40`,
    );

    expect(() => parseAccessScopeManifestYaml(watcher.replace("      minimumDocuments: 40\n", "")))
      .toThrow(/minimumDocuments/i);
    expect(() => parseAccessScopeManifestYaml(watcher.replace("minimumDocuments: 40", "minimumDocuments: 51")))
      .toThrow(/minimumDocuments.*maxDocuments/i);
    expect(() => parseAccessScopeManifestYaml(watcher.replace(
      "      additionalTargets: []",
      `      additionalTargets:
        - section: regulatory
          subsection: total-expense-ratio
          endpoint: ter
          url: https://example.com/ter`,
    ))).toThrow(/url|unrecognized/i);
  });

  test("accepts a valid sebi_sid_scraper discovery config", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: sebi_sid_scraper
      mfId: "3"
      maxSchemes: 100
      maxDocuments: 100
      minimumDocuments: 50`,
    );

    expect(parseAccessScopeManifestYaml(yaml).sources[0]?.discovery).toEqual({
      strategy: "sebi_sid_scraper",
      mfId: "3",
      maxSchemes: 100,
      maxDocuments: 100,
      minimumDocuments: 50,
    });
  });

  test("rejects a non-numeric mfId for sebi_sid_scraper", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: sebi_sid_scraper
      mfId: "abc"
      maxSchemes: 100
      maxDocuments: 100
      minimumDocuments: 50`,
    );

    expect(() => parseAccessScopeManifestYaml(yaml)).toThrow(/mfId/i);
  });

  test("rejects minimumDocuments exceeding maxDocuments for sebi_sid_scraper", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: sebi_sid_scraper
      mfId: "3"
      maxSchemes: 100
      maxDocuments: 50
      minimumDocuments: 51`,
    );

    expect(() => parseAccessScopeManifestYaml(yaml)).toThrow(/minimumDocuments.*maxDocuments/i);
  });

  test("rejects extra unknown fields on sebi_sid_scraper (strict mode)", () => {
    const yaml = validManifest().replace(
      "strategy: explicit_urls\n      urls: []",
      `strategy: sebi_sid_scraper
      mfId: "3"
      maxSchemes: 100
      maxDocuments: 100
      minimumDocuments: 50
      unknownField: oops`,
    );

    expect(() => parseAccessScopeManifestYaml(yaml)).toThrow(/unknownField|unrecognized/i);
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

  test.each(["docling", "unpdf"] as const)("accepts parse.parser: %s on a source", (parser) => {
    const yaml = validManifest().replace(
      "    review:\n      policy: risk_based\n",
      `    review:\n      policy: risk_based\n    parse:\n      parser: ${parser}\n`,
    );

    expect(parseAccessScopeManifestYaml(yaml).sources[0]?.parse).toEqual({ parser });
  });

  test("omits parse when a source has no parse block (unpdf by default)", () => {
    const source = parseAccessScopeManifestYaml(validManifest()).sources[0]!;

    expect(source.parse).toBeUndefined();
    expect(Object.hasOwn(source, "parse")).toBe(false);
  });

  test.each([
    ["an unknown parser", "parse:\n      parser: tika", /parser/i],
    ["extra parse keys", "parse:\n      parser: docling\n      ocr: true", /ocr|unrecognized/i],
    ["an empty parse block", "parse: {}", /parser/i],
  ])("rejects %s", (_name, block, expected) => {
    const yaml = validManifest().replace(
      "    review:\n      policy: risk_based\n",
      `    review:\n      policy: risk_based\n    ${block}\n`,
    );

    expect(() => parseAccessScopeManifestYaml(yaml)).toThrow(expected);
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
