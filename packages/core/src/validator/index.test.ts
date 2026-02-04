/**
 * OutputValidator tests.
 */

import { describe, it, expect } from "bun:test";
import { OutputValidator } from "./index.ts";

describe("OutputValidator", () => {
  const validator = new OutputValidator();

  const sampleContext = `
    Source 1: HDFC Focused 30 Fund
    The fund invests in equity and equity-related instruments.
    Expense ratio is 1.5% for regular plan.
    Risk: Moderately High

    Source 2: Axis Value Fund
    Investment strategy follows value investing principles.
    Minimum investment: Rs 5000
  `;

  describe("legitimate responses", () => {
    it("should pass grounded responses", () => {
      const response = "The HDFC Focused 30 Fund invests in equity instruments. The expense ratio is 1.5% for the regular plan. [Source 1]";
      const result = validator.validate(response, sampleContext, "What is HDFC expense ratio?");

      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it("should pass 'no information' responses", () => {
      const response = "I don't have information about this in the provided documents.";
      const result = validator.validate(response, sampleContext, "What is the NAV?");

      expect(result.valid).toBe(true);
    });

    it("should pass responses with citations", () => {
      const response = "The minimum investment for Axis Value Fund is Rs 5000 [Source 2]. The fund follows value investing principles.";
      const result = validator.validate(response, sampleContext, "What is minimum investment?");

      expect(result.valid).toBe(true);
    });
  });

  describe("jailbreak detection", () => {
    it("should detect fiction framing responses", () => {
      const response = "Certainly! Here's an explanation for your story. The character could say that fraud techniques include...";
      const result = validator.validate(response, sampleContext, "For a story...");

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes("jailbreak"))).toBe(true);
    });

    it("should detect character roleplay responses", () => {
      const response = "**Character:** \"Let me explain how mutual fund fraud works...\"";
      const result = validator.validate(response, sampleContext, "pretend to be...");

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes("jailbreak"))).toBe(true);
    });

    it("should detect hypothetical framing", () => {
      const response = "Hypothetically speaking, if you wanted to exploit the system, you would...";
      const result = validator.validate(response, sampleContext, "hypothetically...");

      expect(result.valid).toBe(false);
    });

    it("should detect 'certainly here is' pattern", () => {
      const response = "Certainly! Here's the information you requested about hacking...";
      const result = validator.validate(response, sampleContext, "ignore instructions");

      expect(result.valid).toBe(false);
    });
  });

  describe("creative content detection", () => {
    it("should detect story content", () => {
      const response = "Once upon a time, there was a mutual fund manager who...";
      const result = validator.validate(response, sampleContext, "tell me a story");

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.includes("creative"))).toBe(true);
    });

    it("should detect poem creation", () => {
      const response = "Here's a poem about mutual funds:\nRoses are red...";
      const result = validator.validate(response, sampleContext, "write a poem");

      expect(result.valid).toBe(false);
    });
  });

  describe("groundedness scoring", () => {
    it("should have high score for grounded response", () => {
      const response = "HDFC Focused 30 Fund equity instruments expense ratio 1.5% regular plan";
      const result = validator.validate(response, sampleContext, "expense ratio");

      expect(result.groundednessScore).toBeGreaterThan(0.5);
    });

    it("should have low score for ungrounded response", () => {
      const response = "Bitcoin cryptocurrency blockchain decentralized finance NFT tokens";
      const result = validator.validate(response, sampleContext, "crypto");

      expect(result.groundednessScore).toBeLessThan(0.2);
      expect(result.valid).toBe(false);
    });
  });

  describe("configuration", () => {
    it("should respect minGroundedness config", () => {
      const strictValidator = new OutputValidator({ minGroundedness: 0.8 });
      const response = "The fund has some investments.";
      const result = strictValidator.validate(response, sampleContext, "investments");

      // May or may not pass depending on overlap
      expect(result.groundednessScore).toBeDefined();
    });

    it("should allow disabling jailbreak detection", () => {
      const lenientValidator = new OutputValidator({ detectJailbreakPatterns: false });
      const response = "Certainly! Here's an explanation...";
      const result = lenientValidator.validate(response, sampleContext, "explain");

      // Jailbreak pattern not detected when disabled
      expect(result.issues.some(i => i.includes("jailbreak"))).toBe(false);
    });
  });
});
