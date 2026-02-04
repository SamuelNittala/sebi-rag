import { test, expect, describe } from "bun:test";
import {
  extractMetadata,
  type ExtractedMetadata,
  type MetadataInput,
} from "./extractor";

describe("Metadata Extractor", () => {
  describe("extractMetadata interface", () => {
    test("returns ExtractedMetadata object with correct structure", () => {
      const input: MetadataInput = {
        filename: "Test_Fund_SID_2024-01.pdf",
        firstPageText: "Sample text from first page",
      };
      const result = extractMetadata(input);

      // Check required fields exist
      expect(result).toHaveProperty("fundName");
      expect(result).toHaveProperty("docType");
      expect(result).toHaveProperty("documentDate");
      expect(result).toHaveProperty("amcName");
      expect(result).toHaveProperty("schemeType");
      expect(result).toHaveProperty("schemeCategory");
      expect(result).toHaveProperty("isinGrowth");
      expect(result).toHaveProperty("isinDividend");
      expect(result).toHaveProperty("schemeCode");
    });
  });

  describe("filename parsing", () => {
    test("extracts fund name from underscore-separated filename", () => {
      const input: MetadataInput = {
        filename: "HDFC_Mid-Cap_Opportunities_Fund_SID_2024-01.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("HDFC Mid-Cap Opportunities Fund");
    });

    test("extracts fund name from dash-separated filename", () => {
      const input: MetadataInput = {
        filename: "SBI-Bluechip-Fund-KIM-Jan-2024.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("SBI Bluechip Fund");
    });

    test("extracts fund name with mixed separators", () => {
      const input: MetadataInput = {
        filename: "Axis_Flexi_Cap_Fund_Factsheet_December_2023.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("Axis Flexi Cap Fund");
    });

    test("extracts doc type SID from filename", () => {
      const input: MetadataInput = {
        filename: "HDFC_Mid-Cap_Opportunities_Fund_SID_2024-01.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("SID");
    });

    test("extracts doc type KIM from filename", () => {
      const input: MetadataInput = {
        filename: "SBI-Bluechip-Fund-KIM-Jan-2024.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("KIM");
    });

    test("extracts doc type Factsheet from filename", () => {
      const input: MetadataInput = {
        filename: "Axis_Flexi_Cap_Fund_Factsheet_December_2023.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("Factsheet");
    });

    test("extracts date in YYYY-MM format from filename", () => {
      const input: MetadataInput = {
        filename: "HDFC_Mid-Cap_Opportunities_Fund_SID_2024-01.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.documentDate).not.toBeNull();
      expect(result.documentDate?.getFullYear()).toBe(2024);
      expect(result.documentDate?.getMonth()).toBe(0); // January = 0
    });

    test("extracts date with month name from filename", () => {
      const input: MetadataInput = {
        filename: "SBI-Bluechip-Fund-KIM-Jan-2024.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.documentDate).not.toBeNull();
      expect(result.documentDate?.getFullYear()).toBe(2024);
      expect(result.documentDate?.getMonth()).toBe(0); // January = 0
    });

    test("extracts date with full month name from filename", () => {
      const input: MetadataInput = {
        filename: "Axis_Flexi_Cap_Fund_Factsheet_December_2023.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.documentDate).not.toBeNull();
      expect(result.documentDate?.getFullYear()).toBe(2023);
      expect(result.documentDate?.getMonth()).toBe(11); // December = 11
    });

    test("returns null for date when not found in filename", () => {
      const input: MetadataInput = {
        filename: "Some_Fund_Document.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.documentDate).toBeNull();
    });

    test("handles filename without clear fund name", () => {
      const input: MetadataInput = {
        filename: "document.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBeNull();
    });
  });

  describe("doc type detection from content", () => {
    test("detects SID from content when not in filename", () => {
      const input: MetadataInput = {
        filename: "some_document.pdf",
        firstPageText: "Scheme Information Document for HDFC Equity Fund",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("SID");
    });

    test("detects KIM from content", () => {
      const input: MetadataInput = {
        filename: "some_document.pdf",
        firstPageText: "Key Information Memorandum dated January 2024",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("KIM");
    });

    test("detects Factsheet from content", () => {
      const input: MetadataInput = {
        filename: "some_document.pdf",
        firstPageText: "Monthly Factsheet December 2023\nNAV: Rs 45.23",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("Factsheet");
    });

    test("detects Annual Report from content", () => {
      const input: MetadataInput = {
        filename: "some_document.pdf",
        firstPageText: "Annual Report 2023-24\nTrustee Report to Unitholders",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("AnnualReport");
    });

    test("returns Unknown when doc type not detected", () => {
      const input: MetadataInput = {
        filename: "random.pdf",
        firstPageText: "Some random text without document type indicators",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("Unknown");
    });

    test("filename doc type takes precedence over content", () => {
      const input: MetadataInput = {
        filename: "HDFC_Fund_SID_2024.pdf",
        firstPageText: "This is a Key Information Memorandum",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("SID");
    });
  });

  describe("AMC name extraction", () => {
    test("extracts HDFC Asset Management", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Asset Management Company Limited",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBe("HDFC Asset Management Company Limited");
    });

    test("extracts SBI Funds Management", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "SBI Funds Management Private Limited",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBe("SBI Funds Management Private Limited");
    });

    test("extracts Axis Asset Management", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Managed by Axis Asset Management Company Ltd",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBe("Axis Asset Management Company Ltd");
    });

    test("extracts AMC name with AMC keyword", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Investment Manager: ICICI Prudential AMC Limited",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBe("ICICI Prudential AMC Limited");
    });

    test("extracts Mutual Fund name pattern", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Mutual Fund\nSponsored by HDFC Ltd",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBe("HDFC Mutual Fund");
    });

    test("returns null when AMC not found", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Some text without AMC mention",
      };
      const result = extractMetadata(input);

      expect(result.amcName).toBeNull();
    });
  });

  describe("scheme type classification", () => {
    test("detects Equity scheme type", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Equity Scheme investing in large cap stocks",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Equity");
    });

    test("detects Equity from fund keyword", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Equity Fund - Direct Growth",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Equity");
    });

    test("detects Debt scheme type", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Debt Scheme investing in government securities",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Debt");
    });

    test("detects Debt from Fixed Income keyword", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Fixed Income Fund investing in bonds",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Debt");
    });

    test("detects Hybrid scheme type", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Hybrid Scheme with equity and debt allocation",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Hybrid");
    });

    test("detects Hybrid from Balanced keyword", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Balanced Advantage Fund",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Hybrid");
    });

    test("detects Solution scheme type from Retirement", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Retirement Fund designed for long-term wealth creation",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Solution");
    });

    test("detects Solution scheme type from Children's", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Children's Gift Fund",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Solution");
    });

    test("detects Solution from Solution Oriented keyword", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Solution Oriented Scheme with lock-in period",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Solution");
    });

    test("returns Other for unclassified schemes", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Index Fund tracking Nifty 50",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBe("Other");
    });

    test("returns null when scheme type not determinable", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Some generic document text",
      };
      const result = extractMetadata(input);

      expect(result.schemeType).toBeNull();
    });
  });

  describe("scheme category extraction", () => {
    test("extracts Large Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Equity Scheme predominantly investing in Large Cap stocks",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Large Cap");
    });

    test("extracts Mid Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Mid-Cap Opportunities Fund investing in mid cap companies",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Mid Cap");
    });

    test("extracts Small Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Small Cap Fund for aggressive investors",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Small Cap");
    });

    test("extracts Flexi Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Axis Flexi Cap Fund - flexibility to invest across market caps",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Flexi Cap");
    });

    test("extracts Multi Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Multi Cap Fund with diversified portfolio",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Multi Cap");
    });

    test("extracts Large and Mid Cap category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "An Open Ended Large & Mid Cap Fund",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Large & Mid Cap");
    });

    test("extracts ELSS category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Tax Saver - An Equity Linked Savings Scheme (ELSS)",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("ELSS");
    });

    test("extracts Sectoral/Thematic category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Sectoral/Thematic Fund focusing on Banking sector",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Sectoral/Thematic");
    });

    test("extracts Value Fund category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "ICICI Prudential Value Discovery Fund",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Value");
    });

    test("extracts Contra Fund category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "SBI Contra Fund following contrarian investment strategy",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Contra");
    });

    test("extracts Focused Fund category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A Focused Fund with maximum 30 stocks",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Focused");
    });

    test("extracts Dividend Yield category", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC Dividend Yield Fund investing in high dividend yield stocks",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBe("Dividend Yield");
    });

    test("returns null when category not found", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "A generic fund document",
      };
      const result = extractMetadata(input);

      expect(result.schemeCategory).toBeNull();
    });
  });

  describe("ISIN extraction", () => {
    test("extracts single ISIN", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "ISIN: INF179K01BE8",
      };
      const result = extractMetadata(input);

      expect(result.isinGrowth).toBe("INF179K01BE8");
    });

    test("extracts Growth ISIN from labeled text", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "ISIN (Growth): INF179K01BE8\nISIN (IDCW): INF179K01BF5",
      };
      const result = extractMetadata(input);

      expect(result.isinGrowth).toBe("INF179K01BE8");
    });

    test("extracts IDCW/Dividend ISIN from labeled text", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "ISIN (Growth): INF179K01BE8\nISIN (IDCW): INF179K01BF5",
      };
      const result = extractMetadata(input);

      expect(result.isinDividend).toBe("INF179K01BF5");
    });

    test("extracts multiple ISINs and assigns first to growth", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "ISINs: INF179K01BE8, INF179K01BF5, INF179K01BG3",
      };
      const result = extractMetadata(input);

      expect(result.isinGrowth).toBe("INF179K01BE8");
    });

    test("handles ISIN in table format", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: `
          Plan          ISIN
          Direct Growth INF179K01BE8
          Direct IDCW   INF179K01BF5
        `,
      };
      const result = extractMetadata(input);

      expect(result.isinGrowth).toBe("INF179K01BE8");
      expect(result.isinDividend).toBe("INF179K01BF5");
    });

    test("returns null when no ISIN found", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Document without ISIN numbers",
      };
      const result = extractMetadata(input);

      expect(result.isinGrowth).toBeNull();
      expect(result.isinDividend).toBeNull();
    });

    test("validates ISIN format strictly", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Invalid: INF12345 and INF12345678901234 (too long)",
      };
      const result = extractMetadata(input);

      // Should not extract invalid ISINs
      expect(result.isinGrowth).toBeNull();
    });
  });

  describe("scheme code extraction", () => {
    test("extracts scheme code near ISIN", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Scheme Code: 1234\nISIN: INF179K01BE8",
      };
      const result = extractMetadata(input);

      expect(result.schemeCode).toBe("1234");
    });

    test("extracts scheme code with different labels", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Fund Code: 56789",
      };
      const result = extractMetadata(input);

      expect(result.schemeCode).toBe("56789");
    });

    test("extracts AMFI code", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "AMFI Code: 123456",
      };
      const result = extractMetadata(input);

      expect(result.schemeCode).toBe("123456");
    });

    test("returns null when no scheme code found", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Document without scheme codes",
      };
      const result = extractMetadata(input);

      expect(result.schemeCode).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("handles empty filename", () => {
      const input: MetadataInput = {
        filename: "",
        firstPageText: "Some content",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBeNull();
      expect(result.docType).toBe("Unknown");
    });

    test("handles empty firstPageText", () => {
      const input: MetadataInput = {
        filename: "HDFC_Fund_SID_2024.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      // Should still extract from filename
      expect(result.fundName).toBe("HDFC Fund");
      expect(result.docType).toBe("SID");
    });

    test("handles garbled/encoded text", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "H\u0000D\u0000F\u0000C\u0000 Asset Management Company",
      };
      const result = extractMetadata(input);

      // Should handle gracefully, may or may not extract
      expect(typeof result.amcName === "string" || result.amcName === null).toBe(true);
    });

    test("handles text with excessive whitespace", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "HDFC    Asset    Management    Company    Limited",
      };
      const result = extractMetadata(input);

      expect(result.amcName).not.toBeNull();
    });

    test("handles case insensitivity", () => {
      const input: MetadataInput = {
        filename: "HDFC_FUND_sid_2024.PDF",
        firstPageText: "scheme information document",
      };
      const result = extractMetadata(input);

      expect(result.docType).toBe("SID");
    });

    test("handles multiple funds in document", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: `
          HDFC Equity Fund - ISIN: INF179K01BE8
          HDFC Growth Fund - ISIN: INF179K01XY9
        `,
      };
      const result = extractMetadata(input);

      // Should extract the first one found
      expect(result.isinGrowth).toBe("INF179K01BE8");
    });

    test("handles minimal metadata gracefully", () => {
      const input: MetadataInput = {
        filename: "x.pdf",
        firstPageText: "y",
      };
      const result = extractMetadata(input);

      // Should not throw, return nulls for missing data
      expect(result.fundName).toBeNull();
      expect(result.docType).toBe("Unknown");
      expect(result.amcName).toBeNull();
    });

    test("uses fullText when provided for deep extraction", () => {
      const input: MetadataInput = {
        filename: "doc.pdf",
        firstPageText: "Page 1 content",
        fullText: "Page 1 content\nPage 2 has ISIN: INF179K01BE8\nScheme Code: 1234",
      };
      const result = extractMetadata(input);

      // Should find ISIN in fullText
      expect(result.isinGrowth).toBe("INF179K01BE8");
      expect(result.schemeCode).toBe("1234");
    });
  });

  describe("real-world filename patterns", () => {
    test("parses Mirae Asset filename", () => {
      const input: MetadataInput = {
        filename: "Mirae_Asset_Large_Cap_Fund_SID_March_2024.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("Mirae Asset Large Cap Fund");
      expect(result.docType).toBe("SID");
      expect(result.documentDate?.getMonth()).toBe(2); // March = 2
    });

    test("parses Kotak filename", () => {
      const input: MetadataInput = {
        filename: "Kotak-Emerging-Equity-KIM-Q4-2023.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("Kotak Emerging Equity");
      expect(result.docType).toBe("KIM");
    });

    test("parses Nippon India filename", () => {
      const input: MetadataInput = {
        filename: "Nippon_India_Small_Cap_Fund_Factsheet_Nov_2023.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      expect(result.fundName).toBe("Nippon India Small Cap Fund");
      expect(result.docType).toBe("Factsheet");
      expect(result.documentDate?.getMonth()).toBe(10); // November = 10
    });

    test("parses Aditya Birla filename", () => {
      const input: MetadataInput = {
        filename: "ABSL_Frontline_Equity_Fund_Annual_Report_2023-24.pdf",
        firstPageText: "",
      };
      const result = extractMetadata(input);

      // ABSL is commonly used abbreviation
      expect(result.fundName).toBe("ABSL Frontline Equity Fund");
      expect(result.docType).toBe("AnnualReport");
    });
  });
});
