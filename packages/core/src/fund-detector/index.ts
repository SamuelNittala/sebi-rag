/**
 * Fund detector module for query handling.
 *
 * Detects fund names mentioned in user queries and suggests filters.
 */

import type { QueryFilters } from "@mf-rag/types";
import {
  type FundMatch,
  type DetectionResult,
  type FundDetectorConfig,
  type IFundDetector,
  DEFAULT_FUND_DETECTOR_CONFIG,
} from "./types.ts";

export * from "./types.ts";

/** Indexed fund entry for matching. */
interface IndexedFund {
  original: string;
  normalized: string;
  tokens: string[];
  amc: string;
}

/**
 * Detects fund names in user queries.
 *
 * Supports:
 * - Exact matches
 * - Case-insensitive matches
 * - Partial matches (without "Fund" suffix)
 * - AMC-level detection
 */
export class FundDetector implements IFundDetector {
  private config: FundDetectorConfig;
  private index: IndexedFund[] = [];
  private loaded = false;

  constructor(config?: Partial<FundDetectorConfig>) {
    this.config = { ...DEFAULT_FUND_DETECTOR_CONFIG, ...config };
  }

  /**
   * Load fund names into the index.
   */
  loadIndex(fundNames: string[]): void {
    const uniqueNames = [...new Set(fundNames)];
    this.index = uniqueNames.map((name) => this.indexFund(name));
    this.loaded = true;
  }

  /**
   * Create indexed entry for a fund.
   */
  private indexFund(name: string): IndexedFund {
    const normalized = this.normalize(name);
    const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);
    const amc = this.extractAmc(name);

    return { original: name, normalized, tokens, amc };
  }

  /**
   * Normalize text for matching.
   */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Extract AMC name from fund name.
   */
  private extractAmc(fundName: string): string {
    // Common AMC patterns - extract first word or known prefix
    const knownAmcs = [
      "HDFC", "SBI", "ICICI", "Axis", "Kotak", "Nippon", "DSP",
      "Aditya Birla", "Tata", "UTI", "Franklin", "Invesco", "Mirae",
      "Parag Parikh", "PGIM", "Sundaram", "Canara Robeco", "BOI",
      "360 ONE", "Deutsche", "JM", "Old Bridge", "quant", "Samco",
      "Edelweiss", "Baroda", "HSBC", "LIC", "Union", "Shriram",
    ];

    for (const amc of knownAmcs) {
      if (fundName.toLowerCase().startsWith(amc.toLowerCase())) {
        return amc;
      }
    }

    // Default: first word
    const firstWord = fundName.split(/\s+/)[0];
    return firstWord;
  }

  /**
   * Detect fund mentions in query.
   */
  detect(query: string): DetectionResult {
    if (!query || query.trim() === "") {
      return { matches: [], ambiguous: false, isComparisonQuery: false };
    }

    const normalizedQuery = this.normalize(query);
    const matches: FundMatch[] = [];

    // Check for comparison query patterns
    const isComparisonQuery = this.detectComparisonQuery(query);

    // Check for AMC-level queries
    const amcFilter = this.detectAmcQuery(query, normalizedQuery);

    // Check each fund for matches
    for (const fund of this.index) {
      const match = this.matchFund(fund, normalizedQuery, query);
      if (match && match.confidence >= this.config.minConfidence) {
        matches.push(match);
      }
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence);

    // Determine if ambiguous (multiple high-confidence matches)
    const highConfidenceMatches = matches.filter(
      (m) => m.confidence >= this.config.autoFilterThreshold
    );
    const ambiguous = highConfidenceMatches.length > 1;

    // Suggest filter if single high-confidence match
    let suggestedFilter: QueryFilters | undefined;
    if (highConfidenceMatches.length === 1 && !amcFilter) {
      suggestedFilter = { fundName: highConfidenceMatches[0].fundName };
    }

    return {
      matches,
      amcFilter,
      suggestedFilter,
      ambiguous,
      isComparisonQuery,
    };
  }

  /**
   * Check if query is a comparison query.
   * Patterns: "compare X and Y", "X vs Y", "difference between X and Y"
   */
  private detectComparisonQuery(query: string): boolean {
    const comparisonPatterns = [
      /\bcompare\b/i,
      /\bvs\.?\b/i,
      /\bversus\b/i,
      /\bdifference\s+between\b/i,
      /\bcomparing\b/i,
      /\bcomparison\s+(?:of|between)\b/i,
    ];

    return comparisonPatterns.some((pattern) => pattern.test(query));
  }

  /**
   * Check if query is asking about an AMC's funds.
   */
  private detectAmcQuery(query: string, normalizedQuery: string): string | undefined {
    // Patterns like "HDFC funds", "SBI schemes", "all Axis funds"
    const amcPatterns = [
      /(?:all\s+)?(\w+)\s+(?:funds?|schemes?|mutual\s+funds?)/i,
      /(?:compare|show|list)\s+(?:all\s+)?(\w+)\s+(?:funds?|schemes?)/i,
    ];

    for (const pattern of amcPatterns) {
      const match = query.match(pattern);
      if (match) {
        const potentialAmc = match[1];
        // Verify it's a known AMC
        const isKnownAmc = this.index.some(
          (f) => f.amc.toLowerCase() === potentialAmc.toLowerCase()
        );
        if (isKnownAmc) {
          // But not if a specific fund is also mentioned
          const hasSpecificFund = this.index.some(
            (f) => normalizedQuery.includes(f.normalized)
          );
          if (!hasSpecificFund) {
            return potentialAmc.toUpperCase();
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Match a fund against the query.
   */
  private matchFund(
    fund: IndexedFund,
    normalizedQuery: string,
    originalQuery: string
  ): FundMatch | null {
    // Exact match (case-insensitive)
    if (normalizedQuery.includes(fund.normalized)) {
      return {
        fundName: fund.original,
        confidence: 1.0,
        matchType: originalQuery.includes(fund.original) ? "exact" : "normalized",
      };
    }

    // Match without "fund" suffix
    const withoutFund = fund.normalized.replace(/\s+fund$/, "");
    if (withoutFund.length > 5 && normalizedQuery.includes(withoutFund)) {
      return {
        fundName: fund.original,
        confidence: 0.85,
        matchType: "partial",
      };
    }

    // Match significant tokens (at least 2 consecutive tokens)
    const matchScore = this.tokenMatchScore(fund.tokens, normalizedQuery);
    if (matchScore >= 0.6) {
      return {
        fundName: fund.original,
        confidence: matchScore * 0.9,
        matchType: "partial",
      };
    }

    return null;
  }

  /**
   * Calculate token match score.
   */
  private tokenMatchScore(fundTokens: string[], query: string): number {
    // Filter out common words
    const stopWords = new Set([
      "fund", "scheme", "mutual", "the", "a", "an", "of", "and", "or",
      "for", "in", "on", "at", "to", "is", "are", "was", "were",
    ]);

    const significantTokens = fundTokens.filter(
      (t) => !stopWords.has(t) && t.length > 2
    );

    if (significantTokens.length === 0) return 0;

    let matchedCount = 0;
    for (const token of significantTokens) {
      // Check for word boundary match to avoid partial word matches
      const pattern = new RegExp(`\\b${this.escapeRegex(token)}\\b`, "i");
      if (pattern.test(query)) {
        matchedCount++;
      }
    }

    return matchedCount / significantTokens.length;
  }

  /**
   * Escape regex special characters.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Get all known fund names.
   */
  getFundNames(): string[] {
    return this.index.map((f) => f.original);
  }

  /**
   * Check if index is loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }
}
