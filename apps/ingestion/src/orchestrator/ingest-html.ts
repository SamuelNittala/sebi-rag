/**
 * HTML Ingestion Orchestrator
 *
 * End-to-end pipeline that processes stored .md files:
 * 1. Parse frontmatter and heading structure
 * 2. Chunk content semantically
 * 3. Generate embeddings
 * 4. Store in html_chunks table via pgvector
 *
 * Mirrors ingestDocument() but for HTML content.
 */

import { createHash } from "crypto";
import { basename, resolve } from "path";

// Parsers
import {
  parseHtmlFile,
  toChunkInput,
  type ParsedHtmlDocument,
} from "../parsers/html-parser.ts";

// Chunker
import {
  semanticChunk,
  type ChunkResult,
} from "../chunkers/semantic-chunker.ts";

// Embedder
import { createEmbedder, type Embedder, type EmbeddingInput } from "../embedding/embedder.ts";
import { buildContextualEmbeddingText } from "../embedding/contextual-input.ts";
import { resolveKnowledgeScope } from "../metadata/knowledge-scope.ts";
import { prepareChunkReview } from "../review/review-preparation.ts";
import { classifyDocumentScope, strategyIdForScope } from "../review/review-metadata.ts";

// Database
import {
  db,
  createHtmlDocument,
  getHtmlDocumentByHash,
  getHtmlDocumentByUrl,
  updateHtmlDocumentSourceVersion,
  updateHtmlDocumentStatus,
  updateHtmlDocumentChunkCount,
  stageInspectionReview,
  type DocumentStatus,
} from "@mf-rag/db";

// Vector store
import { VectorClient } from "@mf-rag/vector";
import type { HtmlChunkPayload, HtmlChunkWithVector } from "@mf-rag/vector";
import {
  assertClassifiedKnowledgeOwnership,
  type ClassifiedKnowledgeOwnership,
  type KnowledgeOwnership,
} from "@mf-rag/types";

export interface HtmlIngestConfig {
  ollamaUrl?: string;
  embeddingBatchSize?: number;
  reviewGate?: "required" | "disabled";
  reviewExisting?: boolean;
  /** Trusted manifest/operator ownership. Never derive this from frontmatter. */
  ownership?: ClassifiedKnowledgeOwnership;
}

const DEFAULT_CONFIG: Required<Omit<HtmlIngestConfig, "ownership">> = {
  ollamaUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  embeddingBatchSize: 10,
  reviewGate: "required",
  reviewExisting: false,
};

export interface HtmlIngestResult {
  documentId: string;
  filename: string;
  title: string;
  status: "completed" | "failed" | "skipped" | "review_required";
  reviewRunId?: string;
  chunkCount?: number;
  error?: string;
  duration?: number;
}

export type HtmlProgressCallback = (progress: {
  stage: string;
  detail?: string;
  percentage?: number;
}) => void;

/**
 * Compute SHA256 hash of a file's content.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const buffer = await file.arrayBuffer();
  const hash = createHash("sha256");
  hash.update(Buffer.from(buffer));
  return hash.digest("hex");
}

function hasMatchingOwnership(
  document: {
    visibilityScope: KnowledgeOwnership["visibilityScope"];
    tenantId: string | null;
    ownershipManifestId: string | null;
    ownershipManifestVersion: number | null;
  },
  ownership: ClassifiedKnowledgeOwnership,
): boolean {
  return document.visibilityScope === ownership.visibilityScope
    && document.tenantId === ownership.tenantId
    && document.ownershipManifestId === ownership.ownershipManifestId
    && document.ownershipManifestVersion === ownership.ownershipManifestVersion;
}

/**
 * Ingest a single .md file into html_chunks.
 */
export async function ingestHtmlDocument(
  filePath: string,
  config?: HtmlIngestConfig,
  onProgress?: HtmlProgressCallback
): Promise<HtmlIngestResult> {
  const startTime = Date.now();
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const filename = basename(filePath);

  let documentId = "";

  try {
    if (!fullConfig.ownership) {
      throw new Error("Trusted ownership is required before ingestion.");
    }
    assertClassifiedKnowledgeOwnership(fullConfig.ownership);
    const ownership = fullConfig.ownership;
    // --- STAGE 1: Parse ---
    onProgress?.({ stage: "parsing", detail: "Computing file hash", percentage: 5 });

    const fileHash = await computeFileHash(filePath);

    // Check for duplicate (identical content)
    const hashMatch = await getHtmlDocumentByHash(db, fileHash);
    if (hashMatch && !hasMatchingOwnership(hashMatch, ownership)) {
      throw new Error("Trusted ownership does not match the existing HTML source document.");
    }
    if (hashMatch && !fullConfig.reviewExisting) {
      return {
        documentId: hashMatch.id,
        filename,
        title: hashMatch.title,
        status: "skipped",
        duration: Date.now() - startTime,
      };
    }

    onProgress?.({ stage: "parsing", detail: "Parsing markdown", percentage: 10 });

    const parsed: ParsedHtmlDocument = await parseHtmlFile(filePath);
    const { frontmatter } = parsed;

    // Re-scrapes change the file hash (scraped_at frontmatter, content edits),
    // so also match the logical page by source_url — html_documents has a
    // unique constraint on it, and a blind insert would collide.
    const existing = hashMatch
      ?? await getHtmlDocumentByUrl(db, frontmatter.source_url);

    if (existing && fullConfig.reviewGate !== "required") {
      throw new Error("reviewExisting can only be used with the required review gate.");
    }
    const knowledgeScope = resolveKnowledgeScope({
      source: frontmatter.source,
      sourceUrl: frontmatter.source_url,
      title: frontmatter.title,
    });

    // Reinspection reuses the source document and leaves its published vectors
    // untouched until the approved candidate version is atomically promoted.
    if (existing && !hasMatchingOwnership(existing, ownership)) {
      throw new Error("Trusted ownership does not match the existing HTML source document.");
    }
    const sourceVersion = {
      title: frontmatter.title,
      sourceSlug: basename(filePath, ".md"),
      filePath: resolve(filePath),
      fileHash,
      contentCategory: frontmatter.content_category,
      source: frontmatter.source,
      knowledgeDomain: knowledgeScope.knowledgeDomain,
      sourceCollection: knowledgeScope.sourceCollection,
      amcSlug: knowledgeScope.amcSlug,
      scrapedAt: new Date(frontmatter.scraped_at),
    };
    const doc = existing
      ? await updateHtmlDocumentSourceVersion(db, existing.id, sourceVersion)
      : await createHtmlDocument(db, {
        ...sourceVersion,
        sourceUrl: frontmatter.source_url,
        status: "processing" as DocumentStatus,
        ...ownership,
      });
    if (!doc) {
      throw new Error("Failed to update the existing HTML source document.");
    }
    documentId = doc.id;

    // --- STAGE 2: Chunk ---
    onProgress?.({ stage: "chunking", detail: "Creating chunks from headings", percentage: 30 });

    const chunkInput = toChunkInput(parsed);
    const chunkResult: ChunkResult = semanticChunk(chunkInput);

    if (chunkResult.chunks.length === 0) {
      await updateHtmlDocumentStatus(db, documentId, "failed", "No content extracted");
      return {
        documentId,
        filename,
        title: frontmatter.title,
        status: "failed",
        error: "No content extracted",
        duration: Date.now() - startTime,
      };
    }

    if (fullConfig.reviewGate === "required") {
      onProgress?.({ stage: "inspection", detail: "Inspecting every candidate chunk", percentage: 40 });
      // A page title is only a fund name on product pages — education/faq
      // titles (blog headlines) must not push the scope to "strategy".
      const scopeFundName =
        frontmatter.content_category === "product" ? frontmatter.title : null;
      const documentScope = classifyDocumentScope({
        filename,
        documentType: frontmatter.content_category,
        sourceCollection: knowledgeScope.sourceCollection,
        fundName: scopeFundName,
      });
      const prepared = prepareChunkReview({
        document: {
          id: documentId,
          filename,
          pageCount: parsed.sections.length,
          pageNumberBase: 0,
        },
        chunks: chunkResult.chunks,
        metadata: {
          documentScope,
          strategyId: strategyIdForScope(documentScope, frontmatter.title),
          sourceCollection: knowledgeScope.sourceCollection,
          fundName: frontmatter.title,
          documentType: frontmatter.content_category,
          sourceUrl: frontmatter.source_url,
          documentDate: frontmatter.source_date ?? null,
          sourceDate: frontmatter.source_date ?? null,
          sourceAuthority: "official_product_page",
          authority: "issuer",
          ...(frontmatter.source_artifact_url
            ? { sourceArtifactUrl: frontmatter.source_artifact_url }
            : {}),
          knowledgeDomain: knowledgeScope.knowledgeDomain,
          amcSlug: knowledgeScope.amcSlug,
        },
        ownership,
      });
      const reviewRun = await stageInspectionReview(db, {
        sourceType: "html",
        sourceDocumentId: documentId,
        sourceName: frontmatter.title,
        sourceLocation: frontmatter.source_url,
        fileHash,
        parserVersion: "html-markdown-v1",
        chunkerVersion: "semantic-v1",
        ownership,
        report: prepared.report,
        candidates: prepared.candidates,
      });
      await updateHtmlDocumentChunkCount(db, documentId, chunkResult.totalChunks);
      await updateHtmlDocumentStatus(db, documentId, "review_required");
      return {
        documentId,
        reviewRunId: reviewRun.id,
        filename,
        title: frontmatter.title,
        status: "review_required",
        chunkCount: chunkResult.totalChunks,
        duration: Date.now() - startTime,
      };
    }

    // --- STAGE 3: Embed ---
    onProgress?.({ stage: "embedding", detail: "Generating embeddings", percentage: 50 });

    const embedder: Embedder = createEmbedder({
      baseUrl: fullConfig.ollamaUrl,
      batchSize: fullConfig.embeddingBatchSize,
    });

    const embeddingInputs: EmbeddingInput[] = chunkResult.chunks.map((chunk) => ({
      text: buildContextualEmbeddingText(chunk.text, {
        document: frontmatter.title,
        section: chunk.sectionHeader,
        contentType: chunk.hasTable
          ? "table row"
          : chunk.sectionHeader?.endsWith("?")
            ? "FAQ"
            : "article",
      }),
      chunkIndex: chunk.chunkIndex,
    }));

    const embeddingResults = await embedder.embedBatch(embeddingInputs, (progress) => {
      const pct = 50 + Math.round((progress.percentage / 100) * 30);
      onProgress?.({
        stage: "embedding",
        detail: `Embedding chunk ${progress.completed}/${progress.total}`,
        percentage: pct,
      });
    });

    // --- STAGE 4: Store ---
    onProgress?.({ stage: "storing", detail: "Saving to vector database", percentage: 85 });

    const vectorClient = new VectorClient();

    const chunksWithVectors: HtmlChunkWithVector[] = chunkResult.chunks.map((chunk) => {
      const embeddingResult = embeddingResults.find((r) => r.chunkIndex === chunk.chunkIndex);
      if (!embeddingResult) {
        throw new Error(`Missing embedding for chunk ${chunk.chunkIndex}`);
      }

      // Deterministic UUID
      const idSource = `${documentId}_${chunk.chunkIndex}`;
      const idHash = createHash("sha256").update(idSource).digest("hex");
      const chunkId = [
        idHash.slice(0, 8),
        idHash.slice(8, 12),
        idHash.slice(12, 16),
        idHash.slice(16, 20),
        idHash.slice(20, 32),
      ].join("-");

      const payload: HtmlChunkPayload = {
        text: chunk.text,
        chunk_index: chunk.chunkIndex,
        total_chunks: chunkResult.totalChunks,
        document_id: documentId,
        document_title: frontmatter.title,
        source_url: frontmatter.source_url,
        content_category: frontmatter.content_category,
        section_heading: chunk.sectionHeader,
        has_table: chunk.hasTable,
        knowledge_domain: knowledgeScope.knowledgeDomain,
        source_collection: knowledgeScope.sourceCollection,
        amc_slug: knowledgeScope.amcSlug,
        visibility_scope: ownership.visibilityScope,
        tenant_id: ownership.tenantId,
        ownership_manifest_id: ownership.ownershipManifestId,
        ownership_manifest_version: ownership.ownershipManifestVersion,
      };

      return {
        id: chunkId,
        vector: embeddingResult.embedding,
        payload,
      };
    });

    await vectorClient.upsertHtmlChunks(chunksWithVectors);

    // Update document
    await updateHtmlDocumentChunkCount(db, documentId, chunkResult.totalChunks);
    await updateHtmlDocumentStatus(db, documentId, "completed");

    onProgress?.({ stage: "storing", detail: "Complete", percentage: 100 });

    return {
      documentId,
      filename,
      title: frontmatter.title,
      status: "completed",
      chunkCount: chunkResult.totalChunks,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (documentId) {
      try {
        await updateHtmlDocumentStatus(db, documentId, "failed", errorMessage);
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      documentId,
      filename,
      title: "",
      status: "failed",
      error: errorMessage,
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Ingest all .md files in a directory.
 */
export async function ingestHtmlDirectory(
  dirPath: string,
  config?: HtmlIngestConfig,
  onProgress?: (file: string, progress: { stage: string; detail?: string }) => void
): Promise<HtmlIngestResult[]> {
  const results: HtmlIngestResult[] = [];

  const glob = new Bun.Glob("**/*.md");
  const files: string[] = [];

  for await (const file of glob.scan({ cwd: dirPath, absolute: true })) {
    files.push(file);
  }

  if (files.length === 0) {
    return results;
  }

  console.log(`Found ${files.length} markdown files to ingest`);

  for (const filepath of files) {
    const filename = basename(filepath);
    const callback: HtmlProgressCallback | undefined = onProgress
      ? (progress) => onProgress(filename, progress)
      : undefined;

    const result = await ingestHtmlDocument(filepath, config, callback);
    results.push(result);

    const statusIcon = result.status === "completed"
      ? "ok"
      : result.status === "skipped"
        ? "skip"
        : result.status === "review_required"
          ? "review"
          : "FAIL";
    const detail = result.status === "completed" || result.status === "review_required"
      ? `${result.chunkCount} chunks`
      : result.error ?? "";
    console.log(`  [${statusIcon}] ${result.title || filename} ${detail ? `(${detail})` : ""}`);
  }

  return results;
}
