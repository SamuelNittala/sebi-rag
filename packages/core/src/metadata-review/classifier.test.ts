import { describe, expect, test } from "bun:test";

import {
  prepareMiraeSifMetadataReview,
  resolveMiraeSifDocumentIdentity,
} from "./classifier.ts";

const documentId = "10000000-0000-4000-8000-000000000001";

describe("Mirae SIF metadata classification", () => {
  test("assigns the stable Platinum strategy ID to the ISID", () => {
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "pdf",
      sourceDocumentId: documentId,
      sourceName: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
      sourceLocation: "/data/ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
    })).toEqual({
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      canonicalStrategyName: "Platinum Hybrid Long-Short Fund",
      sourceAuthority: "regulatory_filing",
    });
  });

  test("classifies the Four-Pager and One-Pager as Platinum marketing collateral", () => {
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "pdf",
      sourceDocumentId: documentId,
      sourceName: "Platinum-Hybrid-Long-Short-Fund-Four-Pager-1.pdf",
      sourceLocation: "/data/Platinum-Hybrid-Long-Short-Fund-Four-Pager-1.pdf",
    })).toMatchObject({ documentScope: "strategy", sourceAuthority: "marketing" });
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "pdf",
      sourceDocumentId: documentId,
      sourceName: "Platinum-Hybrid-Long-Short-FUND-One-Pager-1.pdf",
      sourceLocation: "/data/Platinum-Hybrid-Long-Short-FUND-One-Pager-1.pdf",
    })).toMatchObject({ documentScope: "strategy", sourceAuthority: "marketing" });
  });

  test("classifies SEBI-hosted pages as regulatory without a strategy ID", () => {
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "html",
      sourceDocumentId: documentId,
      sourceName: "What is a Specialized Investment Fund (SIF)?",
      sourceLocation: "https://www.sebi.gov.in/sebi_data/attachdocs/feb-2025/12345.html",
    })).toEqual({
      documentScope: "regulatory",
      strategyId: null,
      canonicalStrategyName: null,
      sourceAuthority: "regulatory_filing",
    });
  });

  test("leaves education blogs at unknown scope", () => {
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "html",
      sourceDocumentId: documentId,
      sourceName: "SIFs Decoded: Strategy, Structure and Discipline",
      sourceLocation: "https://platinumsif.miraeassetmf.co.in/knowledge-center/blogs/sifs-decoded-strategy-structure-and-discipline",
    })).toMatchObject({ documentScope: "unknown", strategyId: null });
  });

  test("keeps the SAI at umbrella scope without a default strategy", () => {
    expect(resolveMiraeSifDocumentIdentity({
      sourceType: "pdf",
      sourceDocumentId: documentId,
      sourceName: "SAI-SIF_March-2026.pdf",
      sourceLocation: "/data/SAI-SIF_March-2026.pdf",
    })).toMatchObject({ documentScope: "sif_umbrella", strategyId: null });
  });

  test("classifies an exact Investment Objective heading with high confidence", () => {
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "html",
        sourceDocumentId: documentId,
        sourceName: "Platinum Hybrid Long-Short Fund",
        sourceLocation: "https://platinumsif.miraeassetmf.co.in/fund?schemeCode=3166",
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000001",
        chunkIndex: 9,
        text: "The Investment Strategy shall seek to generate regular income.",
        pageNumbers: [],
        hasTable: false,
        sectionHeader: "Investment Objective",
      }],
    });

    expect(prepared.candidates[0]?.metadata).toMatchObject({
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "investment_objective",
      factType: "investment_objective",
      confidence: 1,
      classificationSource: "exact_heading",
    });
    expect(prepared.findings).toEqual([]);
  });

  test("classifies a Roman-numbered redemption frequency heading as redemption", () => {
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000007",
        chunkIndex: 52,
        text: "IX. Redemption\nfrequency\n2 times in a week (Monday & Thursday).",
        pageNumbers: [6],
        hasTable: false,
        sectionHeader: "IX. Redemption",
      }],
    });

    expect(prepared.candidates[0]?.metadata).toMatchObject({
      sectionType: "redemption",
      factType: "redemption",
      confidence: 1,
      classificationSource: "exact_heading",
    });
    expect(prepared.findings).toEqual([]);
  });

  test("distinguishes a strategy manager assignment from an SAI staff directory", () => {
    const strategy = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000002",
        chunkIndex: 20,
        text: "E. WHO MANAGES THE INVESTMENT STRATEGY? Mr. Gaurik Shah",
        pageNumbers: [22],
        hasTable: false,
        sectionHeader: "E. WHO MANAGES THE INVESTMENT STRATEGY?",
      }],
    });
    const umbrella = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "SAI-SIF_March-2026.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000003",
        chunkIndex: 80,
        text: "Fund Manager MBA Finance experience and background",
        pageNumbers: [28],
        hasTable: false,
        sectionHeader: "Fund Manager",
      }],
    });

    expect(strategy.candidates[0]?.metadata).toMatchObject({
      sectionType: "strategy_management",
      factType: "fund_manager",
    });
    expect(strategy.findings).toEqual([]);
    expect(umbrella.candidates[0]?.metadata).toMatchObject({
      sectionType: "staff_directory",
      factType: null,
      strategyId: null,
    });
  });

  test("does not promote body-only SAI staff text to strategy management", () => {
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "SAI-SIF_March-2026.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000005",
        chunkIndex: 81,
        text: "Fund Manager Mr. Akshay Udeshi has experience in financial services.",
        pageNumbers: [29],
        hasTable: false,
        sectionHeader: null,
      }],
    });

    expect(prepared.candidates[0]?.metadata).toMatchObject({
      documentScope: "sif_umbrella",
      strategyId: null,
      sectionType: "staff_directory",
      factType: null,
    });
  });

  test("flags strong body-only fact evidence for human review", () => {
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000004",
        chunkIndex: 5,
        text: "The investment objective is to generate regular income through derivative strategies.",
        pageNumbers: [6],
        hasTable: false,
        sectionHeader: null,
      }],
    });

    expect(prepared.candidates[0]?.metadata).toMatchObject({
      sectionType: "investment_objective",
      confidence: 0.7,
      classificationSource: "body_evidence",
    });
    expect(prepared.findings[0]).toMatchObject({
      ruleCode: "METADATA_BODY_ONLY_FACT",
      severity: "warning",
      blocksApproval: false,
    });
  });

  test("blocks an unknown Mirae SIF document for manifest review", () => {
    const prepared = prepareMiraeSifMetadataReview({
      document: {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: "Unknown-Mirae-SIF-Document.pdf",
        sourceLocation: null,
      },
      chunks: [{
        id: "20000000-0000-4000-8000-000000000006",
        chunkIndex: 0,
        text: "Unrecognized Mirae SIF source",
        pageNumbers: [1],
        hasTable: false,
        sectionHeader: null,
      }],
    });

    expect(prepared.candidates[0]?.metadata).toMatchObject({
      documentScope: "unknown",
      strategyId: null,
      sourceAuthority: "unknown",
    });
    expect(prepared.findings[0]).toMatchObject({
      ruleCode: "METADATA_UNKNOWN_DOCUMENT",
      blocksApproval: true,
    });
  });
});
