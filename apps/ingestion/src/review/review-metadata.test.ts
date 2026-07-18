import { describe, expect, test } from "bun:test";

import {
  classifyDocumentScope,
  classifySection,
  strategyIdForScope,
} from "./review-metadata.ts";

describe("review metadata classification", () => {
  test("classifies a Mirae SIF SAI as SIF-wide rather than strategy-specific", () => {
    expect(classifyDocumentScope({
      filename: "SAI-SIF_March-2026.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: "SAI SIF",
    })).toBe("sif_umbrella");
  });

  test("classifies the product ISID as strategy-specific", () => {
    expect(classifyDocumentScope({
      filename: "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: "Platinum Hybrid Long Short Fund",
    })).toBe("strategy");
  });

  test("classifies the product FAQ as strategy-specific", () => {
    expect(classifyDocumentScope({
      filename: "Mirae-SIF-Platinum-FAQ.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: null,
    })).toBe("strategy");
  });

  test("classifies the Four Pager and One Pager as strategy-specific", () => {
    expect(classifyDocumentScope({
      filename: "Platinum-Hybrid-Long-Short-Fund-Four-Pager-1.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: null,
    })).toBe("strategy");
    expect(classifyDocumentScope({
      filename: "Platinum-Hybrid-Long-Short-FUND-One-Pager-1.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: null,
    })).toBe("strategy");
    expect(classifyDocumentScope({
      filename: "Platinum Four Pager.pdf",
      documentType: "Unknown",
      sourceCollection: "mirae_sif",
      fundName: null,
    })).toBe("strategy");
  });

  test("classifies SEBI SIF sources as regulatory", () => {
    expect(classifyDocumentScope({
      filename: "sif-regulations.pdf",
      documentType: "Unknown",
      sourceCollection: "sebi_regulatory",
      fundName: null,
    })).toBe("regulatory");
  });

  test("identifies a strategy fund-manager assignment section", () => {
    expect(classifySection("E. WHO MANAGES THE INVESTMENT STRATEGY?", "strategy"))
      .toEqual({ sectionType: "strategy_management", factType: "fund_manager" });
  });

  test("identifies a generic AMC staff directory", () => {
    expect(classifySection("Fund Manager", "amc"))
      .toEqual({ sectionType: "staff_directory", factType: null });
  });

  test("does not assign a strategy ID to SIF-wide SAI content", () => {
    expect(strategyIdForScope("sif_umbrella", "Platinum SIF")).toBeNull();
    expect(strategyIdForScope("strategy", "Platinum Hybrid Long Short Fund"))
      .toBe("platinum-hybrid-long-short-fund");
  });
});
