/**
 * Output validator for LLM responses.
 *
 * Validates that responses are:
 * 1. Grounded in the provided context (not using general knowledge)
 * 2. Not responding to jailbreak attempts
 * 3. Not generating creative/fictional content
 */

import {
  type ValidationResult,
  type ValidatorConfig,
  type IOutputValidator,
  DEFAULT_VALIDATOR_CONFIG,
} from "./types.ts";

export * from "./types.ts";

/** Patterns indicating jailbreak/fictional responses. */
const JAILBREAK_PATTERNS = [
  // Fiction framing responses
  /for (?:your|the|a) (?:story|fiction|novel|narrative)/i,
  /in (?:your|the|a) (?:story|fiction|novel|narrative)/i,
  /(?:your|the) character (?:could|can|might|would)/i,
  /here'?s (?:an?|the) (?:explanation|story|narrative)/i,
  /certainly!?\s*here'?s/i,

  // Roleplay responses
  /\*\*character:?\*\*/i,
  /speaking as (?:a|the)/i,
  /in (?:this|my) role as/i,
  /pretending to be/i,

  // Hypothetical framing
  /hypothetically speaking/i,
  /in a hypothetical scenario/i,
  /let me explain how .* would work/i,

  // Numbered lists of fraud/illegal techniques (not from docs)
  /(?:fraud|scam|illegal|hack|exploit) techniques?:/i,
  /ways to (?:commit|perform|execute) (?:fraud|scams)/i,
  /steps? to (?:hack|exploit|defraud)/i,

  // Common jailbreak success indicators
  /i'?ll help you with that/i,
  /sure,? (?:i can|let me) (?:help|explain)/i,
  /breaking (?:my|the) rules/i,
  /ignoring (?:my|the) (?:instructions|guidelines)/i,
];

/** Patterns indicating creative content generation. */
const CREATIVE_PATTERNS = [
  /once upon a time/i,
  /let me (?:write|create|compose)/i,
  /here'?s a (?:poem|story|song|joke)/i,
  /\[scene\]/i,
  /\[act \d\]/i,
  /dear diary/i,
];

/** Stop words to exclude from overlap calculation. */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare",
  "ought", "used", "to", "of", "in", "for", "on", "with", "at", "by",
  "from", "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "under", "again", "further", "then", "once", "here",
  "there", "when", "where", "why", "how", "all", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "and", "but", "if", "or",
  "because", "until", "while", "this", "that", "these", "those", "i",
  "you", "he", "she", "it", "we", "they", "what", "which", "who", "whom",
  "its", "his", "her", "their", "our", "your", "my", "me", "him", "us",
  "them", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "about", "also", "back", "been", "being", "come", "even",
  "first", "get", "go", "going", "good", "great", "know", "last", "like",
  "look", "made", "make", "much", "new", "now", "one", "over", "people",
  "said", "see", "think", "time", "two", "want", "way", "well", "work",
]);

/**
 * Output validator for LLM responses.
 */
export class OutputValidator implements IOutputValidator {
  private config: ValidatorConfig;

  constructor(config?: Partial<ValidatorConfig>) {
    this.config = { ...DEFAULT_VALIDATOR_CONFIG, ...config };
  }

  /**
   * Validate an LLM response against the provided context.
   */
  validate(response: string, context: string, query: string): ValidationResult {
    const issues: string[] = [];

    // Check for known valid refusal patterns (these are always OK)
    if (this.isValidRefusal(response)) {
      return {
        valid: true,
        groundednessScore: 1.0,
        issues: [],
      };
    }

    // Check for jailbreak patterns
    if (this.config.detectJailbreakPatterns) {
      const jailbreakIssues = this.detectJailbreakPatterns(response);
      issues.push(...jailbreakIssues);
    }

    // Check for creative content patterns
    if (this.config.detectCreativeContent) {
      const creativeIssues = this.detectCreativePatterns(response);
      issues.push(...creativeIssues);
    }

    // Calculate groundedness score
    const groundednessScore = this.calculateGroundedness(response, context);

    // Check if response seems to use knowledge not in context
    if (groundednessScore < this.config.minGroundedness) {
      issues.push(
        `Low groundedness score (${(groundednessScore * 100).toFixed(0)}%) - response may use knowledge not in context`
      );
    }

    // Determine if valid
    const valid = issues.length === 0;

    return {
      valid,
      reason: valid ? undefined : issues[0],
      groundednessScore,
      issues,
    };
  }

  /**
   * Check if response is a valid refusal/decline message.
   */
  private isValidRefusal(response: string): boolean {
    const refusalPatterns = [
      /i (?:don't|do not) have (?:this )?information/i,
      /i can only answer questions about mutual funds/i,
      /please ask a (?:factual )?question (?:about|related to)/i,
      /not (?:available|found) in the (?:provided )?(?:documents|context)/i,
      /cannot (?:find|locate) (?:this )?information/i,
    ];

    return refusalPatterns.some((pattern) => pattern.test(response));
  }

  /**
   * Detect jailbreak response patterns.
   */
  private detectJailbreakPatterns(response: string): string[] {
    const issues: string[] = [];

    for (const pattern of JAILBREAK_PATTERNS) {
      if (pattern.test(response)) {
        issues.push(`Detected jailbreak pattern: ${pattern.source}`);
        break; // One match is enough
      }
    }

    return issues;
  }

  /**
   * Detect creative content patterns.
   */
  private detectCreativePatterns(response: string): string[] {
    const issues: string[] = [];

    for (const pattern of CREATIVE_PATTERNS) {
      if (pattern.test(response)) {
        issues.push(`Detected creative content pattern: ${pattern.source}`);
        break;
      }
    }

    return issues;
  }

  /**
   * Calculate groundedness score based on word overlap.
   *
   * Higher score = more words in response appear in context.
   */
  private calculateGroundedness(response: string, context: string): number {
    const responseWords = this.extractSignificantWords(response);
    const contextWords = new Set(this.extractSignificantWords(context));

    if (responseWords.length === 0) {
      return 1.0; // Empty response is technically grounded
    }

    let matchCount = 0;
    for (const word of responseWords) {
      if (contextWords.has(word)) {
        matchCount++;
      }
    }

    return matchCount / responseWords.length;
  }

  /**
   * Extract significant words (excluding stop words, short words).
   */
  private extractSignificantWords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
  }
}

/** Default rejection message. */
export const REJECTION_MESSAGE =
  "I can only answer questions about mutual funds using the provided documents. Please ask a factual question about mutual fund schemes.";
