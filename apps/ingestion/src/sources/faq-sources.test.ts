import { describe, expect, test } from "bun:test";

import {
  FAQ_SOURCE_MANIFEST,
  getFaqSource,
  validateFaqSource,
} from "./faq-sources.ts";

describe("curated FAQ source manifest", () => {
  test("pins both official global mutual-fund FAQ PDFs", () => {
    expect(FAQ_SOURCE_MANIFEST.map((source) => source.id)).toEqual([
      "sebi-mutual-fund-investor-faq",
      "nism-mutual-fund-faq",
    ]);

    for (const source of FAQ_SOURCE_MANIFEST) {
      expect(source.canonicalUrl).toMatch(/^https:\/\/(www\.)?(sebi\.gov\.in|nism\.ac\.in)\//);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.knowledgeDomain).toBe("mutual_fund");
      expect(source.sourceCollection).toBe("general_mf_faq");
      expect(source.ownership).toEqual({
        visibilityScope: "GLOBAL",
        tenantId: null,
        ownershipManifestId: "curated-global-faq",
        ownershipManifestVersion: 1,
      });
    }

    expect(JSON.stringify(FAQ_SOURCE_MANIFEST).toLowerCase()).not.toContain("amfi");
  });

  test("fails closed for missing metadata and unsupported profiles", () => {
    const source = getFaqSource("sebi-mutual-fund-investor-faq");
    expect(() => validateFaqSource({ ...source, title: "" })).toThrow(/title/i);
    expect(() =>
      validateFaqSource({ ...source, parserProfile: "generic-pdf" as never })
    ).toThrow(/profile/i);
    expect(() => getFaqSource("not-in-manifest")).toThrow(/not found/i);
  });
});
