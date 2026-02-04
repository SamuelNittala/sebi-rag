/**
 * MF PDF RAG Ingestion Worker
 *
 * Entry point for the document ingestion pipeline.
 * Processes PDF documents through parsing, chunking, embedding, and storage.
 */

// Re-export orchestrator for programmatic use
export * from "./orchestrator/index.ts";

// Re-export individual modules for granular access
export * from "./parsers/index.ts";
export * from "./chunkers/index.ts";
export * from "./metadata/index.ts";

// Re-export embedding module with renamed ProgressCallback to avoid conflict
export {
  embedText,
  embedBatch,
  createEmbedder,
  checkOllamaHealth,
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type EmbeddingInput,
  type EmbeddingResult,
  type EmbeddingProgress,
  type ProgressCallback as EmbeddingProgressCallback,
  type Embedder,
} from "./embedding/index.ts";

// CLI entry point when run directly
if (import.meta.main) {
  const { ingestDocument, ingestDirectory } = await import("./orchestrator/index.ts");

  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("MF PDF RAG Ingestion Worker v0.1.0");
    console.log("");
    console.log("Usage:");
    console.log("  bun run apps/ingestion/src/index.ts <pdf-file>");
    console.log("  bun run apps/ingestion/src/index.ts --dir <directory>");
    console.log("");
    console.log("Options:");
    console.log("  --dir       Process all PDFs in directory");
    console.log("  --ollama    Ollama URL (default: http://localhost:11434)");
    process.exit(0);
  }

  // Parse arguments
  const isDir = args.includes("--dir");
  const ollamaIdx = args.indexOf("--ollama");

  const config = {
    ollamaUrl: ollamaIdx !== -1 ? args[ollamaIdx + 1] : undefined,
  };

  // Get path (first non-flag argument)
  const path = args.find((arg) => !arg.startsWith("--") && arg !== config.ollamaUrl);

  if (!path) {
    console.error("Error: No path specified");
    process.exit(1);
  }

  // Progress callback
  const onProgress = (stage: string, progress: { stage: string; detail?: string; percentage?: number }) => {
    const pct = progress.percentage ? `${progress.percentage}%` : "";
    console.log(`[${stage}] ${progress.stage}: ${progress.detail || ""} ${pct}`);
  };

  try {
    if (isDir) {
      console.log(`Processing directory: ${path}`);
      const results = await ingestDirectory(path, config, (file, progress) => {
        onProgress(file, progress);
      });

      console.log("\n--- Summary ---");
      const completed = results.filter((r) => r.status === "completed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const failed = results.filter((r) => r.status === "failed").length;

      console.log(`Completed: ${completed}`);
      console.log(`Skipped (duplicates): ${skipped}`);
      console.log(`Failed: ${failed}`);

      if (failed > 0) {
        console.log("\nFailed files:");
        for (const r of results.filter((r) => r.status === "failed")) {
          console.log(`  ${r.filename}: ${r.error}`);
        }
      }
    } else {
      console.log(`Processing file: ${path}`);
      const result = await ingestDocument(path, config, (progress) => {
        onProgress(path, progress);
      });

      console.log("\n--- Result ---");
      console.log(`Status: ${result.status}`);
      console.log(`Document ID: ${result.documentId || "N/A"}`);
      if (result.chunkCount) {
        console.log(`Chunks: ${result.chunkCount}`);
      }
      if (result.duration) {
        console.log(`Duration: ${(result.duration / 1000).toFixed(2)}s`);
      }
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
    }
  } catch (error) {
    console.error("Fatal error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
