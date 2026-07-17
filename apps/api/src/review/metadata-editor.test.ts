import { describe, expect, test } from "bun:test";

import { prepareMetadataEdit } from "./metadata-editor.ts";

const current = {
  documentScope: "strategy" as const,
  sourceChunkId: "source-chunk",
  strategyId: "platinum-hybrid-long-short-fund",
  canonicalStrategyName: "Platinum Hybrid Long-Short Fund",
  sourceAuthority: "regulatory_filing" as const,
  sectionType: "unknown",
  factType: null,
  confidence: 0.5,
  classificationSource: "document_manifest" as const,
  evidence: ["No recognized fact evidence"],
};

describe("metadata review editing", () => {
  test("preserves source identity and records human-reviewed values", () => {
    expect(prepareMetadataEdit(current, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "investment_objective",
      factType: "investment_objective",
      note: "Verified the Investment Objective heading on page 6.",
    })).toEqual({
      ...current,
      sectionType: "investment_objective",
      factType: "investment_objective",
      confidence: 1,
      classificationSource: "human",
      evidence: ["Verified the Investment Objective heading on page 6."],
    });
  });

  test("rejects values outside the controlled vocabulary", () => {
    expect(() => prepareMetadataEdit(current, {
      documentScope: "strategy",
      strategyId: "platinum-hybrid-long-short-fund",
      sectionType: "made_up",
      factType: "investment_objective",
      note: "Checked source.",
    })).toThrow("Invalid section type");
  });

  test("requires the controlled strategy identity for strategy-scoped chunks", () => {
    expect(() => prepareMetadataEdit(current, {
      documentScope: "strategy",
      strategyId: "",
      sectionType: "investment_objective",
      factType: "investment_objective",
      note: "Checked source.",
    })).toThrow("Strategy-scoped metadata requires a known strategy ID");
  });

  test("clears strategy identity when a chunk is reviewed as umbrella scope", () => {
    expect(prepareMetadataEdit(current, {
      documentScope: "sif_umbrella",
      strategyId: "",
      sectionType: "staff_directory",
      factType: "",
      note: "Verified this is a generic SIF staff directory.",
    })).toMatchObject({
      documentScope: "sif_umbrella",
      strategyId: null,
      canonicalStrategyName: null,
    });
  });
});
