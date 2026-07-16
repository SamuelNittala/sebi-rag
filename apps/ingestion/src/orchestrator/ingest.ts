/**
 * Ingestion Orchestrator for MF-RAG System
 *
 * End-to-end pipeline that processes PDFs:
 * 1. Parse PDF text
 * 2. Extract tables
 * 3. Chunk content semantically
 * 4. Extract metadata for filtering
 * 5. Generate embeddings
 * 6. Store in pgvector (vectors) and PostgreSQL (metadata)
 *
 * Features:
 * - Deduplication via SHA256 file hash
 * - Status tracking (pending, processing, completed, failed)
 * - Progress reporting via callbacks
 * - Graceful error handling
 */

import { createHash } from "crypto";
import { basename, extname, resolve, dirname } from "path";

// Parsers
import { parsePDF, type ParsedPDF } from "../parsers/pdf-parser.ts";
import { extractTables, type TableExtractionResult } from "../parsers/table-parser.ts";

// Chunker
import { semanticChunk, type ChunkInput, type Chunk, type ChunkResult } from "../chunkers/semantic-chunker.ts";
import { removeDisposableSifChunks } from "../chunkers/disposable-content.ts";

// Metadata extractor
import { extractMetadata, type ExtractedMetadata, type DocType } from "../metadata/extractor.ts";
import { resolveKnowledgeScope } from "../metadata/knowledge-scope.ts";
import { prepareChunkReview } from "../review/review-preparation.ts";
import {
  classifyDocumentScope,
  strategyIdForScope,
} from "../review/review-metadata.ts";

// Embedder
import { createEmbedder, type Embedder, type EmbeddingInput } from "../embedding/embedder.ts";
import { buildContextualEmbeddingText } from "../embedding/contextual-input.ts";
import type { KnowledgeScope } from "@mf-rag/types";

// Database
import {
  db,
  documents,
  eq,
  createDocument,
  getDocumentByHash,
  updateDocumentStatus,
  updateDocumentChunkCount,
  createFund,
  getFundByName,
  getFundBySebiSchemeId,
  linkDocumentToFund,
  stageInspectionReview,
  type DocumentStatus,
  type Fund,
} from "@mf-rag/db";

// Vector store
import { VectorClient, type ChunkWithVector, type ChunkPayload } from "@mf-rag/vector";

/**
 * Configuration for ingestion pipeline
 */
export interface IngestConfig {
  /** Ollama API URL (default: 'http://localhost:11434') */
  ollamaUrl?: string;
  /** Batch size for embedding generation (default: 10) */
  embeddingBatchSize?: number;
  /** Optional trusted scope override for targeted ingestion jobs. */
  knowledgeScope?: KnowledgeScope;
  /** Require inspection and human approval before embedding (default: required). */
  reviewGate?: "required" | "disabled";
  /** Re-run parsing and inspection for an already known file without deleting its published vectors. */
  reviewExisting?: boolean;
}

/**
 * Default configuration values
 */
export const DEFAULT_INGEST_CONFIG: Required<Omit<IngestConfig, "knowledgeScope">> = {
  ollamaUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  embeddingBatchSize: 10,
  reviewGate: "required",
  reviewExisting: false,
};

/**
 * Result of document ingestion
 */
export interface IngestResult {
  /** Document ID in database (empty if failed before creation) */
  documentId: string;
  /** Original filename */
  filename: string;
  /** Processing status */
  status: "completed" | "failed" | "skipped" | "review_required";
  /** Review run awaiting approval before embedding. */
  reviewRunId?: string;
  /** Number of chunks created (only for completed) */
  chunkCount?: number;
  /** Error message (only for failed) */
  error?: string;
  /** Processing duration in milliseconds */
  duration?: number;
}

/**
 * Progress information during ingestion
 */
export interface IngestProgress {
  /** Current processing stage */
  stage: "parsing" | "chunking" | "metadata" | "inspection" | "embedding" | "storing";
  /** Optional detail message */
  detail?: string;
  /** Progress percentage (0-100) */
  percentage?: number;
}

/**
 * Callback for progress updates
 */
export type ProgressCallback = (progress: IngestProgress) => void;

/**
 * Compute SHA256 hash of a file for deduplication
 *
 * @param filepath - Path to the file
 * @returns SHA256 hash as hex string
 */
export async function computeFileHash(filepath: string): Promise<string> {
  const file = Bun.file(filepath);
  const exists = await file.exists();

  if (!exists) {
    throw new Error(`File not found: ${filepath}`);
  }

  const buffer = await file.arrayBuffer();
  const hash = createHash("sha256");
  hash.update(Buffer.from(buffer));
  return hash.digest("hex");
}

/**
 * Check if a document has already been processed
 *
 * @param filepath - Path to the PDF file
 * @returns true if document with same hash exists in database
 */
export async function isDocumentProcessed(filepath: string): Promise<boolean> {
  const fileHash = await computeFileHash(filepath);
  const existingDoc = await getDocumentByHash(db, fileHash);
  return existingDoc !== undefined;
}

/**
 * Process a single PDF document through the ingestion pipeline
 *
 * @param filepath - Path to the PDF file
 * @param config - Optional configuration overrides
 * @param onProgress - Optional callback for progress updates
 * @returns IngestResult with status and metadata
 */
export async function ingestDocument(
  filepath: string,
  config?: IngestConfig,
  onProgress?: ProgressCallback
): Promise<IngestResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_INGEST_CONFIG, ...config };
  const filename = basename(filepath);

  // Validate file extension
  const ext = extname(filepath).toLowerCase();
  if (ext !== ".pdf") {
    return {
      documentId: "",
      filename,
      status: "failed",
      error: `Invalid file type: expected PDF, got ${ext || "no extension"}`,
      duration: Date.now() - startTime,
    };
  }

  // Check if file exists
  const file = Bun.file(filepath);
  const exists = await file.exists();

  if (!exists) {
    return {
      documentId: "",
      filename,
      status: "failed",
      error: `File not found: ${filepath}`,
      duration: Date.now() - startTime,
    };
  }

  let documentId = "";

  try {
    // --- STAGE 1: Parsing ---
    onProgress?.({ stage: "parsing", detail: "Computing file hash", percentage: 5 });

    const fileHash = await computeFileHash(filepath);

    // Check for duplicate
    const existingDoc = await getDocumentByHash(db, fileHash);
    if (existingDoc && !fullConfig.reviewExisting) {
      return {
        documentId: existingDoc.id,
        filename,
        status: "skipped",
        duration: Date.now() - startTime,
      };
    }

    if (existingDoc && fullConfig.reviewGate !== "required") {
      throw new Error("reviewExisting can only be used with the required review gate.");
    }

    // Reinspection reuses the document identity so the current published vector
    // version remains available until the reviewed replacement is promoted.
    const doc = existingDoc ?? await createDocument(db, {
      filename,
      filepath: resolve(filepath),
      fileHash,
      status: "pending" as DocumentStatus,
    });
    documentId = doc.id;

    // Update status to processing
    await updateDocumentStatus(db, documentId, "processing");

    onProgress?.({ stage: "parsing", detail: "Extracting text from PDF", percentage: 10 });

    // Parse PDF text
    const parsedPdf: ParsedPDF = await parsePDF(filepath);

    onProgress?.({ stage: "parsing", detail: "Extracting tables", percentage: 20 });

    // Extract tables
    const tableResult: TableExtractionResult = await extractTables(filepath);

    // --- STAGE 2: Chunking ---
    onProgress?.({ stage: "chunking", detail: "Creating semantic chunks", percentage: 30 });

    // Prepare chunk input
    const chunkInput: ChunkInput = {
      pages: parsedPdf.pages.map((p) => ({
        pageNumber: p.pageNumber,
        text: p.text,
      })),
      tables: tableResult.tables.map((t) => ({
        pageNumber: t.page,
        markdown: t.markdown,
      })),
    };

    let chunkResult: ChunkResult = semanticChunk(chunkInput);

    if (chunkResult.chunks.length === 0) {
      await updateDocumentStatus(db, documentId, "failed", "No content extracted from PDF");
      return {
        documentId,
        filename,
        status: "failed",
        error: "No content extracted from PDF",
        duration: Date.now() - startTime,
      };
    }

    // --- STAGE 3: Metadata ---
    onProgress?.({ stage: "metadata", detail: "Extracting document metadata", percentage: 40 });

    // Get first few pages text for metadata extraction
    const firstPagesText = parsedPdf.pages
      .slice(0, 3)
      .map((p) => p.text)
      .join("\n\n");

    const metadata: ExtractedMetadata = extractMetadata({
      filename,
      filepath: resolve(filepath),
      firstPageText: firstPagesText,
      fullText: parsedPdf.rawText,
    });
    const knowledgeScope = fullConfig.knowledgeScope ?? resolveKnowledgeScope({
      source: "pdf",
      sourceUrl: resolve(filepath),
      title: `${metadata.fundName ?? ""} ${firstPagesText.slice(0, 1500)}`,
    });
    if (knowledgeScope.sourceCollection === "mirae_sif") {
      chunkResult = removeDisposableSifChunks(chunkResult, filename);
    }

    if (chunkResult.chunks.length === 0) {
      await updateDocumentStatus(db, documentId, "failed", "No relevant content extracted from PDF");
      return {
        documentId,
        filename,
        status: "failed",
        error: "No relevant content extracted from PDF",
        duration: Date.now() - startTime,
      };
    }

    // Update document with extracted info
    await db
      .update(documents)
      .set({
        docType: metadata.docType,
        documentDate: metadata.documentDate,
        pageCount: parsedPdf.pageCount,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    if (fullConfig.reviewGate === "required") {
      onProgress?.({ stage: "inspection", detail: "Inspecting every candidate chunk", percentage: 45 });
      const sebiMetadata = await lookupSebiMetadata(filepath, metadata.fundName ?? undefined);
      const documentScope = classifyDocumentScope({
        filename,
        documentType: metadata.docType,
        sourceCollection: knowledgeScope.sourceCollection,
        fundName: metadata.fundName,
      });
      const prepared = prepareChunkReview({
        document: { id: documentId, filename, pageCount: parsedPdf.pageCount },
        chunks: chunkResult.chunks,
        metadata: {
          documentScope,
          strategyId: strategyIdForScope(documentScope, metadata.fundName),
          sourceCollection: knowledgeScope.sourceCollection,
          fundName: metadata.fundName,
          documentType: metadata.docType,
          amcName: sebiMetadata.amcName || metadata.amcName,
          schemeType: sebiMetadata.schemeType || metadata.schemeType,
          schemeCategory: sebiMetadata.schemeCategory || metadata.schemeCategory,
          documentDate: metadata.documentDate?.toISOString().split("T")[0] ?? null,
          sebiSchemeId: sebiMetadata.sebiSchemeId,
          sebiUrl: sebiMetadata.sebiUrl,
          knowledgeDomain: knowledgeScope.knowledgeDomain,
          amcSlug: knowledgeScope.amcSlug,
        },
      });
      const reviewRun = await stageInspectionReview(db, {
        sourceType: "pdf",
        sourceDocumentId: documentId,
        sourceName: filename,
        sourceLocation: resolve(filepath),
        fileHash,
        parserVersion: "unpdf-pdfplumber-v1",
        chunkerVersion: "semantic-v1",
        report: prepared.report,
        candidates: prepared.candidates,
      });
      await updateDocumentChunkCount(db, documentId, chunkResult.totalChunks);
      await updateDocumentStatus(db, documentId, "review_required");
      onProgress?.({ stage: "inspection", detail: "Ready for human review", percentage: 50 });
      return {
        documentId,
        reviewRunId: reviewRun.id,
        filename,
        status: "review_required",
        chunkCount: chunkResult.totalChunks,
        duration: Date.now() - startTime,
      };
    }

    // --- STAGE 4: Embedding ---
    onProgress?.({ stage: "embedding", detail: "Generating embeddings", percentage: 50 });

    const embedder: Embedder = createEmbedder({
      baseUrl: fullConfig.ollamaUrl,
      batchSize: fullConfig.embeddingBatchSize,
    });

    // Prepare embedding inputs
    const embeddingInputs: EmbeddingInput[] = chunkResult.chunks.map((chunk) => ({
      text: buildContextualEmbeddingText(chunk.text, {
        fund: metadata.fundName,
        document: metadata.docType === "Unknown" ? filename : metadata.docType,
        section: chunk.sectionHeader,
        pages: chunk.pageNumbers,
        contentType: chunk.hasTable ? "table row" : "document text",
      }),
      chunkIndex: chunk.chunkIndex,
    }));

    // Track embedding progress
    const totalChunks = embeddingInputs.length;
    const embeddingResults = await embedder.embedBatch(embeddingInputs, (progress) => {
      const overallPercentage = 50 + Math.round((progress.percentage / 100) * 30);
      onProgress?.({
        stage: "embedding",
        detail: `Embedding chunk ${progress.completed}/${progress.total}`,
        percentage: overallPercentage,
      });
    });

    // --- STAGE 5: Storing ---
    onProgress?.({ stage: "storing", detail: "Looking up SEBI metadata", percentage: 82 });

    // Look up SEBI metadata for citations (before creating chunks)
    const sebiMetadata = await lookupSebiMetadata(filepath, metadata.fundName ?? undefined);

    onProgress?.({ stage: "storing", detail: "Saving to vector database", percentage: 85 });

    // Initialize vector client (pgvector)
    const vectorClient = new VectorClient();
    await vectorClient.initCollection();

    // Prepare chunks with vectors for pgvector
    const chunksWithVectors: ChunkWithVector[] = chunkResult.chunks.map((chunk, idx) => {
      const embeddingResult = embeddingResults.find((r) => r.chunkIndex === chunk.chunkIndex);
      if (!embeddingResult) {
        throw new Error(`Missing embedding for chunk ${chunk.chunkIndex}`);
      }

      // Generate deterministic UUID for this chunk
      // Use hash of documentId + chunkIndex to ensure consistency on re-ingestion
      const chunkIdSource = `${documentId}_${chunk.chunkIndex}`;
      const chunkIdHash = createHash("sha256").update(chunkIdSource).digest("hex");
      // Convert first 32 hex chars to UUID format (8-4-4-4-12)
      const chunkId = [
        chunkIdHash.slice(0, 8),
        chunkIdHash.slice(8, 12),
        chunkIdHash.slice(12, 16),
        chunkIdHash.slice(16, 20),
        chunkIdHash.slice(20, 32),
      ].join("-");

      const payload: ChunkPayload = {
        text: chunk.text,
        chunk_index: chunk.chunkIndex,
        total_chunks: chunkResult.totalChunks,
        document_id: documentId,
        document_filename: filename,
        page_numbers: chunk.pageNumbers,
        fund_name: metadata.fundName || "",
        // Use database AMC name if available (from SEBI), otherwise use extracted
        amc_name: sebiMetadata.amcName || metadata.amcName || "",
        // Use database scheme type if available (from SEBI), otherwise use extracted
        scheme_type: sebiMetadata.schemeType || metadata.schemeType || "",
        scheme_category: sebiMetadata.schemeCategory || metadata.schemeCategory || "",
        doc_type: metadata.docType,
        document_date: metadata.documentDate?.toISOString().split("T")[0] || "",
        has_table: chunk.hasTable,
        section_header: chunk.sectionHeader,
        sebi_scheme_id: sebiMetadata.sebiSchemeId,
        sebi_url: sebiMetadata.sebiUrl,
        knowledge_domain: knowledgeScope.knowledgeDomain,
        source_collection: knowledgeScope.sourceCollection,
        amc_slug: knowledgeScope.amcSlug,
      };

      return {
        id: chunkId,
        vector: embeddingResult.embedding,
        payload,
      };
    });

    // Upsert chunks to pgvector
    await vectorClient.upsertChunks(chunksWithVectors);

    onProgress?.({ stage: "storing", detail: "Saving metadata to database", percentage: 95 });

    // Create or link fund record if fund name was extracted
    if (metadata.fundName) {
      let fund = await getFundByName(db, metadata.fundName);

      if (!fund) {
        fund = await createFund(db, {
          name: metadata.fundName,
          amcName: metadata.amcName,
          schemeType: metadata.schemeType,
          schemeCategory: metadata.schemeCategory,
          isinGrowth: metadata.isinGrowth,
          isinDividend: metadata.isinDividend,
        });
      }

      await linkDocumentToFund(db, documentId, fund.id);
    }

    // Update document status to completed
    await updateDocumentChunkCount(db, documentId, chunkResult.totalChunks);
    await updateDocumentStatus(db, documentId, "completed");

    onProgress?.({ stage: "storing", detail: "Complete", percentage: 100 });

    return {
      documentId,
      filename,
      status: "completed",
      chunkCount: chunkResult.totalChunks,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    // Handle errors gracefully
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Update document status if we have an ID
    if (documentId) {
      try {
        await updateDocumentStatus(db, documentId, "failed", errorMessage);
      } catch {
        // Ignore errors during cleanup
      }
    }

    return {
      documentId,
      filename,
      status: "failed",
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Process all PDF files in a directory
 *
 * @param dirpath - Path to directory containing PDFs
 * @param config - Optional configuration overrides
 * @param onProgress - Optional callback for progress updates (per file)
 * @returns Array of IngestResult for each PDF found
 */
export async function ingestDirectory(
  dirpath: string,
  config?: IngestConfig,
  onProgress?: (file: string, progress: IngestProgress) => void
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];

  // Check if directory exists
  const dir = Bun.file(dirpath);
  // For directories, we need to use different approach
  try {
    const glob = new Bun.Glob("**/*.pdf");
    const files: string[] = [];

    for await (const file of glob.scan({ cwd: dirpath, absolute: true })) {
      files.push(file);
    }

    if (files.length === 0) {
      return results;
    }

    // Process each file sequentially (to avoid overwhelming services)
    for (const filepath of files) {
      const filename = basename(filepath);

      // Wrap progress callback to include filename
      const fileProgress: ProgressCallback | undefined = onProgress
        ? (progress) => onProgress(filename, progress)
        : undefined;

      const result = await ingestDocument(filepath, config, fileProgress);
      results.push(result);
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error reading directory ${dirpath}: ${errorMessage}`);
  }

  return results;
}

/**
 * SEBI metadata extracted from file path or database lookup
 */
interface SebiMetadata {
  sebiSchemeId: string;
  sebiUrl: string;
  amcName: string;
  schemeType: string;
  schemeCategory: string;
}

/**
 * Check if a file path is from the SEBI PDF scraper
 * Expected path: data/sebi-pdfs/{AMC_Name}/{Scheme_Name}.pdf
 *
 * @param filepath - Full path to the PDF file
 * @returns true if the file is in the sebi-pdfs directory
 */
function isSebiPdfPath(filepath: string): boolean {
  return filepath.includes("/sebi-pdfs/") || filepath.includes("\\sebi-pdfs\\");
}

/**
 * Extract AMC name and scheme name from SEBI PDF file path
 * Expected path: data/sebi-pdfs/{AMC_Name}/{Scheme_Name}.pdf
 *
 * @param filepath - Full path to the PDF file
 * @returns Object with amcName and schemeName, or undefined if not a SEBI path
 */
function extractSebiPathInfo(
  filepath: string
): { amcName: string; schemeName: string } | undefined {
  if (!isSebiPdfPath(filepath)) {
    return undefined;
  }

  const dir = dirname(filepath);
  const amcName = basename(dir);
  const schemeName = basename(filepath, ".pdf");

  if (!amcName || !schemeName) {
    return undefined;
  }

  return { amcName, schemeName };
}

/**
 * Construct SEBI detail page URL from scheme ID
 *
 * @param sebiSchemeId - The SEBI scheme identifier (e.g., "16669")
 * @returns Full URL to the SEBI fund details page
 */
function constructSebiUrl(sebiSchemeId: string): string {
  return `https://www.sebi.gov.in/sebiweb/other/OtherAction.do?doGetFundDetails=yes&mfdId=${sebiSchemeId}`;
}

/**
 * Look up SEBI metadata for a PDF file
 * First tries to match by scheme name from path, then by fund name from metadata
 *
 * @param filepath - Full path to the PDF file
 * @param fundName - Fund name from metadata extraction (optional)
 * @returns SEBI metadata with scheme ID and URL, or empty strings if not found
 */
async function lookupSebiMetadata(
  filepath: string,
  fundName?: string
): Promise<SebiMetadata> {
  const emptyResult: SebiMetadata = {
    sebiSchemeId: "",
    sebiUrl: "",
    amcName: "",
    schemeType: "",
    schemeCategory: "",
  };

  // Try to find fund by path-derived info for SEBI PDFs
  const pathInfo = extractSebiPathInfo(filepath);
  if (pathInfo) {
    // For SEBI PDFs, the filename is the scheme name
    // Try to find a fund with matching name
    const fund = await getFundByName(db, pathInfo.schemeName);
    if (fund?.sebiSchemeId) {
      return {
        sebiSchemeId: fund.sebiSchemeId,
        sebiUrl: constructSebiUrl(fund.sebiSchemeId),
        amcName: fund.amcName || "",
        schemeType: fund.schemeType || "",
        schemeCategory: fund.schemeCategory || "",
      };
    }
  }

  // Fallback: try to find by extracted fund name
  if (fundName) {
    const fund = await getFundByName(db, fundName);
    if (fund?.sebiSchemeId) {
      return {
        sebiSchemeId: fund.sebiSchemeId,
        sebiUrl: constructSebiUrl(fund.sebiSchemeId),
        amcName: fund.amcName || "",
        schemeType: fund.schemeType || "",
        schemeCategory: fund.schemeCategory || "",
      };
    }
  }

  return emptyResult;
}

// Re-export types for convenience
export type { DocType } from "../metadata/extractor.ts";
