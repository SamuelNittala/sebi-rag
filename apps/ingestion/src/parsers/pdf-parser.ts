/**
 * PDF Text Extraction using unpdf
 *
 * Extracts text from PDFs page-by-page with:
 * - Page number tracking
 * - Header/footer pattern removal
 * - Table detection hints
 * - Encoding issue handling
 */

import { getDocumentProxy, extractText } from "unpdf";
import { basename } from "node:path";

/**
 * Represents a single parsed page from a PDF
 */
export interface ParsedPage {
  /** 1-indexed page number */
  pageNumber: number;
  /** Extracted text content with headers/footers removed */
  text: string;
  /** Hint for downstream processing - true if page likely contains a table */
  hasTable: boolean;
}

/**
 * Represents a fully parsed PDF document
 */
export interface ParsedPDF {
  /** Original filename (without path) */
  filename: string;
  /** Full file path as provided */
  filepath: string;
  /** Total number of pages in the document */
  pageCount: number;
  /** Array of parsed pages with text and metadata */
  pages: ParsedPage[];
  /** All pages concatenated with page separators */
  rawText: string;
}

/**
 * Header/footer patterns to remove from extracted text
 */
const HEADER_FOOTER_PATTERNS: RegExp[] = [
  // Page number patterns
  /^Page\s+\d+\s+of\s+\d+\s*$/gim,
  /^-\s*\d+\s*-\s*$/gm,
  /^\s*\d+\s*$/gm, // Standalone numbers at start/end of page

  // Common footer patterns
  /^Confidential\s*$/gim,
  /^For private circulation only\s*$/gim,

  // URL patterns often in footers
  /^https?:\/\/[^\s]+\s*$/gim,
];

/**
 * Patterns that indicate a page likely contains a table
 */
const TABLE_INDICATORS = {
  // Pipe characters used in markdown/ascii tables
  pipeCount: (text: string): number => (text.match(/\|/g) || []).length,

  // Tab characters often indicate columnar data
  hasTabSeparators: (text: string): boolean => /\t/.test(text),

  // Multiple consecutive spaces suggesting column alignment
  hasColumnAlignment: (text: string): boolean => /\S\s{3,}\S+\s{3,}\S/.test(text),

  // Common table header patterns in financial docs
  hasTableHeaders: (text: string): boolean =>
    /\b(Particulars|Amount|Percentage|Rs\.|Cr\.|Lakhs|Units|NAV)\b/i.test(text) &&
    /\s{2,}/.test(text),
};

/**
 * Detects if a page likely contains tabular data
 */
function detectTable(text: string): boolean {
  // Multiple pipe characters strongly indicate a table
  if (TABLE_INDICATORS.pipeCount(text) >= 3) {
    return true;
  }

  // Tab separators with multiple occurrences
  if (TABLE_INDICATORS.hasTabSeparators(text)) {
    const tabCount = (text.match(/\t/g) || []).length;
    if (tabCount >= 5) {
      return true;
    }
  }

  // Column alignment patterns
  if (TABLE_INDICATORS.hasColumnAlignment(text)) {
    // Check if there are multiple lines with similar patterns
    const lines = text.split("\n");
    let alignedLines = 0;
    for (const line of lines) {
      if (/\S\s{3,}\S/.test(line)) {
        alignedLines++;
      }
    }
    if (alignedLines >= 3) {
      return true;
    }
  }

  // Financial table headers with spacing
  if (TABLE_INDICATORS.hasTableHeaders(text)) {
    return true;
  }

  return false;
}

/**
 * Removes common header/footer patterns from page text
 */
function removeHeadersFooters(text: string, pageNumber: number, totalPages: number): string {
  let cleaned = text;

  // Apply all header/footer patterns
  for (const pattern of HEADER_FOOTER_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Remove specific page number for this page
  const specificPagePatterns = [
    new RegExp(`^Page\\s+${pageNumber}\\s+of\\s+${totalPages}\\s*$`, "gim"),
    new RegExp(`^-\\s*${pageNumber}\\s*-\\s*$`, "gm"),
  ];

  for (const pattern of specificPagePatterns) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Remove standalone page number at boundaries (first/last non-empty lines)
  const lines = cleaned.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip standalone numbers that look like page numbers
    // (single number, or number matching current page)
    if (/^\d{1,3}$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      // Skip if it's a reasonable page number
      if (num === pageNumber || num <= totalPages + 10) {
        // Check context - if surrounded by empty or very short lines, likely page number
        const prevEmpty = i === 0 || lines[i - 1].trim().length < 5;
        const nextEmpty = i === lines.length - 1 || lines[i + 1].trim().length < 5;
        if (prevEmpty || nextEmpty) {
          continue; // Skip this line
        }
      }
    }

    result.push(lines[i]);
  }

  // Clean up excessive whitespace
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
    .trim();
}

/**
 * Handles encoding issues in extracted text
 */
function cleanText(text: string): string {
  return (
    text
      // Replace common encoding artifacts
      .replace(/\ufffd/g, "") // Replacement character
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // Control characters except tab, newline, carriage return
      // Normalize whitespace
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      // Fix common ligature issues
      .replace(/ﬁ/g, "fi")
      .replace(/ﬂ/g, "fl")
      .replace(/ﬀ/g, "ff")
      .replace(/ﬃ/g, "ffi")
      .replace(/ﬄ/g, "ffl")
  );
}

/**
 * Parses a PDF file and extracts text page-by-page
 *
 * @param filepath - Path to the PDF file
 * @returns ParsedPDF object with extracted text and metadata
 * @throws Error if file doesn't exist or is invalid/corrupted
 */
export async function parsePDF(filepath: string): Promise<ParsedPDF> {
  // Read the file
  const file = Bun.file(filepath);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`PDF file not found: ${filepath}`);
  }

  const buffer = await file.arrayBuffer();

  if (buffer.byteLength === 0) {
    throw new Error(`PDF file is empty: ${filepath}`);
  }

  // Load PDF document
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse PDF (invalid or corrupted): ${filepath} - ${message}`);
  }

  const totalPages = pdf.numPages;
  const filename = basename(filepath);

  // Extract text page by page using unpdf's extractText with mergePages: false
  const { text: pageTexts } = await extractText(pdf, { mergePages: false });

  // Ensure we have an array of strings
  const textArray = Array.isArray(pageTexts) ? pageTexts : [pageTexts];

  // Process each page
  const pages: ParsedPage[] = [];
  const rawTextParts: string[] = [];

  for (let i = 0; i < totalPages; i++) {
    const rawPageText = textArray[i] || "";
    const pageNumber = i + 1;

    // Clean encoding issues
    let pageText = cleanText(rawPageText);

    // Remove headers/footers
    pageText = removeHeadersFooters(pageText, pageNumber, totalPages);

    // Detect if page contains a table
    const hasTable = detectTable(pageText);

    pages.push({
      pageNumber,
      text: pageText,
      hasTable,
    });

    if (pageText.trim().length > 0) {
      rawTextParts.push(`--- Page ${pageNumber} ---\n${pageText}`);
    }
  }

  // Concatenate all pages with separators
  const rawText = rawTextParts.join("\n\n");

  return {
    filename,
    filepath,
    pageCount: totalPages,
    pages,
    rawText,
  };
}
