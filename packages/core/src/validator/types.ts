/**
 * Output validator types.
 *
 * Validates LLM responses to ensure they are grounded in the provided context
 * and don't contain off-topic or jailbreak content.
 */

/** Validation result. */
export interface ValidationResult {
  /** Whether the response passed validation */
  valid: boolean;
  /** Reason for rejection if invalid */
  reason?: string;
  /** Confidence score (0-1) for groundedness */
  groundednessScore: number;
  /** Detected issues */
  issues: string[];
}

/** Validator configuration. */
export interface ValidatorConfig {
  /** Minimum groundedness score to pass (default: 0.3) */
  minGroundedness: number;
  /** Enable jailbreak pattern detection (default: true) */
  detectJailbreakPatterns: boolean;
  /** Enable creative content detection (default: true) */
  detectCreativeContent: boolean;
  /** Minimum word overlap ratio (default: 0.2) */
  minWordOverlap: number;
}

/** Default validator configuration. */
export const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  minGroundedness: 0.3,
  detectJailbreakPatterns: true,
  detectCreativeContent: true,
  minWordOverlap: 0.2,
};

/** Validator interface. */
export interface IOutputValidator {
  /**
   * Validate an LLM response against the provided context.
   *
   * @param response - LLM response text
   * @param context - Original context provided to LLM
   * @param query - Original user query
   * @returns Validation result
   */
  validate(response: string, context: string, query: string): ValidationResult;
}
