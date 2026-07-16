import { describe, expect, test } from "bun:test";

import { resolveKnowledgeScope } from "./knowledge-scope.ts";

describe("resolveKnowledgeScope", () => {
  test("tags the Platinum SIF website as Mirae SIF", () => {
    expect(resolveKnowledgeScope({
      source: "mirae-sif",
      sourceUrl: "https://platinumsif.miraeassetmf.co.in/fund?schemeCode=3166",
    })).toEqual({
      knowledgeDomain: "sif",
      sourceCollection: "mirae_sif",
      amcSlug: "mirae-asset",
    });
  });

  test("tags SEBI SIF summaries as regulatory SIF content", () => {
    expect(resolveKnowledgeScope({
      source: "sebi-regulatory-framework",
      sourceUrl: "https://www.sebi.gov.in/sebi_data/attachdocs/feb-2025/1740659043547.pdf",
      title: "What is a Specialized Investment Fund (SIF)?",
    })).toEqual({
      knowledgeDomain: "sif",
      sourceCollection: "sebi_regulatory",
      amcSlug: null,
    });
  });

  test("tags the SEBI Mutual Funds Regulations SIF source", () => {
    expect(resolveKnowledgeScope({
      source: "sebi-mutual-funds-regulations",
      sourceUrl: "https://www.sebi.gov.in/sebi_data/attachdocs/apr-2026/1775477332137.pdf",
      title: "Specialized Investment Fund under the SEBI Mutual Funds Regulations, 2026",
    }).sourceCollection).toBe("sebi_regulatory");
  });

  test("allows an explicit trusted ingestion scope", () => {
    expect(resolveKnowledgeScope({
      source: "manual",
      sourceUrl: "https://example.com/article",
      explicitScope: {
        knowledgeDomain: "sif",
        sourceCollection: "mirae_sif",
        amcSlug: "mirae-asset",
      },
    })).toEqual({
      knowledgeDomain: "sif",
      sourceCollection: "mirae_sif",
      amcSlug: "mirae-asset",
    });
  });

  test("recognizes a Mirae Platinum SIF PDF from extracted document text", () => {
    expect(resolveKnowledgeScope({
      source: "pdf",
      sourceUrl: "/data/mirae/platinum-hybrid-kim.pdf",
      title: "Mirae Asset Mutual Fund Platinum Hybrid Long-Short Fund SIF KIM",
    })).toEqual({
      knowledgeDomain: "sif",
      sourceCollection: "mirae_sif",
      amcSlug: "mirae-asset",
    });
  });

  test("keeps unrelated content in the default corpus", () => {
    expect(resolveKnowledgeScope({
      source: "amfi-knowledge-centre",
      sourceUrl: "https://www.amfiindia.com/what-is-nav",
    })).toEqual({
      knowledgeDomain: "mutual_fund",
      sourceCollection: "default_corpus",
      amcSlug: null,
    });
  });
});
