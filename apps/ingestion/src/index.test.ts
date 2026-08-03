import { describe, expect, test } from "bun:test";

import {
  parseSourceUrlOption,
  parseTrustedOwnershipOptions,
} from "./cli-options.ts";

describe("parseSourceUrlOption", () => {
  test("normalizes an absolute HTTPS URL", () => {
    expect(parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "https://example.com/addendum.pdf",
    ])).toBe("https://example.com/addendum.pdf");
  });

  test("rejects missing, flag-shaped, and non-HTTP values", () => {
    expect(() => parseSourceUrlOption(["document.pdf", "--source-url"])).toThrow();
    expect(() => parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "--review-existing",
    ])).toThrow();
    expect(() => parseSourceUrlOption([
      "document.pdf",
      "--source-url",
      "/tmp/addendum.pdf",
    ])).toThrow();
  });
});

describe("parseTrustedOwnershipOptions", () => {
  const manifestArgs = [
    "--ownership-manifest-id",
    "docker-operator",
    "--ownership-manifest-version",
    "3",
  ];

  test("creates GLOBAL ownership without tenant identity", () => {
    expect(parseTrustedOwnershipOptions([
      "--visibility-scope",
      "GLOBAL",
      ...manifestArgs,
    ], {
      AMC_SCOPE: "tenant-a",
    })).toEqual({
      visibilityScope: "GLOBAL",
      tenantId: null,
      ownershipManifestId: "docker-operator",
      ownershipManifestVersion: 3,
    });
  });

  test("binds TENANT ownership to the protected AMC_SCOPE", () => {
    expect(parseTrustedOwnershipOptions([
      "--visibility-scope",
      "TENANT",
      ...manifestArgs,
    ], {
      AMC_SCOPE: "tenant-a",
    })).toEqual({
      visibilityScope: "TENANT",
      tenantId: "tenant-a",
      ownershipManifestId: "docker-operator",
      ownershipManifestVersion: 3,
    });
  });

  test("accepts trusted ownership configuration from the environment", () => {
    expect(parseTrustedOwnershipOptions([], {
      INGEST_VISIBILITY_SCOPE: "TENANT",
      OWNERSHIP_MANIFEST_ID: "docker-env",
      OWNERSHIP_MANIFEST_VERSION: "2",
      AMC_SCOPE: "tenant-b",
    })).toEqual({
      visibilityScope: "TENANT",
      tenantId: "tenant-b",
      ownershipManifestId: "docker-env",
      ownershipManifestVersion: 2,
    });
  });

  test("rejects unclassified, missing tenant scope, and invalid manifest inputs", () => {
    expect(() => parseTrustedOwnershipOptions([
      "--visibility-scope",
      "UNCLASSIFIED",
      ...manifestArgs,
    ], {})).toThrow("GLOBAL or TENANT");
    expect(() => parseTrustedOwnershipOptions([
      "--visibility-scope",
      "TENANT",
      ...manifestArgs,
    ], {})).toThrow("AMC_SCOPE");
    expect(() => parseTrustedOwnershipOptions([
      "--visibility-scope",
      "GLOBAL",
      "--ownership-manifest-id",
      "docker-operator",
      "--ownership-manifest-version",
      "0",
    ], {})).toThrow("positive");
  });
});
