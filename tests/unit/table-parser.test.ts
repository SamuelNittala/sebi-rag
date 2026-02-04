import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import {
  extractTables,
  isPdfplumberAvailable,
  formatTableAsMarkdown,
  wrapTableWithMarkers,
  type ExtractedTable,
  type TableExtractionResult,
} from "../../apps/ingestion/src/parsers/table-parser";

// Test PDF paths
const TEST_PDF_DIR = "./data/test-pdfs";
const TEST_PDF_1 = `${TEST_PDF_DIR}/1726806037885.pdf`;
const TEST_PDF_2 = `${TEST_PDF_DIR}/1749011323267.pdf`;

// Timeout for full PDF processing (PDFs can take 15-20 seconds)
const FULL_PDF_TIMEOUT = 30000;

// Cache for extracted tables to avoid re-processing in multiple tests
let cachedResult1: TableExtractionResult | null = null;
let cachedResult2: TableExtractionResult | null = null;

async function getCachedTables1(): Promise<TableExtractionResult> {
  if (!cachedResult1) {
    cachedResult1 = await extractTables(TEST_PDF_1);
  }
  return cachedResult1;
}

async function getCachedTables2(): Promise<TableExtractionResult> {
  if (!cachedResult2) {
    cachedResult2 = await extractTables(TEST_PDF_2);
  }
  return cachedResult2;
}

describe("Table Parser", () => {
  beforeAll(async () => {
    // Verify test PDFs exist
    if (!existsSync(TEST_PDF_1)) {
      throw new Error(`Test PDF not found: ${TEST_PDF_1}`);
    }
    if (!existsSync(TEST_PDF_2)) {
      throw new Error(`Test PDF not found: ${TEST_PDF_2}`);
    }

    // Verify pdfplumber is available
    const available = await isPdfplumberAvailable();
    if (!available) {
      throw new Error(
        "pdfplumber is not available. Run: pip install -r python/requirements.txt"
      );
    }

    // Pre-warm the cache by extracting tables once
    // This is done in beforeAll so subsequent tests can use cached results
    console.log("Pre-warming table extraction cache...");
    await Promise.all([getCachedTables1(), getCachedTables2()]);
    console.log(
      `Cached: PDF1 has ${cachedResult1?.tables.length} tables, PDF2 has ${cachedResult2?.tables.length} tables`
    );
  }, FULL_PDF_TIMEOUT * 2);

  describe("isPdfplumberAvailable", () => {
    test("returns true when pdfplumber is installed", async () => {
      const result = await isPdfplumberAvailable();
      expect(result).toBe(true);
    });
  });

  describe("extractTables interface", () => {
    test("returns TableExtractionResult object with correct structure", async () => {
      const result = await getCachedTables1();

      // Check required fields exist
      expect(result).toHaveProperty("tables");
      expect(Array.isArray(result.tables)).toBe(true);

      // Should not have error if successful
      if (result.tables.length > 0) {
        expect(result.error).toBeUndefined();
      }
    });

    test("tables array contains ExtractedTable objects with correct fields", async () => {
      const result = await getCachedTables1();

      if (result.tables.length > 0) {
        const firstTable = result.tables[0];

        expect(firstTable).toHaveProperty("page");
        expect(firstTable).toHaveProperty("tableIndex");
        expect(firstTable).toHaveProperty("rows");
        expect(firstTable).toHaveProperty("markdown");

        expect(typeof firstTable.page).toBe("number");
        expect(typeof firstTable.tableIndex).toBe("number");
        expect(Array.isArray(firstTable.rows)).toBe(true);
        expect(typeof firstTable.markdown).toBe("string");
      }
    });

    test("page numbers are positive integers (1-indexed)", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        expect(table.page).toBeGreaterThan(0);
        expect(Number.isInteger(table.page)).toBe(true);
      }
    });

    test("tableIndex is zero or positive integer", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        expect(table.tableIndex).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(table.tableIndex)).toBe(true);
      }
    });
  });

  describe("table rows structure", () => {
    test("rows is a non-empty 2D array of strings", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        expect(table.rows.length).toBeGreaterThan(0);

        for (const row of table.rows) {
          expect(Array.isArray(row)).toBe(true);

          for (const cell of row) {
            expect(typeof cell).toBe("string");
          }
        }
      }
    });

    test("all cells are clean strings without raw newlines", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        for (const row of table.rows) {
          for (const cell of row) {
            // Cells should not contain raw newlines (they should be flattened)
            expect(cell.includes("\n")).toBe(false);
            expect(cell.includes("\r")).toBe(false);
          }
        }
      }
    });
  });

  describe("markdown output", () => {
    test("markdown is non-empty for tables with rows", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        if (table.rows.length > 0) {
          expect(table.markdown.length).toBeGreaterThan(0);
        }
      }
    });

    test("markdown contains proper table syntax with pipes", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        if (table.markdown.length > 0) {
          // Should contain pipe characters for table columns
          expect(table.markdown).toContain("|");
        }
      }
    });

    test("markdown has header separator line with dashes", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        if (table.markdown.length > 0 && table.rows.length > 0) {
          // Should contain separator line with dashes
          expect(table.markdown).toContain("---");
        }
      }
    });

    test("markdown row count matches data rows plus header plus separator", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        if (table.rows.length > 1) {
          const markdownLines = table.markdown
            .split("\n")
            .filter((line) => line.trim().length > 0);
          // Header + separator + data rows
          const expectedLines = table.rows.length + 1; // +1 for separator
          expect(markdownLines.length).toBe(expectedLines);
        }
      }
    });
  });

  describe("page-specific extraction", () => {
    test(
      "extracts tables from specific page when page parameter provided",
      async () => {
        // First get all tables to find which pages have tables
        const allResult = await getCachedTables1();

        if (allResult.tables.length > 0) {
          const pageWithTable = allResult.tables[0].page;

          // Now extract just from that page (this is fast, ~1 second)
          const pageResult = await extractTables(TEST_PDF_1, pageWithTable);

          expect(pageResult.error).toBeUndefined();

          // All results should be from the specified page
          for (const table of pageResult.tables) {
            expect(table.page).toBe(pageWithTable);
          }
        }
      },
      10000
    );

    test("returns error for out-of-range page number", async () => {
      const result = await extractTables(TEST_PDF_1, 9999);

      expect(result.error).toBeDefined();
      expect(result.error).toContain("out of range");
      expect(result.tables.length).toBe(0);
    });

    test("returns error for page 0 (pages are 1-indexed)", async () => {
      const result = await extractTables(TEST_PDF_1, 0);

      expect(result.error).toBeDefined();
      expect(result.tables.length).toBe(0);
    });

    test("returns error for negative page number", async () => {
      const result = await extractTables(TEST_PDF_1, -1);

      expect(result.error).toBeDefined();
      expect(result.tables.length).toBe(0);
    });
  });

  describe("edge cases", () => {
    test("returns error for non-existent file", async () => {
      const result = await extractTables("./nonexistent.pdf");

      expect(result.error).toBeDefined();
      expect(result.error).toContain("not found");
      expect(result.tables.length).toBe(0);
    });

    test("returns error for invalid file (not a PDF)", async () => {
      // Create a temporary invalid file
      const tempFile = "/tmp/invalid_table_test.pdf";
      await Bun.write(tempFile, "not a valid pdf content");

      const result = await extractTables(tempFile);

      expect(result.error).toBeDefined();
      expect(result.tables.length).toBe(0);
    });

    test("returns valid structure even when PDF has no/few tables", async () => {
      // Even if a PDF has no tables, should return valid result structure
      const result = await getCachedTables1();

      // Whether or not there are tables, structure should be valid
      expect(result).toHaveProperty("tables");
      expect(Array.isArray(result.tables)).toBe(true);
    });

    test("handles empty cells in tables gracefully", async () => {
      const result = await getCachedTables1();

      for (const table of result.tables) {
        for (const row of table.rows) {
          for (const cell of row) {
            // Empty cells should be empty strings, not null/undefined
            expect(cell).not.toBeNull();
            expect(cell).not.toBeUndefined();
          }
        }
      }
    });
  });

  describe("multiple PDFs", () => {
    test("extracts tables from multiple different PDFs", async () => {
      const results = await Promise.all([
        getCachedTables1(),
        getCachedTables2(),
      ]);

      for (const result of results) {
        expect(result).toHaveProperty("tables");
        expect(Array.isArray(result.tables)).toBe(true);
      }
    });
  });

  describe("helper functions", () => {
    describe("formatTableAsMarkdown", () => {
      test("returns markdown with title when provided", () => {
        const mockTable: ExtractedTable = {
          page: 1,
          tableIndex: 0,
          rows: [
            ["Header1", "Header2"],
            ["val1", "val2"],
          ],
          markdown: "| Header1 | Header2 |\n| --- | --- |\n| val1 | val2 |",
        };

        const result = formatTableAsMarkdown(mockTable, "Test Table");

        expect(result).toContain("**Test Table**");
        expect(result).toContain("| Header1 | Header2 |");
      });

      test("returns just markdown when no title provided", () => {
        const mockTable: ExtractedTable = {
          page: 1,
          tableIndex: 0,
          rows: [
            ["Header1", "Header2"],
            ["val1", "val2"],
          ],
          markdown: "| Header1 | Header2 |\n| --- | --- |\n| val1 | val2 |",
        };

        const result = formatTableAsMarkdown(mockTable);

        expect(result).not.toContain("**");
        expect(result).toBe(mockTable.markdown);
      });
    });

    describe("wrapTableWithMarkers", () => {
      test("wraps markdown with TABLE_START and TABLE_END markers", () => {
        const mockTable: ExtractedTable = {
          page: 1,
          tableIndex: 0,
          rows: [
            ["Header1", "Header2"],
            ["val1", "val2"],
          ],
          markdown: "| Header1 | Header2 |\n| --- | --- |\n| val1 | val2 |",
        };

        const result = wrapTableWithMarkers(mockTable);

        expect(result.startsWith("[TABLE_START]")).toBe(true);
        expect(result.endsWith("[TABLE_END]")).toBe(true);
        expect(result).toContain(mockTable.markdown);
      });
    });
  });

  describe("financial document tables", () => {
    test("extracts tables from mutual fund documents", async () => {
      const result = await getCachedTables1();

      // Mutual fund documents typically contain tables with financial data
      // This is a sanity check that tables are being extracted from real documents
      console.log(`Extracted ${result.tables.length} tables from ${TEST_PDF_1}`);

      // Should find at least some tables in a financial document
      expect(result.tables.length).toBeGreaterThan(0);

      if (result.tables.length > 0) {
        // Log first table for manual verification
        console.log(
          `First table from page ${result.tables[0].page}:`,
          "\n" + result.tables[0].markdown.slice(0, 500) + "..."
        );
      }
    });

    test("table content looks like financial data", async () => {
      const result = await getCachedTables1();

      // Check that at least some tables contain financial patterns
      // (percentages, numbers, common financial terms)
      const financialPatterns = [
        /%/, // percentages
        /\d+\.\d+/, // decimal numbers
        /Rs\.?|INR|\u20b9/, // currency
        /NAV|AUM|TER|Expense|Return|Fund|Scheme/i, // financial terms
      ];

      let hasFinancialData = false;
      for (const table of result.tables) {
        const markdown = table.markdown;
        for (const pattern of financialPatterns) {
          if (pattern.test(markdown)) {
            hasFinancialData = true;
            break;
          }
        }
        if (hasFinancialData) break;
      }

      // Financial documents should contain financial-looking data
      expect(hasFinancialData).toBe(true);
      console.log(`Contains financial-looking data: ${hasFinancialData}`);
    });
  });
});
