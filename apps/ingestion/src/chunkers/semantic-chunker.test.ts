/**
 * Semantic Chunker Tests
 *
 * TDD tests for the semantic chunking module that splits
 * parsed PDF content into chunks optimal for RAG retrieval.
 */

import { describe, test, expect } from "bun:test";
import {
  semanticChunk,
  estimateTokenCount,
  type ChunkInput,
  type ChunkResult,
  DEFAULT_CHUNK_CONFIG,
} from "./semantic-chunker";

describe("estimateTokenCount", () => {
  test("estimates tokens from word count", () => {
    const text = "This is a simple test sentence with ten words here";
    const tokens = estimateTokenCount(text);
    // 10 words * 1.3 = 13
    expect(tokens).toBe(13);
  });

  test("handles empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  test("handles whitespace-only string", () => {
    expect(estimateTokenCount("   \n\t  ")).toBe(0);
  });
});

describe("semanticChunk", () => {
  describe("basic text chunking", () => {
    test("chunks simple text into appropriate sizes", () => {
      // Create text that's ~600 tokens (about 460 words)
      const words = Array(460).fill("word").join(" ");
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: words }],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBeGreaterThan(1);
      for (const chunk of result.chunks) {
        expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_CONFIG.maxTokens);
      }
    });

    test("returns single chunk for small text", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "This is a small piece of text." }],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].text).toBe("This is a small piece of text.");
      expect(result.chunks[0].pageNumbers).toEqual([1]);
    });

    test("handles empty input", () => {
      const input: ChunkInput = { pages: [] };
      const result = semanticChunk(input);

      expect(result.chunks).toEqual([]);
      expect(result.totalChunks).toBe(0);
      expect(result.totalTokens).toBe(0);
    });

    test("handles pages with empty text", () => {
      const input: ChunkInput = {
        pages: [
          { pageNumber: 1, text: "" },
          { pageNumber: 2, text: "   " },
          { pageNumber: 3, text: "Some content here." },
        ],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].pageNumbers).toEqual([3]);
    });
  });

  describe("boundary detection", () => {
    test("splits before section headers (SECTION I format)", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Introduction paragraph with some content here.

SECTION I - OVERVIEW

This is the overview section with more content.`,
          },
        ],
      };

      const result = semanticChunk(input, { targetTokens: 20, maxTokens: 30, minTokens: 5 });

      // Should split at SECTION I
      const hasChunkStartingWithSection = result.chunks.some((c) =>
        c.text.startsWith("SECTION I")
      );
      expect(hasChunkStartingWithSection).toBe(true);
    });

    test("splits before numbered sections (1. format)", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Overview content here.

1. First Section

Content of first section here.

2. Second Section

Content of second section.`,
          },
        ],
      };

      const result = semanticChunk(input, { targetTokens: 15, maxTokens: 25, minTokens: 3 });

      const texts = result.chunks.map((c) => c.text.trim());
      const startsWithNumbered = texts.filter(
        (t) => t.startsWith("1.") || t.startsWith("2.")
      );
      expect(startsWithNumbered.length).toBeGreaterThan(0);
    });

    test("does not treat a year as a numbered section boundary", () => {
      const input: ChunkInput = {
        pages: [{
          pageNumber: 1,
          text: "The scheme complies with the SEBI Mutual Funds Regulations,\n1996. The AMC shall apply the regulation consistently.",
        }],
      };

      const result = semanticChunk(input);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]?.text).toContain("Regulations,");
      expect(result.chunks[0]?.text).toContain("1996. The AMC");
    });

    test("splits Roman-numbered SIF facts into independently classifiable chunks", () => {
      const input: ChunkInput = {
        pages: [{
          pageNumber: 6,
          text: `Platinum Hybrid Long-Short Fund

The Trustees may change the benchmark in future if a benchmark better suited
to the investment objective of the Investment Strategy is available.
VIII. Subscription
frequency
All business days
The Trustees reserves the right to change the Subscription frequency in future.
IX. Redemption
frequency
2 times in a week (Monday & Thursday) or at any lesser frequency as may be
decided by the AMC.
Redemption requests received after Thursday 3.00 PM till Monday 3.00 PM
would be considered for processing with Monday NAV.
X. NAV disclosure
The AMC will calculate and disclose the NAV on every Business Day.`,
        }],
      };

      const result = semanticChunk(input, { minTokens: 1 });
      const redemption = result.chunks.find(
        (chunk) => chunk.sectionHeader === "IX. Redemption"
      );

      expect(redemption).toBeDefined();
      expect(redemption!.text).toContain("2 times in a week (Monday & Thursday)");
      expect(redemption!.text).not.toContain("benchmark better suited");
      expect(redemption!.text).not.toContain("Subscription frequency");
      expect(redemption!.text).not.toContain("NAV on every Business Day");
    });

    test("splits before markdown headers", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Intro paragraph.

## Investment Objectives

The fund aims to provide returns.

### Risk Factors

Investment involves risk.`,
          },
        ],
      };

      const result = semanticChunk(input, { targetTokens: 10, maxTokens: 20, minTokens: 3 });

      const hasMarkdownHeader = result.chunks.some(
        (c) => c.text.trim().startsWith("##") || c.text.trim().startsWith("###")
      );
      expect(hasMarkdownHeader).toBe(true);
    });

    test("detects and tracks section headers", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `SECTION I - INTRODUCTION

This is content under the introduction section.`,
          },
        ],
      };

      const result = semanticChunk(input);

      expect(result.chunks[0].sectionHeader).toContain("SECTION I");
    });

    test("recognizes short title-case KIM labels as section boundaries", () => {
      const input: ChunkInput = {
        pages: [{
          pageNumber: 1,
          text: `Investment objective

The strategy seeks long-term capital appreciation through equity and debt exposure.

Minimum Investment Threshold

The minimum aggregate investment is INR 10 lakh at PAN level.`,
        }],
      };

      const result = semanticChunk(input, { minTokens: 1 });

      expect(result.chunks.some((chunk) => chunk.sectionHeader === "Investment objective")).toBe(true);
      expect(result.chunks.some((chunk) => chunk.sectionHeader === "Minimum Investment Threshold")).toBe(true);
    });

    test("preserves a short complete fact under its own explicit heading", () => {
      const input: ChunkInput = {
        pages: [{
          pageNumber: 1,
          text: `Performance Track Record

No performance track record is available.

Fund Manager

The strategy is managed by Example Manager with extensive investment experience.`,
        }],
      };

      const result = semanticChunk(input, { minTokens: 1 });
      const trackRecord = result.chunks.find(
        (chunk) => chunk.sectionHeader === "Performance Track Record"
      );

      expect(trackRecord).toBeDefined();
      expect(trackRecord!.text).toContain("No performance track record is available.");
      expect(trackRecord!.text).not.toContain("Fund Manager");
    });

    test("retains the section heading on every continuation chunk", () => {
      const longAnswer = Array(180)
        .fill("Redemption requests are processed according to the disclosed interval rules.")
        .join(" ");
      const input: ChunkInput = {
        pages: [{
          pageNumber: 1,
          text: `### How do investors redeem their units?\n\n${longAnswer}`,
        }],
      };

      const result = semanticChunk(input, {
        targetTokens: 100,
        maxTokens: 120,
        minTokens: 1,
      });

      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks.every(
        (chunk) => chunk.sectionHeader === "How do investors redeem their units?"
      )).toBe(true);
    });
  });

  describe("atomic unit preservation", () => {
    test("does not split mid-sentence", () => {
      // Create text where splitting mid-sentence would be necessary without sentence awareness
      const sentences = [
        "This is the first sentence with some content.",
        "This is the second sentence with more content.",
        "This is the third sentence with additional content.",
        "This is the fourth sentence with extra content.",
      ];
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: sentences.join(" ") }],
      };

      const result = semanticChunk(input, { targetTokens: 20, maxTokens: 50, minTokens: 5 });

      for (const chunk of result.chunks) {
        // Check that chunks don't end mid-word (simple heuristic)
        const trimmed = chunk.text.trim();
        if (trimmed.length > 0) {
          // Should end with punctuation or be at a natural boundary
          const lastChar = trimmed[trimmed.length - 1];
          const endsNaturally =
            [".", "!", "?", ":", ";", '"', "'", ")"].includes(lastChar) ||
            trimmed.endsWith("|"); // table end
          expect(endsNaturally).toBe(true);
        }
      }
    });

    test("keeps bulleted lists together when possible", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Investment features:
- Low expense ratio
- Diversified portfolio
- Professional management
- Regular dividend payouts`,
          },
        ],
      };

      const result = semanticChunk(input);

      // With default config, this should fit in one chunk
      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].text).toContain("- Low expense ratio");
      expect(result.chunks[0].text).toContain("- Regular dividend payouts");
    });
  });

  describe("table handling", () => {
    test("preserves tables as atomic units", () => {
      const tableMarkdown = `| Fund | NAV | Returns |
|------|-----|---------|
| A    | 100 | 10%     |
| B    | 200 | 15%     |
| C    | 150 | 12%     |`;

      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Some intro text." }],
        tables: [{ pageNumber: 1, markdown: tableMarkdown }],
      };

      const result = semanticChunk(input);

      // Table should be in its own chunk
      const tableChunk = result.chunks.find((c) => c.hasTable);
      expect(tableChunk).toBeDefined();
      expect(tableChunk!.text).toContain("[TABLE]");
      expect(tableChunk!.text).toContain("| Fund | NAV | Returns |");
    });

    test("allows larger chunks for tables (up to tableMaxTokens)", () => {
      // Create a large table
      const rows = Array(30)
        .fill(null)
        .map((_, i) => `| Item ${i} | Value ${i} | Description ${i} |`)
        .join("\n");
      const largeTable = `| Name | Value | Description |
|------|-------|-------------|
${rows}`;

      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Context." }],
        tables: [{ pageNumber: 1, markdown: largeTable }],
      };

      const result = semanticChunk(input);

      const tableChunk = result.chunks.find((c) => c.hasTable);
      expect(tableChunk).toBeDefined();
      // Table chunk can exceed normal maxTokens but not tableMaxTokens
      expect(tableChunk!.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_CONFIG.tableMaxTokens);
    });

    test("adds [TABLE] prefix to table chunks", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Some text." }],
        tables: [{ pageNumber: 1, markdown: "| A | B |\n|---|---|\n| 1 | 2 |" }],
      };

      const result = semanticChunk(input);

      const tableChunk = result.chunks.find((c) => c.hasTable);
      expect(tableChunk!.text).toMatch(/^\[TABLE\]/);
    });

    test("includes preceding context with table", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Fund Performance Summary

The following table shows the performance of various funds:`,
          },
        ],
        tables: [{ pageNumber: 1, markdown: "| Fund | Returns |\n|------|--------|\n| A | 10% |" }],
      };

      const result = semanticChunk(input);

      const tableChunk = result.chunks.find((c) => c.hasTable);
      // Table chunk should include some context
      expect(tableChunk!.text).toContain("performance");
    });
  });

  describe("noise removal", () => {
    test("removes page number patterns", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `Page 1 of 10

Actual content here.

- 1 -`,
          },
        ],
      };

      const result = semanticChunk(input);

      expect(result.chunks[0].text).not.toContain("Page 1 of 10");
      expect(result.chunks[0].text).not.toContain("- 1 -");
      expect(result.chunks[0].text).toContain("Actual content");
    });

    test("removes standalone page numbers", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 5,
            text: `5

Content on page five here.

5`,
          },
        ],
      };

      const result = semanticChunk(input);

      // The chunk should not start or end with just "5"
      const trimmed = result.chunks[0].text.trim();
      expect(trimmed).not.toBe("5");
      expect(trimmed.startsWith("Content")).toBe(true);
    });

    test("normalizes excessive whitespace", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `First paragraph.



Second paragraph with   too   many   spaces.`,
          },
        ],
      };

      const result = semanticChunk(input);

      // Should not have more than 2 consecutive newlines
      expect(result.chunks[0].text).not.toMatch(/\n{3,}/);
    });
  });

  describe("page tracking", () => {
    test("tracks page numbers correctly for single-page chunks", () => {
      const input: ChunkInput = {
        pages: [
          { pageNumber: 1, text: "Content from page one." },
          { pageNumber: 2, text: "Content from page two." },
        ],
      };

      const result = semanticChunk(input);

      // Each chunk should have correct page numbers
      expect(result.chunks.some((c) => c.pageNumbers.includes(1))).toBe(true);
      expect(result.chunks.some((c) => c.pageNumbers.includes(2))).toBe(true);
    });

    test("tracks multiple pages when chunk spans pages", () => {
      // Create content that will combine across pages
      const input: ChunkInput = {
        pages: [
          { pageNumber: 1, text: "Short content." },
          { pageNumber: 2, text: "More short content." },
          { pageNumber: 3, text: "Final content." },
        ],
      };

      const result = semanticChunk(input, { minTokens: 20, targetTokens: 100, maxTokens: 150 });

      // With high minTokens, pages should combine
      if (result.chunks.length === 1) {
        expect(result.chunks[0].pageNumbers).toEqual([1, 2, 3]);
      }
    });
  });

  describe("overlap", () => {
    test("applies overlap between text chunks", () => {
      // Create enough content to need multiple chunks
      const paragraph1 = "This is the first paragraph with important context. " +
        "It contains several sentences that provide background information.";
      const paragraph2 = "This is the second paragraph that continues the discussion. " +
        "It references concepts from the previous section.";

      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: `${paragraph1}\n\n${paragraph2}` }],
      };

      const result = semanticChunk(input, {
        targetTokens: 20,
        maxTokens: 30,
        minTokens: 5,
        overlapTokens: 10,
      });

      if (result.chunks.length >= 2) {
        // Check that some content appears in consecutive chunks (overlap)
        for (let i = 1; i < result.chunks.length; i++) {
          const prevChunk = result.chunks[i - 1];
          const currChunk = result.chunks[i];

          // Skip overlap check for table chunks
          if (prevChunk.hasTable || currChunk.hasTable) continue;

          // Get last few words of previous chunk
          const prevWords = prevChunk.text.trim().split(/\s+/).slice(-5);
          // Get first few words of current chunk
          const currWords = currChunk.text.trim().split(/\s+/).slice(0, 10);

          // There should be some overlap
          const hasOverlap = prevWords.some((w) => currWords.includes(w));
          expect(hasOverlap).toBe(true);
        }
      }
    });

    test("does not apply overlap to table chunks", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `First paragraph of text content here.

Second paragraph of text content.`,
          },
        ],
        tables: [{ pageNumber: 1, markdown: "| A | B |\n|---|---|\n| 1 | 2 |" }],
      };

      const result = semanticChunk(input, { targetTokens: 15, maxTokens: 25, minTokens: 3 });

      const tableChunk = result.chunks.find((c) => c.hasTable);
      expect(tableChunk).toBeDefined();
      // Table chunk should start with [TABLE], not overlap content
      expect(tableChunk!.text.trim()).toMatch(/^\[TABLE\]/);
    });
  });

  describe("minimum chunk size", () => {
    test("combines tiny chunks to meet minimum", () => {
      const input: ChunkInput = {
        pages: [
          { pageNumber: 1, text: "Tiny." },
          { pageNumber: 2, text: "Also tiny." },
          { pageNumber: 3, text: "Still tiny." },
        ],
      };

      const result = semanticChunk(input, { minTokens: 20 });

      // Should combine into fewer chunks
      expect(result.chunks.length).toBeLessThanOrEqual(1);
    });

    test("allows small final chunk", () => {
      // Create content where last chunk would naturally be small
      const words = Array(400).fill("word").join(" ");
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: `${words} Final small bit.` }],
      };

      const result = semanticChunk(input);

      // Last chunk can be smaller than minTokens
      const lastChunk = result.chunks[result.chunks.length - 1];
      // Just verify it exists and has content
      expect(lastChunk.text.length).toBeGreaterThan(0);
    });
  });

  describe("chunk metadata", () => {
    test("assigns sequential chunk indices", () => {
      const words = Array(500).fill("word").join(" ");
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: words }],
      };

      const result = semanticChunk(input);

      for (let i = 0; i < result.chunks.length; i++) {
        expect(result.chunks[i].chunkIndex).toBe(i);
      }
    });

    test("calculates total chunks and tokens correctly", () => {
      const input: ChunkInput = {
        pages: [
          { pageNumber: 1, text: "Some content here with several words in it." },
          { pageNumber: 2, text: "More content on the second page." },
        ],
      };

      const result = semanticChunk(input);

      expect(result.totalChunks).toBe(result.chunks.length);
      const sumTokens = result.chunks.reduce((acc, c) => acc + c.tokenCount, 0);
      expect(result.totalTokens).toBe(sumTokens);
    });

    test("marks table chunks with hasTable=true", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Text content." }],
        tables: [{ pageNumber: 1, markdown: "| A |\n|---|\n| 1 |" }],
      };

      const result = semanticChunk(input);

      const tableChunks = result.chunks.filter((c) => c.hasTable);
      const textChunks = result.chunks.filter((c) => !c.hasTable);

      expect(tableChunks.length).toBeGreaterThan(0);
      expect(textChunks.length).toBeGreaterThan(0);
    });
  });

  describe("custom configuration", () => {
    test("respects custom targetTokens", () => {
      const words = Array(300).fill("word").join(" ");
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: words }],
      };

      const result = semanticChunk(input, { targetTokens: 100, maxTokens: 120 });

      // Should create more chunks with smaller target
      expect(result.chunks.length).toBeGreaterThan(2);
    });

    test("respects custom maxTokens", () => {
      const words = Array(300).fill("word").join(" ");
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: words }],
      };

      const result = semanticChunk(input, { maxTokens: 200 });

      for (const chunk of result.chunks) {
        if (!chunk.hasTable) {
          expect(chunk.tokenCount).toBeLessThanOrEqual(200);
        }
      }
    });

    test("does not merge a short overlap chunk past the token limit", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: Array(900).fill("a").join(" ") }],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBeGreaterThan(1);
      expect(result.chunks.every((chunk) =>
        chunk.hasTable || chunk.tokenCount <= DEFAULT_CHUNK_CONFIG.maxTokens
      )).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("merges standalone and chained headings with their following body", () => {
      const input: ChunkInput = {
        pages: [{
          pageNumber: 1,
          text: `SECTION I
PART II. INFORMATION ABOUT THE SCHEME
A. HOW WILL THE SCHEME ALLOCATE ITS ASSETS?
The scheme will allocate its assets according to the limits stated in the following table and the applicable regulations.`,
        }],
      };

      const result = semanticChunk(input);

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]?.text).toContain("SECTION I");
      expect(result.chunks[0]?.text).toContain("The scheme will allocate its assets");
      expect(result.chunks[0]?.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_CONFIG.maxTokens);
    });

    test("handles single sentence input", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Just one sentence here." }],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBe(1);
      expect(result.chunks[0].text).toBe("Just one sentence here.");
    });

    test("splits a huge table into complete row groups without truncating rows", () => {
      // Create an extremely large table
      const rows = Array(200)
        .fill(null)
        .map(
          (_, i) =>
            `| Long item name ${i} | Long value description ${i} | Extended description text ${i} |`
        )
        .join("\n");
      const hugeTable = `| Name | Value | Description |
|------|-------|-------------|
${rows}`;

      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "Context." }],
        tables: [{ pageNumber: 1, markdown: hugeTable }],
      };

      // A small table limit forces multiple row-group children.
      const result = semanticChunk(input, { tableMaxTokens: 100 });

      const tableChunks = result.chunks.filter((chunk) => chunk.hasTable);
      expect(tableChunks.length).toBeGreaterThan(1);
      expect(tableChunks.every((chunk) => !chunk.text.includes("[TABLE TRUNCATED]"))).toBe(true);
      expect(tableChunks.every((chunk) => chunk.text.includes("| Name | Value | Description |"))).toBe(true);

      for (let rowIndex = 0; rowIndex < 200; rowIndex++) {
        const marker = `| Long item name ${rowIndex} |`;
        const occurrences = tableChunks.reduce(
          (count, chunk) => count + (chunk.text.includes(marker) ? 1 : 0),
          0
        );
        expect(occurrences).toBe(1);
      }
    });

    test("preserves a legal table row within the bounded table allowance", () => {
      const longCell = Array(850).fill("condition").join(" ");
      const table = `| Rule | Details |
|------|---------|
| Redemption | ${longCell} |`;
      const result = semanticChunk({
        pages: [{ pageNumber: 1, text: "Redemption terms." }],
        tables: [{ pageNumber: 1, markdown: table }],
      });

      const tableChunks = result.chunks.filter((chunk) => chunk.hasTable);
      expect(tableChunks).toHaveLength(1);
      expect(tableChunks[0]?.tokenCount).toBeGreaterThan(1024);
      expect(tableChunks[0]?.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_CONFIG.tableMaxTokens);
      expect(tableChunks[0]?.text).toContain(longCell);
    });

    test("attaches a standalone heading to its following table", () => {
      const result = semanticChunk({
        pages: [{ pageNumber: 1, text: "A. ASSET ALLOCATION" }],
        tables: [{ pageNumber: 1, markdown: "| Asset | Limit |\n|---|---|\n| Equity | 80% |" }],
      });

      expect(result.chunks).toHaveLength(1);
      expect(result.chunks[0]?.hasTable).toBe(true);
      expect(result.chunks[0]?.text).toContain("A. ASSET ALLOCATION");
      expect(result.chunks[0]?.text).toContain("| Equity | 80% |");
    });

    test("handles input with only tables, no text", () => {
      const input: ChunkInput = {
        pages: [{ pageNumber: 1, text: "" }],
        tables: [{ pageNumber: 1, markdown: "| A | B |\n|---|---|\n| 1 | 2 |" }],
      };

      const result = semanticChunk(input);

      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].hasTable).toBe(true);
    });

    test("handles special characters in text", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: "Fund returns: 10.5% (CAGR). NAV: ₹150.25. Risk: ★★★☆☆",
          },
        ],
      };

      const result = semanticChunk(input);

      expect(result.chunks[0].text).toContain("₹150.25");
      expect(result.chunks[0].text).toContain("★★★☆☆");
    });

    test("handles text with many section markers", () => {
      const input: ChunkInput = {
        pages: [
          {
            pageNumber: 1,
            text: `SECTION I

Content one.

SECTION II

Content two.

SECTION III

Content three.

SECTION IV

Content four.`,
          },
        ],
      };

      const result = semanticChunk(input, { targetTokens: 10, maxTokens: 20, minTokens: 3 });

      // Should split at section boundaries
      expect(result.chunks.length).toBeGreaterThanOrEqual(3);
    });
  });
});
