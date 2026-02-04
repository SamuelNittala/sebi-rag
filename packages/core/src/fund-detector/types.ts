/**
 * Fund detector types for query handling.
 */

import type { QueryFilters } from "@mf-rag/types";

/** Type of match found during detection. */
export type MatchType = "exact" | "normalized" | "partial" | "amc";

/** A single fund match result. */
export interface FundMatch {
  /** Matched fund name */
  fundName: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How the match was found */
  matchType: MatchType;
}

/** Result of fund detection in a query. */
export interface DetectionResult {
  /** List of matched funds */
  matches: FundMatch[];
  /** AMC name if AMC-level match detected */
  amcFilter?: string;
  /** Suggested filter to apply */
  suggestedFilter?: QueryFilters;
  /** True if multiple high-confidence matches found */
  ambiguous: boolean;
  /** True if this is a comparison query ("compare X and Y", "X vs Y") */
  isComparisonQuery: boolean;
}

/** Configuration for fund detector. */
export interface FundDetectorConfig {
  /** Minimum confidence to consider a match (default: 0.6) */
  minConfidence: number;
  /** Confidence threshold for auto-applying filter (default: 0.8) */
  autoFilterThreshold: number;
}

/** Default fund detector configuration. */
export const DEFAULT_FUND_DETECTOR_CONFIG: FundDetectorConfig = {
  minConfidence: 0.6,
  autoFilterThreshold: 0.8,
};

/** Fund detector interface. */
export interface IFundDetector {
  /** Load/refresh fund index from data source */
  loadIndex(fundNames: string[]): void;

  /** Detect fund mentions in query */
  detect(query: string): DetectionResult;

  /** Get all known fund names */
  getFundNames(): string[];

  /** Check if index is loaded */
  isLoaded(): boolean;
}
