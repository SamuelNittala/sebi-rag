import { describe, expect, test } from "bun:test";

import {
  isDisposableSifChunk,
  removeDisposableSifChunks,
} from "./disposable-content.ts";
import type { Chunk, ChunkResult } from "./semantic-chunker.ts";

function candidate(
  pageNumbers: number[],
  text = "Retained SIF content",
  chunkIndex = 0,
): Chunk {
  return {
    text,
    chunkIndex,
    pageNumbers,
    hasTable: false,
    sectionHeader: null,
    tokenCount: 999,
  };
}

function result(...chunks: Chunk[]): ChunkResult {
  return { chunks, totalChunks: chunks.length, totalTokens: 999 * chunks.length };
}

describe("isDisposableSifChunk", () => {
  test("drops the Platinum Hybrid KIM forms appendix", () => {
    expect(isDisposableSifChunk({
      documentFilename: "KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
      pageNumbers: [22],
      text: "Unitholder application and instructions",
    })).toBe(true);
  });

  test("keeps the core Platinum Hybrid KIM content", () => {
    expect(isDisposableSifChunk({
      documentFilename: "KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
      pageNumbers: [21],
      text: "Load Structure and investor disclosures",
    })).toBe(false);
  });

  test("drops unmistakable application forms if pagination changes", () => {
    expect(isDisposableSifChunk({
      documentFilename: "Platinum-Hybrid-Long-Short-Fund.pdf",
      pageNumbers: [40],
      text: "DISTRIBUTOR INFORMATION FOR OFFICE USE ONLY\nAPPLICANT INFORMATION TO BE FILLED IN BLOCK LETTERS",
    })).toBe(true);
  });

  test("keeps operational explanations in the SAI", () => {
    expect(isDisposableSifChunk({
      documentFilename: "SAI-SIF_March-2026.pdf",
      pageNumbers: [61],
      text: "The NACH facility is available when the investor's bank participates in the platform.",
    })).toBe(false);
  });

  test("drops every audited full-page SAI exclusion", () => {
    const excludedPages = [1, 2, 4, 5, 11, 12, 13, 20, 32, 116, 122, 127, 133, 134];

    for (const page of excludedPages) {
      expect(isDisposableSifChunk({
        documentFilename: "SAI-SIF_March-2026.pdf",
        pageNumbers: [page],
        text: "Audited disposable SAI material",
      })).toBe(true);
    }
  });

  test("keeps a chunk spanning an excluded and retained SAI page", () => {
    expect(isDisposableSifChunk({
      documentFilename: "SAI-SIF_March-2026.pdf",
      pageNumbers: [13, 14],
      text: "1. Investment and operational due diligence",
    })).toBe(false);
  });

  test("keeps service providers and removes the personnel prefix on mixed page 33", () => {
    const curated = removeDisposableSifChunks(result(candidate(
      [33],
      "Departm\nent Name Age Designation\nMr. Govind Kalra\nIII. Service providers\n1. Custodian\nDeutsche Bank AG",
    )), "SAI-SIF_March-2026.pdf");

    expect(curated.chunks).toHaveLength(1);
    expect(curated.chunks[0]!.text).toStartWith("III. Service providers");
    expect(curated.chunks[0]!.text).not.toContain("Govind Kalra");
  });

  test("removes historical associate tables but keeps restrictions and Mode of Holding", () => {
    const curated = removeDisposableSifChunks(result(candidate(
      [115, 116, 117],
      "The Investment Strategy shall not make any investment in an unlisted associate security.\nDetails of transactions with Associates:\nHistorical brokerage table\nMode of Holding\nAn application can be made by up to three applicants.",
    )), "SAI-SIF_March-2026.pdf");

    expect(curated.chunks[0]!.text).toContain("shall not make any investment");
    expect(curated.chunks[0]!.text).toContain("Mode of Holding");
    expect(curated.chunks[0]!.text).not.toContain("Historical brokerage table");
  });

  test("drops a page 116-117 historical fee chunk when Mode of Holding is not present", () => {
    const curated = removeDisposableSifChunks(result(candidate(
      [116, 117],
      "Trusteeship Fees paid to Mirae Asset Trustee Company\nInvestment Management Fees paid to the AMC",
    )), "SAI-SIF_March-2026.pdf");

    expect(curated.chunks).toHaveLength(0);
  });

  test("removes unrelated mutual-fund swing pricing text between retained SIF sections", () => {
    const curated = removeDisposableSifChunks(result(candidate(
      [130, 131],
      "Mandatory swing pricing protects existing investors.\nSwing Pricing during normal times (applicable for Mirae Asset Nifty SDL Fund)\nUnrelated scheme rules.\n3. Provisions on Creation of Segregated Portfolio/Side Pocketing\nA segregated portfolio may be created after a credit event.",
    )), "SAI-SIF_March-2026.pdf");

    expect(curated.chunks[0]!.text).toContain("Mandatory swing pricing");
    expect(curated.chunks[0]!.text).toContain("Provisions on Creation of Segregated Portfolio");
    expect(curated.chunks[0]!.text).not.toContain("Mirae Asset Nifty SDL Fund");
  });

  test("reindexes retained SAI chunks and recomputes token totals", () => {
    const curated = removeDisposableSifChunks(result(
      candidate([1], "Cover", 4),
      candidate([3], "Constitution of the Specialized Investment Fund", 9),
      candidate([35], "V. RISK FACTORS\nDerivative risk applies.", 15),
    ), "SAI-SIF_March-2026.pdf");

    expect(curated.chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
    expect(curated.chunks.every((chunk) => chunk.tokenCount < 999)).toBe(true);
    expect(curated.totalTokens).toBe(
      curated.chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
    );
  });

  test("does not apply SAI page rules to another PDF", () => {
    const untouched = removeDisposableSifChunks(
      result(candidate([20], "Strategy-specific manager assignment")),
      "ISID-Platinum-Hybrid-Long-Short-Fund.pdf",
    );

    expect(untouched.chunks).toHaveLength(1);
    expect(untouched.chunks[0]!.text).toContain("manager assignment");
  });
});
