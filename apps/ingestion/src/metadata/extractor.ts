/**
 * Metadata Extraction for MF-RAG System
 *
 * Extracts metadata from mutual fund documents for FILTERING during retrieval.
 * All content gets indexed regardless - metadata enables filtering.
 */

/**
 * Document type classification
 */
export type DocType = "SID" | "KIM" | "Factsheet" | "AnnualReport" | "Unknown";

/**
 * Scheme type classification
 */
export type SchemeType = "Equity" | "Debt" | "Hybrid" | "Solution" | "Other" | null;

/**
 * Extracted metadata for filtering during retrieval
 */
export interface ExtractedMetadata {
  // From filename
  fundName: string | null;
  docType: DocType;
  documentDate: Date | null;

  // From content
  amcName: string | null;
  schemeType: SchemeType;
  schemeCategory: string | null; // e.g., "Large Cap", "Flexi Cap"

  // Identifiers
  isinGrowth: string | null; // INF123456789
  isinDividend: string | null;
  schemeCode: string | null;
}

/**
 * Input for metadata extraction
 */
export interface MetadataInput {
  filename: string;
  filepath?: string; // Full path to PDF for extracting AMC/scheme from path
  firstPageText: string; // First 2-3 pages of text
  fullText?: string; // Optional, for deep extraction
}

/**
 * Month name to number mapping (0-indexed)
 */
const MONTH_MAP: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

/**
 * Doc type keywords for detection
 */
const DOC_TYPE_PATTERNS: Array<{ type: DocType; patterns: RegExp[] }> = [
  {
    type: "SID",
    patterns: [/\bSID\b/i, /Scheme\s+Information\s+Document/i],
  },
  {
    type: "KIM",
    patterns: [/\bKIM\b/i, /Key\s+Information\s+Memorandum/i],
  },
  {
    type: "Factsheet",
    patterns: [/\bFactsheet\b/i, /\bFact\s+Sheet\b/i],
  },
  {
    type: "AnnualReport",
    patterns: [/\bAnnual[_\-\s]?Report\b/i, /\bTrustee\s+Report\b/i],
  },
];

/**
 * Scheme type patterns
 */
const SCHEME_TYPE_PATTERNS: Array<{ type: NonNullable<SchemeType>; patterns: RegExp[] }> = [
  {
    type: "Equity",
    patterns: [/\bEquity\s+(Scheme|Fund)\b/i, /\bEquity\s+Fund\b/i],
  },
  {
    type: "Debt",
    patterns: [/\bDebt\s+(Scheme|Fund)\b/i, /\bFixed\s+Income\b/i],
  },
  {
    type: "Hybrid",
    patterns: [/\bHybrid\s+(Scheme|Fund)\b/i, /\bBalanced\b/i],
  },
  {
    type: "Solution",
    patterns: [/\bSolution\s+Oriented\b/i, /\bRetirement\s+(Fund|Scheme)\b/i, /\bChildren'?s?\b/i],
  },
  {
    type: "Other",
    patterns: [/\bIndex\s+Fund\b/i, /\bFund\s+of\s+Funds\b/i, /\bETF\b/i],
  },
];

/**
 * Scheme category patterns
 */
const CATEGORY_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  { category: "Large Cap", patterns: [/\bLarge\s*Cap\b/i] },
  { category: "Mid Cap", patterns: [/\bMid[\-\s]*Cap\b/i] },
  { category: "Small Cap", patterns: [/\bSmall\s*Cap\b/i] },
  { category: "Flexi Cap", patterns: [/\bFlexi\s*Cap\b/i] },
  { category: "Multi Cap", patterns: [/\bMulti\s*Cap\b/i] },
  { category: "Large & Mid Cap", patterns: [/\bLarge\s*[&and]\s*Mid\s*Cap\b/i] },
  { category: "ELSS", patterns: [/\bELSS\b/i, /\bEquity\s+Linked\s+Savings\b/i] },
  { category: "Sectoral/Thematic", patterns: [/\bSectoral\b/i, /\bThematic\b/i] },
  { category: "Value", patterns: [/\bValue\s*(Fund|Discovery)?\b/i] },
  { category: "Contra", patterns: [/\bContra\b/i] },
  { category: "Focused", patterns: [/\bFocused\b/i] },
  { category: "Dividend Yield", patterns: [/\bDividend\s+Yield\b/i] },
];

/**
 * ISIN regex pattern - INF followed by 9 alphanumeric characters
 */
const ISIN_PATTERN = /\bINF[A-Z0-9]{9}\b/g;

/**
 * Scheme/Fund code patterns
 */
const SCHEME_CODE_PATTERNS = [
  /\b(?:Scheme|Fund|AMFI)\s*Code\s*[:\-]?\s*(\d{4,6})\b/i,
];

/**
 * AMC name patterns - more specific to avoid over-matching
 */
const AMC_PATTERNS = [
  // Full AMC name patterns - require the company name to start with capital letter word
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+Asset\s+Management\s+Company(?:\s+(?:Limited|Ltd|Pvt\.?|Private))*)/g,
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+Funds\s+Management(?:\s+(?:Limited|Ltd|Pvt\.?|Private))*)/g,
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+AMC(?:\s+(?:Limited|Ltd))?)/g,
  /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+Mutual\s+Fund)\b/g,
];

/**
 * Extract AMC and scheme names from file path
 * Expected path: data/sebi-pdfs/{AMC_Name}/{Scheme_Name}.pdf
 */
function extractFromPath(filepath: string): {
  amcName: string | null;
  schemeName: string | null;
} {
  if (!filepath || !filepath.includes("/sebi-pdfs/")) {
    return { amcName: null, schemeName: null };
  }

  // Split path and find sebi-pdfs directory
  const parts = filepath.split("/");
  const sebiIndex = parts.findIndex((p) => p === "sebi-pdfs");

  if (sebiIndex === -1 || parts.length < sebiIndex + 3) {
    return { amcName: null, schemeName: null };
  }

  // AMC name is the folder after sebi-pdfs
  const amcFolder = parts[sebiIndex + 1];
  // Scheme name is the filename without extension
  const schemeFile = parts[parts.length - 1];

  // Convert folder name to readable AMC name
  // "Tata_Mutual_Fund" → "Tata Mutual Fund"
  const amcName = amcFolder
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract scheme name from filename (remove .pdf)
  const schemeName = schemeFile.replace(/\.pdf$/i, "").trim();

  return {
    amcName: amcName || null,
    schemeName: schemeName || null,
  };
}

/**
 * Extracts fund name from filename
 */
function extractFundNameFromFilename(filename: string): string | null {
  if (!filename || filename.length < 5) {
    return null;
  }

  // Remove extension
  let name = filename.replace(/\.pdf$/i, "");

  // Remove doc type indicators first (before date patterns, as they may be adjacent)
  name = name.replace(/[-_]?(?:SID|KIM|Factsheet|Fact[_\-]?Sheet|Annual[_\-]?Report)[-_]?/gi, "_");

  // Remove date patterns - be more aggressive with month names anywhere in filename
  name = name.replace(/[-_]?(?:January|February|March|April|May|June|July|August|September|October|November|December)[-_]?\d{4}[-_]?/gi, "_");
  name = name.replace(/[-_]?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[-_]?\d{4}[-_]?/gi, "_");
  name = name.replace(/[-_]?Q[1-4][-_]?\d{4}[-_]?/gi, "_");
  name = name.replace(/[-_]?\d{4}[-_]\d{1,2}[-_]?/g, "_");
  name = name.replace(/[-_]?\d{4}[-_]?\d{2}[-_]?$/g, "_");

  // Remove standalone year at end
  name = name.replace(/[-_]?\d{4}[-_]?$/g, "");

  // Remove any leftover month names not followed by year (e.g., just "March" at end)
  name = name.replace(/[-_]?(?:January|February|March|April|May|June|July|August|September|October|November|December)[-_]?$/gi, "");
  name = name.replace(/[-_]?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[-_]?$/gi, "");

  // Determine if filename primarily uses dashes or underscores as separators
  const dashCount = (name.match(/-/g) || []).length;
  const underscoreCount = (name.match(/_/g) || []).length;

  if (underscoreCount > dashCount) {
    // Primarily underscore-separated: convert underscores to spaces, preserve hyphens in compound words
    name = name.replace(/_+/g, " ");
    // Remove hyphens at word boundaries (adjacent to spaces or at start/end)
    name = name.replace(/(^-|-$|\s-|-\s)/g, " ");
  } else {
    // Primarily dash-separated or equal: convert all separators to spaces
    name = name.replace(/[_-]+/g, " ");
  }

  // Clean up whitespace
  name = name.replace(/\s+/g, " ").trim();

  // Check if we have something meaningful (at least 3 chars and contains letter)
  if (name.length < 3 || !/[a-zA-Z]/.test(name)) {
    return null;
  }

  // If the result is just a generic word like "document", return null
  if (/^(document|file|pdf)$/i.test(name)) {
    return null;
  }

  return name;
}

/**
 * Extracts doc type from filename
 */
function extractDocTypeFromFilename(filename: string): DocType | null {
  // Use case-insensitive patterns that handle underscores and dashes as word boundaries
  if (/[_\-]SID[_\-]|[_\-]SID\.|^SID[_\-]|[_\-]SID$/i.test(filename)) return "SID";
  if (/[_\-]KIM[_\-]|[_\-]KIM\.|^KIM[_\-]|[_\-]KIM$/i.test(filename)) return "KIM";
  if (/FACTSHEET|FACT[_\-]?SHEET/i.test(filename)) return "Factsheet";
  if (/ANNUAL[_\-]?REPORT/i.test(filename)) return "AnnualReport";

  return null;
}

/**
 * Extracts doc type from content
 */
function extractDocTypeFromContent(text: string): DocType {
  for (const { type, patterns } of DOC_TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return type;
      }
    }
  }
  return "Unknown";
}

/**
 * Extracts document date from filename
 */
function extractDateFromFilename(filename: string): Date | null {
  // Try YYYY-MM pattern
  const yearMonthMatch = filename.match(/(\d{4})[-_](\d{1,2})/);
  if (yearMonthMatch) {
    const year = parseInt(yearMonthMatch[1], 10);
    const month = parseInt(yearMonthMatch[2], 10) - 1;
    if (year >= 2000 && year <= 2100 && month >= 0 && month <= 11) {
      return new Date(year, month, 1);
    }
  }

  // Try Month-YYYY or Month_YYYY pattern (abbreviated)
  const monthYearMatch = filename.match(/[-_]?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[-_]?(\d{4})/i);
  if (monthYearMatch) {
    const monthName = monthYearMatch[1].toLowerCase();
    const year = parseInt(monthYearMatch[2], 10);
    const month = MONTH_MAP[monthName];
    if (month !== undefined && year >= 2000 && year <= 2100) {
      return new Date(year, month, 1);
    }
  }

  // Try full month name
  const fullMonthMatch = filename.match(/[-_]?(January|February|March|April|May|June|July|August|September|October|November|December)[-_]?(\d{4})/i);
  if (fullMonthMatch) {
    const monthName = fullMonthMatch[1].toLowerCase();
    const year = parseInt(fullMonthMatch[2], 10);
    const month = MONTH_MAP[monthName];
    if (month !== undefined && year >= 2000 && year <= 2100) {
      return new Date(year, month, 1);
    }
  }

  return null;
}

/**
 * Extracts fund/scheme name from content
 */
function extractFundNameFromContent(text: string): string | null {
  // Normalize whitespace
  const normalized = text.replace(/\s+/g, " ");

  // Pattern 1: "Name of the Scheme: XYZ Fund"
  const schemeNamePattern = /Name\s+of\s+the\s+Scheme\s*[:\-]?\s*([A-Z][A-Za-z\s&]+(?:Fund|Scheme))/i;
  let match = normalized.match(schemeNamePattern);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Pattern 2: "I. Name of the Scheme XYZ Fund"
  const schemePattern2 = /I\.\s+Name\s+of\s+the\s+Scheme\s+([A-Z][A-Za-z\s&]+(?:Fund|Scheme))/i;
  match = normalized.match(schemePattern2);
  if (match && match[1]) {
    return match[1].trim();
  }

  // Pattern 3: All caps fund name in title (e.g., "CAPITALMIND FLEXI CAP FUND")
  // Match 1-5 capitalized words followed by fund type, then "FUND" or "SCHEME"
  const titleSection = normalized.substring(0, 600);
  const allCapsFundPattern = /\b([A-Z]{2,}(?:\s+[A-Z]{2,}){0,4}\s+(?:FLEXI\s*CAP|MULTI\s*CAP|LARGE\s*CAP|MID\s*CAP|SMALL\s*CAP|BLUE\s*CHIP|BANKING|PSU|EQUITY|DEBT|HYBRID|BALANCED|VALUE|GROWTH|INCOME)\s+(?:FUND|SCHEME))\b/;
  match = titleSection.match(allCapsFundPattern);
  if (match && match[1]) {
    // Convert to title case for consistency
    return match[1]
      .toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  // Pattern 4: Title case fund name (e.g., "Canara Robeco Blue Chip Equity Fund")
  const fundNamePattern = /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,4}\s+(?:Equity|Debt|Hybrid|Flexi\s*Cap|Multi\s*Cap|Large\s*Cap|Mid\s*Cap|Small\s*Cap|Blue\s*Chip|Value|Growth|Income|Balanced)\s+(?:Fund|Scheme))\b/;
  match = titleSection.match(fundNamePattern);
  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Extracts AMC name from content
 */
function extractAMCName(text: string): string | null {
  // Normalize excessive whitespace
  const normalized = text.replace(/\s+/g, " ");

  // Pattern 1: "Name of the Asset Management Company: XYZ"
  const amcLabelPattern = /Name\s+of\s+the\s+Asset\s+Management\s+Company\s*[:\-]?\s*([A-Z][A-Za-z\s]+Asset\s+Management\s+Company(?:\s+(?:Ltd|Limited|Pvt\.?))?\.?)/i;
  let match = normalized.match(amcLabelPattern);
  if (match && match[1]) {
    return match[1].trim().replace(/\.$/, ''); // Remove trailing period
  }

  // Pattern 2: Standalone AMC name (full caps or title case)
  for (const pattern of AMC_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    match = pattern.exec(normalized);
    if (match && match[1]) {
      const amcName = match[1].trim();
      // Filter out header junk like "ARN AMFI Registration Number Asset Management Company"
      if (!amcName.includes("ARN") && !amcName.includes("AMFI Registration") && !amcName.includes("Registration Number")) {
        return amcName;
      }
    }
  }

  return null;
}

/**
 * Extracts scheme type from content
 */
function extractSchemeType(text: string): SchemeType {
  for (const { type, patterns } of SCHEME_TYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return type;
      }
    }
  }
  return null;
}

/**
 * Extracts scheme category from content
 */
function extractSchemeCategory(text: string): string | null {
  // Check Large & Mid Cap first (more specific)
  if (/\bLarge\s*[&and]+\s*Mid\s*Cap\b/i.test(text)) {
    return "Large & Mid Cap";
  }

  for (const { category, patterns } of CATEGORY_PATTERNS) {
    // Skip Large & Mid Cap here as we already checked
    if (category === "Large & Mid Cap") continue;

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return category;
      }
    }
  }

  return null;
}

/**
 * Extracts ISINs from content
 */
function extractISINs(text: string): { growth: string | null; dividend: string | null } {
  // Reset global pattern
  ISIN_PATTERN.lastIndex = 0;
  const allISINs = text.match(ISIN_PATTERN) || [];

  // Preserve order - use array to track first occurrence
  const seenISINs = new Set<string>();
  const orderedUniqueISINs: string[] = [];
  for (const isin of allISINs) {
    if (!seenISINs.has(isin)) {
      seenISINs.add(isin);
      orderedUniqueISINs.push(isin);
    }
  }

  if (orderedUniqueISINs.length === 0) {
    return { growth: null, dividend: null };
  }

  // Try to identify growth vs dividend/IDCW by looking at context
  let growthISIN: string | null = null;
  let dividendISIN: string | null = null;

  // Look for labeled ISINs - require clear context like "Growth:" or "IDCW:" or table headers
  // Avoid matching "Growth Fund" as that's a fund name, not a label
  // Pattern: label followed by ISIN (more reliable)
  const growthPattern = /(?:^|\s)(?:Growth|Direct\s+Growth)\s*[:\-]?\s*(INF[A-Z0-9]{9})/im;
  const dividendPattern = /(?:^|\s)(?:IDCW|Dividend|Direct\s+IDCW)\s*[:\-]?\s*(INF[A-Z0-9]{9})/im;
  // Pattern: ISIN followed by label in same cell/context (requires clear separator)
  const growthPattern2 = /(INF[A-Z0-9]{9})\s+(?:Growth)(?:\s|$)/i;
  const dividendPattern2 = /(INF[A-Z0-9]{9})\s+(?:IDCW|Dividend)(?:\s|$)/i;

  const growthMatch = text.match(growthPattern) || text.match(growthPattern2);
  const dividendMatch = text.match(dividendPattern) || text.match(dividendPattern2);

  if (growthMatch) {
    growthISIN = growthMatch[1];
  }
  if (dividendMatch) {
    dividendISIN = dividendMatch[1];
  }

  // If we found labeled ISINs, return them
  if (growthISIN || dividendISIN) {
    // Fill in missing with first unassigned ISIN
    if (!growthISIN && orderedUniqueISINs.length > 0) {
      growthISIN = orderedUniqueISINs.find((isin) => isin !== dividendISIN) || null;
    }
    if (!dividendISIN && orderedUniqueISINs.length > 1) {
      dividendISIN = orderedUniqueISINs.find((isin) => isin !== growthISIN) || null;
    }
    return { growth: growthISIN, dividend: dividendISIN };
  }

  // No labels found - assign first ISIN to growth (preserve order)
  return {
    growth: orderedUniqueISINs[0] || null,
    dividend: orderedUniqueISINs.length > 1 ? orderedUniqueISINs[1] : null,
  };
}

/**
 * Extracts scheme code from content
 */
function extractSchemeCode(text: string): string | null {
  for (const pattern of SCHEME_CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Main metadata extraction function
 *
 * Extracts metadata for FILTERING during retrieval.
 * All content gets indexed regardless of what metadata is extracted.
 *
 * @param input - MetadataInput containing filename and text content
 * @returns ExtractedMetadata object with all extracted fields
 */
export function extractMetadata(input: MetadataInput): ExtractedMetadata {
  const { filename, filepath, firstPageText, fullText } = input;

  // PRIORITY 1: Extract from file path (most reliable)
  const pathInfo = filepath ? extractFromPath(filepath) : { amcName: null, schemeName: null };

  // PRIORITY 2: Extract from filename
  const fundNameFromFilename = extractFundNameFromFilename(filename);
  const filenameDocType = extractDocTypeFromFilename(filename);
  const documentDate = extractDateFromFilename(filename);

  // PRIORITY 3: Extract from content (fallback only)
  const fundNameFromContent = extractFundNameFromContent(firstPageText);
  const contentDocType = extractDocTypeFromContent(firstPageText);
  const amcNameFromContent = extractAMCName(firstPageText);
  const schemeType = extractSchemeType(firstPageText);
  const schemeCategory = extractSchemeCategory(firstPageText);

  // Use fullText for ISINs and codes (might appear later in document)
  const searchTextForIds = fullText || firstPageText;
  const { growth: isinGrowth, dividend: isinDividend } = extractISINs(searchTextForIds);
  const schemeCode = extractSchemeCode(searchTextForIds);

  // Fund name priority: path > filename > content
  const fundName = pathInfo.schemeName || fundNameFromFilename || fundNameFromContent;

  // AMC name priority: path > content
  // NOTE: Path-based AMC name is most reliable (from folder structure)
  const amcName = pathInfo.amcName || amcNameFromContent;

  // Doc type: filename takes precedence over content
  const docType = filenameDocType || contentDocType;

  return {
    fundName,
    docType,
    documentDate,
    amcName,
    schemeType,
    schemeCategory,
    isinGrowth,
    isinDividend,
    schemeCode,
  };
}
