/**
 * Prompt builder module for RAG pipeline.
 *
 * Responsible for:
 * - Constructing system prompts for financial domain
 * - Formatting user queries with context
 * - Building message arrays for LLM
 */

import type { LLMMessage } from "../llm/types.ts";
import type { AssembledContext } from "../context/types.ts";
import {
  type PromptConfig,
  type IPromptBuilder,
  DEFAULT_PROMPT_CONFIG,
} from "./types.ts";

// Export types and constants
export * from "./types.ts";

// Placeholder constant for workspace resolution
export const PROMPT_VERSION = "0.1.0";

/**
 * Builds LLM message arrays from query and assembled context.
 *
 * Responsible for:
 * - Inserting formatted context into system prompt
 * - Inserting query into user prompt
 * - Building properly ordered message array for LLM
 */
export class PromptBuilder implements IPromptBuilder {
  private readonly config: PromptConfig;

  /**
   * Create a new PromptBuilder.
   *
   * @param config - Optional partial prompt configuration to override defaults
   */
  constructor(config?: Partial<PromptConfig>) {
    this.config = {
      ...DEFAULT_PROMPT_CONFIG,
      ...config,
    };
  }

  /**
   * Build LLM messages from query and context.
   *
   * @param query - User's question
   * @param context - Assembled context with formatted chunks
   * @returns Array of LLM messages ready for generation
   */
  build(query: string, context: AssembledContext): LLMMessage[] {
    const systemContent = this.config.systemTemplate.replace(
      "{context}",
      context.formattedContext
    );

    const userContent = this.config.userTemplate.replace("{query}", query);

    return [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ];
  }
}
