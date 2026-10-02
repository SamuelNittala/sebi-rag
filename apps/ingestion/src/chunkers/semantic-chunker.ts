/**
 * Semantic Chunker for MF-RAG System
 *
 * Splits parsed PDF content into chunks optimal for RAG retrieval.
 * Respects semantic boundaries (sections, paragraphs, sentences)
 * and preserves atomic units (tables, lists).
 */

import { type CandidateChunkMetadata, type ChunkConfig, DEFAULT_CHUNK_CONFIG } from "@mf-rag/types";

/**
 * Input format for chunking
 */
export interface ChunkInput {
  pages: Array<{
    pageNumber: number;
    text: string;
  }>;
  tables?: Array<{
    pageNumber: number;
    markdown: string;
  }>;
}

/**
 * A single chunk of content
 */
export interface Chunk {
  text: string;
  chunkIndex: number;
  pageNumbers: number[];
  hasTable: boolean;
  sectionHeader: string | null;
  tokenCount: number;
  /** Per-chunk metadata merged over the document metadata (set by the Docling mapper). */
  metadata?: Partial<CandidateChunkMetadata>;
}

/**
 * Result of chunking operation
 */
export interface ChunkResult {
  chunks: Chunk[];
  totalChunks: number;
  totalTokens: number;
}

/**
 * Internal representation of a content segment with metadata
 */
interface ContentSegment {
  text: string;
  pageNumber: number;
  isTable: boolean;
  sectionHeader: string | null;
}

// Re-export config for convenience
export { DEFAULT_CHUNK_CONFIG };
export type { ChunkConfig };

/**
 * Estimates token count using word-based approximation.
 * tokens ~ words * 1.3
 */
export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const wordCount = trimmed.split(/\s+/).length;
  return Math.round(wordCount * 1.3);
}

/**
 * Patterns that indicate a section boundary (split BEFORE these)
 * Note: These patterns need multiline flag for ^ to match start of lines
 */
const SECTION_BOUNDARY_PATTERNS: RegExp[] = [
  // SECTION I, SECTION II, etc.
  /^SECTION\s+[IVXLCDM]+\b/m,
  // Part I, Part II, etc.
  /^Part\s+[IVXLCDM]+\b/im,
  // Numbered sections: 1., 2., A., B. (must be at start of line after newline)
  /(?:^|\n)([1-9]\d{0,2}\.\s+\S)/,
  /(?:^|\n)([A-Z]\.\s+\S)/,
  // Roman-numbered subsections: VIII. Subscription, IX. Redemption, etc.
  /(?:^|\n)([IVXLCDM]+\.\s+\S)/,
  // Markdown headers
  /^#{2,}\s+\S/m,
  // All-caps headings (at least 3 words)
  /^[A-Z][A-Z\s]{10,}$/m,
];

const KIM_LABEL_HEADINGS = [
  "Investment objective",
  "Investment Approach",
  "Risk Profile of the Investment Strategy",
  "Minimum Investment Threshold",
  "Load Structure",
  "Unitholders’ Information",
  "Unitholders' Information",
  "Performance Track Record",
  "Fund Manager",
] as const;

function normalizeHeading(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractKimLabelHeading(text: string): string | null {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const candidates = [lines[0] ?? "", `${lines[0] ?? ""} ${lines[1] ?? ""}`]
    .map(normalizeHeading);

  for (const candidate of candidates) {
    const known = KIM_LABEL_HEADINGS.find(
      (heading) => heading.toLowerCase() === candidate.toLowerCase()
    );
    if (known) return candidate;
  }

  return null;
}

function findKimLabelBoundaries(text: string): number[] {
  const positions: number[] = [];
  for (const heading of KIM_LABEL_HEADINGS) {
    const words = heading.split(/\s+/).map(
      (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    );
    const pattern = new RegExp(`^${words.join("\\s+")}[ \\t]*$`, "gim");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > 0) positions.push(match.index);
    }
  }
  return positions;
}

/**
 * Patterns for noise removal (page numbers, etc.)
 */
const NOISE_PATTERNS: RegExp[] = [
  // Page X of Y
  /^Page\s+\d+\s+of\s+\d+\s*$/gim,
  // - X -
  /^-\s*\d+\s*-\s*$/gm,
  // Standalone numbers at line boundaries
  /^\s*\d{1,3}\s*$/gm,
];

/**
 * Detects if text starts with a section header and extracts it
 */
function extractSectionHeader(text: string): string | null {
  const lines = text.trim().split("\n");
  const firstLine = lines[0]?.trim() || "";

  const kimLabel = extractKimLabelHeading(text);
  if (kimLabel) return kimLabel;

  // Check for SECTION headers
  if (/^SECTION\s+[IVXLCDM]+/i.test(firstLine)) {
    return firstLine;
  }

  // Check for Part headers
  if (/^Part\s+[IVXLCDM]+/i.test(firstLine)) {
    return firstLine;
  }

  // Check for numbered sections (1., 2., etc.)
  if (/^[1-9]\d{0,2}\.\s+\S/.test(firstLine)) {
    return firstLine;
  }

  // Check for lettered sections (A., B., etc.)
  if (/^[A-Z]\.\s+\S/.test(firstLine)) {
    return firstLine;
  }

  // Check for Roman-numbered subsections (VIII., IX., etc.)
  if (/^[IVXLCDM]+\.\s+\S/.test(firstLine)) {
    return firstLine;
  }

  // Check for markdown headers
  if (/^#{2,}\s+/.test(firstLine)) {
    return firstLine.replace(/^#+\s*/, "");
  }

  // Check for all-caps headers
  if (/^[A-Z][A-Z\s]{10,}$/.test(firstLine) && firstLine.split(/\s+/).length >= 2) {
    return firstLine;
  }

  return null;
}

/**
 * Removes noise patterns from text
 */
function removeNoise(text: string): string {
  let cleaned = text;

  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Normalize excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}

/**
 * Finds the best split point near the target position.
 * Prioritizes: section boundaries > paragraph breaks > sentence ends > word breaks
 */
function findBestSplitPoint(
  text: string,
  targetPos: number,
  maxPos: number
): number {
  // Look for section boundaries first
  for (const pattern of SECTION_BOUNDARY_PATTERNS) {
    const searchRegion = text.slice(Math.max(0, targetPos - 50), maxPos);
    const match = searchRegion.match(pattern);
    if (match && match.index !== undefined) {
      const absolutePos = Math.max(0, targetPos - 50) + match.index;
      if (absolutePos > 0 && absolutePos <= maxPos) {
        return absolutePos;
      }
    }
  }

  // Look for paragraph break (double newline)
  const paragraphBreak = text.lastIndexOf("\n\n", maxPos);
  if (paragraphBreak > targetPos * 0.7 && paragraphBreak > 0) {
    return paragraphBreak + 2; // After the double newline
  }

  // Look for sentence end
  const sentenceEnders = /[.!?]["')]*\s+/g;
  let lastSentenceEnd = -1;
  let match;

  while ((match = sentenceEnders.exec(text)) !== null) {
    if (match.index + match[0].length <= maxPos) {
      lastSentenceEnd = match.index + match[0].length;
    } else {
      break;
    }
  }

  if (lastSentenceEnd > targetPos * 0.7 && lastSentenceEnd > 0) {
    return lastSentenceEnd;
  }

  // Fall back to word boundary
  const wordBoundary = text.lastIndexOf(" ", maxPos);
  if (wordBoundary > 0) {
    return wordBoundary + 1;
  }

  // Last resort: use max position
  return maxPos;
}

/**
 * Splits text at section boundaries
 */
function splitAtSectionBoundaries(text: string): string[] {
  const segments: string[] = [];
  let currentPos = 0;

  // Find all section boundary positions
  const boundaryPositions: number[] = [];
  boundaryPositions.push(...findKimLabelBoundaries(text));

  // Special handling for numbered sections (1., 2., etc.)
  const numberedSectionPattern = /\n([1-9]\d*\.\s+\S)/g;
  let numMatch;
  while ((numMatch = numberedSectionPattern.exec(text)) !== null) {
    // Position is at the newline, we want to split after the newline
    boundaryPositions.push(numMatch.index + 1);
  }

  // Special handling for lettered sections (A., B., etc.)
  const letteredSectionPattern = /\n([A-Z]\.\s+\S)/g;
  let letMatch;
  while ((letMatch = letteredSectionPattern.exec(text)) !== null) {
    boundaryPositions.push(letMatch.index + 1);
  }

  for (const pattern of SECTION_BOUNDARY_PATTERNS) {
    // Skip the numbered/lettered patterns we already handled
    if (pattern.source.includes("1-9") || pattern.source.includes("A-Z]\\.")) {
      continue;
    }

    // Create a new regex with global and multiline flags
    const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
    const globalPattern = new RegExp(pattern.source, flags.includes("m") ? flags : flags + "m");
    let match;

    while ((match = globalPattern.exec(text)) !== null) {
      if (match.index > 0) {
        boundaryPositions.push(match.index);
      }
    }
  }

  // Sort and deduplicate
  const uniqueBoundaries = [...new Set(boundaryPositions)].sort((a, b) => a - b);

  // Split at boundaries
  for (const pos of uniqueBoundaries) {
    if (pos > currentPos) {
      const segment = text.slice(currentPos, pos).trim();
      if (segment) {
        segments.push(segment);
      }
      currentPos = pos;
    }
  }

  // Add remaining text
  if (currentPos < text.length) {
    const segment = text.slice(currentPos).trim();
    if (segment) {
      segments.push(segment);
    }
  }

  return segments.length > 0 ? segments : [text];
}

/**
 * Estimates position in text for a given token count
 */
function estimatePositionForTokens(text: string, targetTokens: number): number {
  if (targetTokens <= 0 || !text) return 0;
  if (estimateTokenCount(text) <= targetTokens) return text.length;

  // The estimator is word-based, so a fixed average character width can
  // overshoot badly for dense, short-token PDF text. Find the greatest
  // character prefix that actually satisfies the same estimator instead.
  let low = 1;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokenCount(text.slice(0, middle)) <= targetTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Gets overlap text from the end of a chunk
 */
function getOverlapText(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";

  const words = text.trim().split(/\s+/);
  const targetWords = Math.ceil(overlapTokens / 1.3);

  if (targetWords >= words.length) return text;

  // Take last N words
  const overlapWords = words.slice(-targetWords);
  let overlap = overlapWords.join(" ");

  // Try to start at a sentence boundary
  const sentenceStart = overlap.search(/[.!?]["')]*\s+[A-Z]/);
  if (sentenceStart > 0 && sentenceStart < overlap.length * 0.5) {
    overlap = overlap.slice(sentenceStart + 1).trim();
    // Find the actual start of the next sentence
    const nextCapital = overlap.search(/[A-Z]/);
    if (nextCapital >= 0) {
      overlap = overlap.slice(nextCapital);
    }
  }

  return overlap;
}

/**
 * Processes tables and associates them with context
 */
function processTablesWithContext(
  pages: ChunkInput["pages"],
  tables: ChunkInput["tables"] | undefined
): ContentSegment[] {
  if (!tables || tables.length === 0) {
    return [];
  }

  const segments: ContentSegment[] = [];

  for (const table of tables) {
    // Find the page this table belongs to
    const page = pages.find((p) => p.pageNumber === table.pageNumber);
    let context = "";

    if (page) {
      // Extract potential context (text before the table on the same page)
      const pageText = page.text;
      // Look for table-related context in the last few sentences
      const sentences = pageText.split(/[.!?]+/).filter((s) => s.trim());
      const lastSentences = sentences.slice(-3).join(". ");

      // Check if it mentions table-related keywords
      if (/table|shows?|lists?|following|below|summary|overview/i.test(lastSentences)) {
        context = lastSentences.trim();
        if (context && !context.endsWith(".")) {
          context += ".";
        }
        context += "\n\n";
      }
    }

    segments.push({
      text: `[TABLE]\n${context}${table.markdown}`,
      pageNumber: table.pageNumber,
      isTable: true,
      sectionHeader: null,
    });
  }

  return segments;
}

/**
 * Split an oversized Markdown table between complete rows. The table marker,
 * contextual title, header, and separator are repeated in every child so each
 * child remains independently retrievable. A single oversized row is retained
 * intact rather than silently losing cells.
 */
function splitTableRows(tableText: string, maxTokens: number): string[] {
  const lines = tableText.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim().startsWith("|"));
  if (headerIndex < 0 || headerIndex + 2 >= lines.length) return [tableText];

  const prefix = lines.slice(0, headerIndex);
  const header = lines.slice(headerIndex, headerIndex + 2);
  const rows = lines.slice(headerIndex + 2).filter((line) => line.trim());
  if (rows.length === 0) return [tableText];

  const base = [...prefix, ...header];
  const children: string[] = [];
  let currentRows: string[] = [];

  for (const row of rows) {
    const candidate = [...base, ...currentRows, row].join("\n");
    if (currentRows.length > 0 && estimateTokenCount(candidate) > maxTokens) {
      children.push([...base, ...currentRows].join("\n"));
      currentRows = [row];
      continue;
    }
    currentRows.push(row);
  }

  if (currentRows.length > 0) {
    children.push([...base, ...currentRows].join("\n"));
  }

  return children;
}

/**
 * Main chunking function
 */
export function semanticChunk(
  input: ChunkInput,
  configOverrides?: Partial<ChunkConfig>
): ChunkResult {
  const config: ChunkConfig = {
    ...DEFAULT_CHUNK_CONFIG,
    ...configOverrides,
  };

  // Handle empty input
  if (!input.pages || input.pages.length === 0) {
    return { chunks: [], totalChunks: 0, totalTokens: 0 };
  }

  // Combine all page text with page markers
  interface PagedText {
    text: string;
    pageNumber: number;
  }

  const pagedTexts: PagedText[] = input.pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      text: removeNoise(p.text),
      pageNumber: p.pageNumber,
    }));

  if (pagedTexts.length === 0 && (!input.tables || input.tables.length === 0)) {
    return { chunks: [], totalChunks: 0, totalTokens: 0 };
  }

  // Process tables first
  const tableSegments = processTablesWithContext(input.pages, input.tables);

  // Build content segments from pages
  const pageSegments: ContentSegment[] = [];

  for (const pt of pagedTexts) {
    // Split page text at section boundaries
    const sections = splitAtSectionBoundaries(pt.text);

    for (const section of sections) {
      if (section.trim()) {
        pageSegments.push({
          text: section,
          pageNumber: pt.pageNumber,
          isTable: false,
          sectionHeader: extractSectionHeader(section),
        });
      }
    }
  }

  // Merge all segments and sort by page number
  const allSegments = [...pageSegments, ...tableSegments].sort(
    (a, b) => a.pageNumber - b.pageNumber
  );

  // Build chunks
  const chunks: Chunk[] = [];
  let currentText = "";
  let currentPages: Set<number> = new Set();
  let currentSectionHeader: string | null = null;
  let currentIsTable = false;

  const flushChunk = (forceSmall = false) => {
    const text = currentText.trim();
    if (!text) return;

    const tokenCount = estimateTokenCount(text);

    // Skip if too small (unless it's the final chunk or forced)
    if (!forceSmall && tokenCount < config.minTokens && !currentIsTable) {
      return; // Don't flush, accumulate more
    }

    chunks.push({
      text,
      chunkIndex: chunks.length,
      pageNumbers: [...currentPages].sort((a, b) => a - b),
      hasTable: currentIsTable,
      sectionHeader: currentSectionHeader,
      tokenCount,
    });

    currentText = "";
    currentPages = new Set();
    currentSectionHeader = null;
    currentIsTable = false;
  };

  for (const segment of allSegments) {
    if (segment.isTable) {
      // Flush any accumulated text first
      if (currentText.trim()) {
        flushChunk(true);
      }

      // Handle table as atomic unit
      const tableTokens = estimateTokenCount(segment.text);

      if (tableTokens <= config.tableMaxTokens) {
        // Table fits, create its own chunk
        currentText = segment.text;
        currentPages.add(segment.pageNumber);
        currentIsTable = true;
        currentSectionHeader = segment.sectionHeader;
        flushChunk(true);
      } else {
        // Preserve every row by emitting independently retrievable row groups.
        for (const tableChild of splitTableRows(segment.text, config.tableMaxTokens)) {
          currentText = tableChild;
          currentPages.add(segment.pageNumber);
          currentIsTable = true;
          currentSectionHeader = segment.sectionHeader;
          flushChunk(true);
        }
      }
    } else {
      // Handle text segment
      const segmentTokens = estimateTokenCount(segment.text);
      const currentTokens = estimateTokenCount(currentText);

      // Check if this segment starts with a section header
      const hasNewSection = segment.sectionHeader !== null;

      if (hasNewSection && currentText.trim()) {
        // Flush before new section
        flushChunk(true);
      }

      // If current + new exceeds target OR maxTokens, we need to split
      if (currentTokens + segmentTokens > config.targetTokens || currentTokens + segmentTokens > config.maxTokens) {
        if (currentText.trim()) {
          // Check if we should flush current or try to fit more
          if (currentTokens >= config.minTokens) {
            flushChunk();

            // Add overlap from previous chunk
            if (chunks.length > 0 && !chunks[chunks.length - 1].hasTable) {
              const overlap = getOverlapText(
                chunks[chunks.length - 1].text,
                config.overlapTokens
              );
              if (overlap) {
                currentText = overlap + " ";
              }
            }
          }
        }

        // Now handle the new segment
        const currentTokensAfterFlush = estimateTokenCount(currentText);

        if (segmentTokens + currentTokensAfterFlush <= config.maxTokens) {
          // Segment fits in current chunk (considering any overlap already added)
          currentText += (currentText ? "\n\n" : "") + segment.text;
          currentPages.add(segment.pageNumber);
          if (segment.sectionHeader) {
            currentSectionHeader = segment.sectionHeader;
          }
        } else {
          // Need to split the segment to respect maxTokens
          let remainingText = segment.text;

          while (remainingText.trim()) {
            const currentTokensNow = estimateTokenCount(currentText);
            const remainingTokens = estimateTokenCount(remainingText);
            const availableTokens = config.maxTokens - currentTokensNow;

            if (remainingTokens <= availableTokens) {
              // Rest fits in current chunk
              currentText += (currentText ? "\n\n" : "") + remainingText;
              currentPages.add(segment.pageNumber);
              if (segment.sectionHeader) {
                currentSectionHeader = segment.sectionHeader;
              }
              break;
            }

            // Calculate split points based on available space
            const targetTokensForSplit = Math.min(
              config.targetTokens - currentTokensNow,
              availableTokens
            );

            // Find split point
            const targetPos = estimatePositionForTokens(remainingText, Math.max(1, targetTokensForSplit));
            const maxPos = estimatePositionForTokens(remainingText, availableTokens);

            // Ensure we make progress
            const effectiveMaxPos = Math.max(1, Math.min(remainingText.length, maxPos));
            const effectiveTargetPos = Math.max(1, Math.min(targetPos, effectiveMaxPos));

            const splitPos = findBestSplitPoint(
              remainingText,
              effectiveTargetPos,
              effectiveMaxPos
            );

            // Ensure we actually split (avoid infinite loop)
            const actualSplitPos = splitPos > 0 ? splitPos : Math.min(remainingText.length, effectiveMaxPos);

            const chunk = remainingText.slice(0, actualSplitPos).trim();
            remainingText = remainingText.slice(actualSplitPos).trim();

            if (chunk) {
              currentText += (currentText ? "\n\n" : "") + chunk;
              currentPages.add(segment.pageNumber);
              if (segment.sectionHeader) {
                currentSectionHeader = segment.sectionHeader;
              }

              flushChunk(true);

              // Add overlap for next chunk
              if (chunks.length > 0 && !chunks[chunks.length - 1].hasTable) {
                const overlap = getOverlapText(
                  chunks[chunks.length - 1].text,
                  config.overlapTokens
                );
                if (overlap) {
                  currentText = overlap + " ";
                  currentPages.add(segment.pageNumber);
                }
              }
            }
          }
        }
      } else {
        // Fits in current chunk
        currentText += (currentText ? "\n\n" : "") + segment.text;
        currentPages.add(segment.pageNumber);
        if (segment.sectionHeader) {
          currentSectionHeader = segment.sectionHeader;
        }
      }
    }
  }

  // Flush remaining content
  if (currentText.trim()) {
    // Final chunk can be small
    const tokenCount = estimateTokenCount(currentText);
    chunks.push({
      text: currentText.trim(),
      chunkIndex: chunks.length,
      pageNumbers: [...currentPages].sort((a, b) => a - b),
      hasTable: currentIsTable,
      sectionHeader: currentSectionHeader,
      tokenCount,
    });
  }

  // Post-process: Merge chunks that are too short to avoid BGE-M3 NaN bug
  // Short chunks (< 150 chars) cause NaN errors in Ollama's bge-m3 model
  const MIN_CHUNK_LENGTH = 150;
  const mergedChunks: Chunk[] = [];

  const isHeadingOnly = (chunk: Chunk): boolean => Boolean(
    chunk.sectionHeader
      && normalizeHeading(chunk.text).toLowerCase()
        === normalizeHeading(chunk.sectionHeader).toLowerCase()
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (isHeadingOnly(chunk) && !chunk.hasTable) {
      const immediateNext = chunks[i + 1];
      if (immediateNext?.hasTable) {
        const candidateText = `${chunk.text}\n\n${immediateNext.text}`;
        if (estimateTokenCount(candidateText) <= config.tableMaxTokens) {
          mergedChunks.push({
            text: candidateText,
            chunkIndex: mergedChunks.length,
            pageNumbers: [...new Set([...chunk.pageNumbers, ...immediateNext.pageNumbers])]
              .sort((a, b) => a - b),
            hasTable: true,
            sectionHeader: chunk.sectionHeader,
            tokenCount: estimateTokenCount(candidateText),
          });
          i += 1;
          continue;
        }
      }

      let mergedText = chunk.text;
      let mergedPages = chunk.pageNumbers;
      let lastMergedIndex = i;

      while (lastMergedIndex + 1 < chunks.length) {
        const nextChunk = chunks[lastMergedIndex + 1];
        if (nextChunk.hasTable) break;
        const candidateText = `${mergedText}\n\n${nextChunk.text}`;
        if (estimateTokenCount(candidateText) > config.maxTokens) break;

        mergedText = candidateText;
        mergedPages = [...new Set([...mergedPages, ...nextChunk.pageNumbers])]
          .sort((a, b) => a - b);
        lastMergedIndex += 1;
        if (!isHeadingOnly(nextChunk)) break;
      }

      if (lastMergedIndex > i) {
        mergedChunks.push({
          text: mergedText,
          chunkIndex: mergedChunks.length,
          pageNumbers: mergedPages,
          hasTable: false,
          sectionHeader: chunk.sectionHeader,
          tokenCount: estimateTokenCount(mergedText),
        });
        i = lastMergedIndex;
        continue;
      }
    }

    // If chunk is too short, try to merge with next or previous
    if (
      chunk.text.length < MIN_CHUNK_LENGTH
      && !chunk.hasTable
      && chunk.sectionHeader === null
    ) {
      // Try to merge with previous chunk (preferred)
      if (mergedChunks.length > 0) {
        const prevChunk = mergedChunks[mergedChunks.length - 1];

        // Merge if previous chunk is also short OR won't become too long
        const combinedText = `${prevChunk.text}\n\n${chunk.text}`;
        if (
          prevChunk.sectionHeader === chunk.sectionHeader
          && !prevChunk.hasTable
          && estimateTokenCount(combinedText) <= config.maxTokens
        ) {
          // Merge into previous chunk
          prevChunk.text = combinedText;
          prevChunk.pageNumbers = [
            ...new Set([...prevChunk.pageNumbers, ...chunk.pageNumbers])
          ].sort((a, b) => a - b);
          prevChunk.tokenCount = estimateTokenCount(prevChunk.text);
          prevChunk.sectionHeader = chunk.sectionHeader || prevChunk.sectionHeader;
          continue; // Skip adding this chunk separately
        }
      }

      // If can't merge with previous, try merging with next
      if (i < chunks.length - 1) {
        const nextChunk = chunks[i + 1];
        const combinedText = `${chunk.text}\n\n${nextChunk.text}`;

        if (
          nextChunk.sectionHeader === chunk.sectionHeader
          && !nextChunk.hasTable
          && estimateTokenCount(combinedText) <= config.maxTokens
        ) {
          // Merge current and next, then add
          mergedChunks.push({
            text: combinedText,
            chunkIndex: mergedChunks.length,
            pageNumbers: [
              ...new Set([...chunk.pageNumbers, ...nextChunk.pageNumbers])
            ].sort((a, b) => a - b),
            hasTable: chunk.hasTable || nextChunk.hasTable,
            sectionHeader: chunk.sectionHeader || nextChunk.sectionHeader,
            tokenCount: estimateTokenCount(combinedText),
          });
          i++; // Skip the next chunk since we merged it
          continue;
        }
      }
    }

    // Add chunk as-is (with updated index)
    mergedChunks.push({
      ...chunk,
      chunkIndex: mergedChunks.length,
    });
  }

  // Calculate totals
  const totalTokens = mergedChunks.reduce((sum, c) => sum + c.tokenCount, 0);

  return {
    chunks: mergedChunks,
    totalChunks: mergedChunks.length,
    totalTokens,
  };
}
