/**
 * FundDetector tests.
 *
 * Tests fund name detection in user queries.
 * RED phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { FundDetector } from "./index.ts";

// Sample fund names from actual data
const SAMPLE_FUNDS = [
  "HDFC Focused 30 Fund",
  "Axis Value Fund",
  "SBI Bluechip Fund",
  "360 ONE Dynamic Bond Fund",
  "quant Quantamental Fund",
  "Deutsche Mutual Fund - Equity",
  "JM Small Cap Fund",
  "Old Bridge Focused Equity Fund",
  "Parag Parikh Flexi Cap Fund",
  "PGIM India Equity Savings Fund",
];

describe("FundDetector", () => {
  let detector: FundDetector;

  beforeEach(() => {
    detector = new FundDetector();
    detector.loadIndex(SAMPLE_FUNDS);
  });

  describe("loadIndex", () => {
    it("should load fund names into index", () => {
      expect(detector.isLoaded()).toBe(true);
      expect(detector.getFundNames()).toHaveLength(SAMPLE_FUNDS.length);
    });

    it("should handle empty fund list", () => {
      const emptyDetector = new FundDetector();
      emptyDetector.loadIndex([]);
      expect(emptyDetector.isLoaded()).toBe(true);
      expect(emptyDetector.getFundNames()).toHaveLength(0);
    });

    it("should deduplicate fund names", () => {
      const duplicateDetector = new FundDetector();
      duplicateDetector.loadIndex(["Fund A", "Fund A", "Fund B"]);
      expect(duplicateDetector.getFundNames()).toHaveLength(2);
    });
  });

  describe("detect - exact matches", () => {
    it("should detect exact fund name in query", () => {
      const result = detector.detect(
        "What is the expense ratio of HDFC Focused 30 Fund?"
      );

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("HDFC Focused 30 Fund");
      expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.matches[0].matchType).toBe("exact");
      expect(result.ambiguous).toBe(false);
    });

    it("should detect fund name at start of query", () => {
      const result = detector.detect("Axis Value Fund performance history");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("Axis Value Fund");
    });

    it("should detect fund name at end of query", () => {
      const result = detector.detect("Tell me about SBI Bluechip Fund");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("SBI Bluechip Fund");
    });
  });

  describe("detect - normalized matches", () => {
    it("should match case-insensitive", () => {
      const result = detector.detect("what about hdfc focused 30 fund?");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("HDFC Focused 30 Fund");
      expect(result.matches[0].matchType).toBe("normalized");
    });

    it("should match without 'Fund' suffix", () => {
      const result = detector.detect("Tell me about Axis Value");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("Axis Value Fund");
      expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("should match partial fund name", () => {
      const result = detector.detect("How is HDFC Focused performing?");

      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches[0].fundName).toBe("HDFC Focused 30 Fund");
    });
  });

  describe("detect - AMC filtering", () => {
    it("should detect AMC-level query", () => {
      const result = detector.detect("Compare all HDFC funds");

      expect(result.amcFilter).toBe("HDFC");
    });

    it("should detect AMC with 'schemes' keyword", () => {
      const result = detector.detect("Show me SBI schemes");

      expect(result.amcFilter).toBe("SBI");
    });

    it("should not set AMC filter for specific fund", () => {
      const result = detector.detect("HDFC Focused 30 Fund expense ratio");

      // Should match specific fund, not AMC
      expect(result.matches[0].fundName).toBe("HDFC Focused 30 Fund");
      expect(result.amcFilter).toBeUndefined();
    });
  });

  describe("detect - no matches", () => {
    it("should return empty for generic queries", () => {
      const result = detector.detect("What are mutual fund risk factors?");

      expect(result.matches).toHaveLength(0);
      expect(result.suggestedFilter).toBeUndefined();
      expect(result.ambiguous).toBe(false);
    });

    it("should not match common words", () => {
      const result = detector.detect("What is the value of my investment?");

      // Should not match "Axis Value Fund" just because "value" appears
      expect(result.matches).toHaveLength(0);
    });

    it("should handle empty query", () => {
      const result = detector.detect("");

      expect(result.matches).toHaveLength(0);
    });
  });

  describe("detect - multiple funds", () => {
    it("should detect multiple funds in comparison query", () => {
      const result = detector.detect(
        "Compare HDFC Focused 30 Fund and Axis Value Fund"
      );

      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      const fundNames = result.matches.map((m) => m.fundName);
      expect(fundNames).toContain("HDFC Focused 30 Fund");
      expect(fundNames).toContain("Axis Value Fund");
      expect(result.ambiguous).toBe(true);
    });
  });

  describe("suggestedFilter", () => {
    it("should suggest filter for high-confidence single match", () => {
      const result = detector.detect("HDFC Focused 30 Fund expense ratio");

      expect(result.suggestedFilter).toBeDefined();
      expect(result.suggestedFilter?.fundName).toBe("HDFC Focused 30 Fund");
    });

    it("should not suggest filter for low-confidence match", () => {
      const result = detector.detect("Some fund");

      expect(result.suggestedFilter).toBeUndefined();
    });

    it("should not suggest filter for ambiguous matches", () => {
      const result = detector.detect("Compare HDFC and Axis funds");

      // Multiple matches = no single filter suggestion
      expect(result.suggestedFilter).toBeUndefined();
    });
  });

  describe("detect - comparison queries", () => {
    it("should detect 'compare X and Y' as comparison query", () => {
      const result = detector.detect(
        "Compare HDFC Focused 30 Fund and Axis Value Fund"
      );

      expect(result.isComparisonQuery).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
    });

    it("should detect 'X vs Y' as comparison query", () => {
      const result = detector.detect(
        "HDFC Focused 30 Fund vs Axis Value Fund expense ratio"
      );

      expect(result.isComparisonQuery).toBe(true);
    });

    it("should detect 'X versus Y' as comparison query", () => {
      const result = detector.detect(
        "HDFC Focused 30 Fund versus SBI Bluechip Fund"
      );

      expect(result.isComparisonQuery).toBe(true);
    });

    it("should detect 'difference between X and Y' as comparison query", () => {
      const result = detector.detect(
        "What is the difference between HDFC Focused and Axis Value?"
      );

      expect(result.isComparisonQuery).toBe(true);
    });

    it("should detect 'comparison of X and Y' as comparison query", () => {
      const result = detector.detect(
        "Show me a comparison of SBI Bluechip and HDFC Focused funds"
      );

      expect(result.isComparisonQuery).toBe(true);
    });

    it("should not detect non-comparison queries", () => {
      const result = detector.detect(
        "What is the expense ratio of HDFC Focused 30 Fund?"
      );

      expect(result.isComparisonQuery).toBe(false);
    });

    it("should mark comparison with multiple funds as ambiguous", () => {
      const result = detector.detect(
        "Compare HDFC Focused 30 Fund and Axis Value Fund"
      );

      expect(result.isComparisonQuery).toBe(true);
      expect(result.ambiguous).toBe(true);
      // Should NOT suggest a single filter for comparisons
      expect(result.suggestedFilter).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("should handle fund names with special characters", () => {
      const result = detector.detect(
        "Tell me about 360 ONE Dynamic Bond Fund"
      );

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("360 ONE Dynamic Bond Fund");
    });

    it("should handle fund names with hyphens", () => {
      const result = detector.detect("Deutsche Mutual Fund - Equity details");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("Deutsche Mutual Fund - Equity");
    });

    it("should handle lowercase AMC in query", () => {
      const result = detector.detect("quant Quantamental Fund returns");

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].fundName).toBe("quant Quantamental Fund");
    });
  });
});
