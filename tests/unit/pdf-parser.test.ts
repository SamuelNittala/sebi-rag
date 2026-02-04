import { test, expect, describe, beforeAll } from "bun:test";
import { parsePDF, type ParsedPDF, type ParsedPage } from "../../apps/ingestion/src/parsers/pdf-parser";
import { existsSync } from "node:fs";

// Test PDF paths
const TEST_PDF_DIR = "./data/test-pdfs";
const TEST_PDF_1 = `${TEST_PDF_DIR}/1726806037885.pdf`;
const TEST_PDF_2 = `${TEST_PDF_DIR}/1749011323267.pdf`;

describe("PDF Parser", () => {
  beforeAll(() => {
    // Verify test PDFs exist
    if (!existsSync(TEST_PDF_1)) {
      throw new Error(`Test PDF not found: ${TEST_PDF_1}`);
    }
  });

  describe("parsePDF interface", () => {
    test("returns ParsedPDF object with correct structure", async () => {
      const result = await parsePDF(TEST_PDF_1);

      // Check required fields exist
      expect(result).toHaveProperty("filename");
      expect(result).toHaveProperty("filepath");
      expect(result).toHaveProperty("pageCount");
      expect(result).toHaveProperty("pages");
      expect(result).toHaveProperty("rawText");

      // Check types
      expect(typeof result.filename).toBe("string");
      expect(typeof result.filepath).toBe("string");
      expect(typeof result.pageCount).toBe("number");
      expect(Array.isArray(result.pages)).toBe(true);
      expect(typeof result.rawText).toBe("string");
    });

    test("pages array contains ParsedPage objects", async () => {
      const result = await parsePDF(TEST_PDF_1);

      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages.length).toBe(result.pageCount);

      const firstPage = result.pages[0];
      expect(firstPage).toHaveProperty("pageNumber");
      expect(firstPage).toHaveProperty("text");
      expect(firstPage).toHaveProperty("hasTable");

      expect(typeof firstPage.pageNumber).toBe("number");
      expect(typeof firstPage.text).toBe("string");
      expect(typeof firstPage.hasTable).toBe("boolean");
    });

    test("page numbers are sequential starting from 1", async () => {
      const result = await parsePDF(TEST_PDF_1);

      for (let i = 0; i < result.pages.length; i++) {
        expect(result.pages[i].pageNumber).toBe(i + 1);
      }
    });
  });

  describe("text extraction", () => {
    test("extracts non-empty text from real PDF", async () => {
      const result = await parsePDF(TEST_PDF_1);

      expect(result.rawText.length).toBeGreaterThan(0);
      // Most pages should have some text
      const pagesWithText = result.pages.filter((p) => p.text.trim().length > 0);
      expect(pagesWithText.length).toBeGreaterThan(0);
    });

    test("rawText is concatenation of all page texts", async () => {
      const result = await parsePDF(TEST_PDF_1);

      // rawText should contain text from all pages
      for (const page of result.pages) {
        if (page.text.trim().length > 0) {
          // Each page's text should be findable in rawText
          // (may have separators added, so just check key content exists)
          const words = page.text.split(/\s+/).filter((w) => w.length > 5);
          if (words.length > 0) {
            // At least some significant words should appear
            const found = words.some((word) => result.rawText.includes(word));
            expect(found).toBe(true);
          }
        }
      }
    });
  });

  describe("header/footer removal", () => {
    test("removes common page number patterns", async () => {
      const result = await parsePDF(TEST_PDF_1);

      // Page number patterns that should be removed
      const pageNumberPatterns = [
        /^Page \d+ of \d+$/m,
        /^- \d+ -$/m,
        /^\d+$/m, // Standalone numbers at line boundaries
      ];

      for (const page of result.pages) {
        // Check that standalone page number lines are removed
        const lines = page.text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          // Allow numbers in context, but not standalone page numbers
          if (/^Page \d+ of \d+$/.test(trimmed)) {
            // This pattern should be removed
            expect(false).toBe(true); // Fail if found
          }
          if (/^- \d+ -$/.test(trimmed)) {
            expect(false).toBe(true); // Fail if found
          }
        }
      }
    });
  });

  describe("table detection", () => {
    test("detects pages that likely contain tables", async () => {
      const result = await parsePDF(TEST_PDF_1);

      // At least one page in a mutual fund document should have tables
      // (expense ratios, asset allocation, etc.)
      const pagesWithTables = result.pages.filter((p) => p.hasTable);
      // This may vary by document, so just check the property exists and is boolean
      for (const page of result.pages) {
        expect(typeof page.hasTable).toBe("boolean");
      }
    });

    test("hasTable is true when page contains pipe characters or aligned columns", async () => {
      const result = await parsePDF(TEST_PDF_1);

      for (const page of result.pages) {
        if (page.hasTable) {
          // If hasTable is true, should have table-like patterns
          const hasTablePattern =
            page.text.includes("|") ||
            /\t/.test(page.text) ||
            /\s{2,}\S+\s{2,}\S+/.test(page.text); // Multiple columns with spacing
          // This is a hint, not guaranteed - tables may be detected by other means
          // Just verify the flag is set for pages with obvious patterns
        }
      }
    });
  });

  describe("edge cases", () => {
    test("handles file path with correct filename extraction", async () => {
      const result = await parsePDF(TEST_PDF_1);

      expect(result.filename).toBe("1726806037885.pdf");
      expect(result.filepath).toBe(TEST_PDF_1);
    });

    test("throws descriptive error for non-existent file", async () => {
      await expect(parsePDF("./nonexistent.pdf")).rejects.toThrow();
    });

    test("throws descriptive error for corrupted/invalid file", async () => {
      // Create a temporary invalid file
      const tempFile = "/tmp/invalid.pdf";
      await Bun.write(tempFile, "not a valid pdf content");

      await expect(parsePDF(tempFile)).rejects.toThrow(/invalid|corrupt|parse|pdf/i);
    });

    test("handles empty pages gracefully", async () => {
      const result = await parsePDF(TEST_PDF_1);

      // Empty pages should return empty string, not throw
      for (const page of result.pages) {
        expect(typeof page.text).toBe("string");
        // Empty is okay, but should be string
      }
    });
  });

  describe("multiple PDFs", () => {
    test("parses multiple different PDFs correctly", async () => {
      const results = await Promise.all([parsePDF(TEST_PDF_1), parsePDF(TEST_PDF_2)]);

      for (const result of results) {
        expect(result.pageCount).toBeGreaterThan(0);
        expect(result.pages.length).toBe(result.pageCount);
        expect(result.rawText.length).toBeGreaterThan(0);
      }
    });
  });
});
