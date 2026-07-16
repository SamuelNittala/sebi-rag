import { describe, expect, test } from "bun:test";

import { isDisposableSifChunk } from "./disposable-content.ts";

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
});
