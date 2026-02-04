#!/usr/bin/env bun
/**
 * MF-RAG CLI - Mutual Fund Document Search
 *
 * Commands:
 *   query <question>  - Ask a question about mutual fund documents
 *   search <query>    - Search for relevant document chunks
 *   status            - Check service health
 */

import { Command } from "commander";
import { RAGPipeline } from "@mf-rag/core";
import type { QueryFilters } from "@mf-rag/types";

// Configuration from environment
const config = {
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  },
};

// Create pipeline instance
function createPipeline(model?: string): RAGPipeline {
  return new RAGPipeline({
    ollama: model ? { ...config.ollama, model } : config.ollama,
  });
}

// Format duration in human-readable form
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const program = new Command();

program
  .name("mf-rag")
  .description("MF PDF RAG - Mutual Fund Document Search")
  .version("0.1.0");

// Query command
program
  .command("query <question>")
  .description("Ask a question about mutual fund documents")
  .option("-l, --limit <number>", "Number of chunks to retrieve", "5")
  .option("-f, --fund <name>", "Filter by fund name")
  .option("-t, --type <type>", "Filter by scheme type (Equity, Debt, Hybrid)")
  .option("-d, --doc-type <type>", "Filter by document type (SID, KIM, Factsheet)")
  .option("-m, --model <model>", "LLM model (default: qwen2.5:7b)")
  .option("--json", "Output as JSON")
  .action(async (question: string, options) => {
    try {
      const pipeline = createPipeline(options.model);

      // Build filters
      const filters: QueryFilters = {};
      if (options.fund) filters.fundName = options.fund;
      if (options.type) filters.schemeType = options.type;
      if (options.docType) filters.docType = options.docType;

      const response = await pipeline.query({
        query: question,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        limit: parseInt(options.limit, 10),
      });

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      // Text output

      // Show detection info if fund was auto-detected
      if (response.metadata.detectedFund) {
        const { fundName, confidence, autoApplied } = response.metadata.detectedFund;
        if (autoApplied) {
          console.log(`\nAuto-filtered: ${fundName} (${(confidence * 100).toFixed(0)}% confidence)`);
        }
      } else if (response.metadata.detectedAmc) {
        console.log(`\nDetected AMC: ${response.metadata.detectedAmc} (use --fund to filter specific fund)`);
      }

      console.log("\nAnswer:");
      console.log("  " + response.answer.split("\n").join("\n  "));
      console.log();

      if (response.citations.length > 0) {
        console.log("Sources:");
        for (const c of response.citations) {
          const pages = c.pageNumbers.length === 1
            ? `p.${c.pageNumbers[0]}`
            : `pp.${c.pageNumbers.join(",")}`;
          console.log(`  [${c.index}] ${c.fundName} (${c.docType}, ${pages})`);
          if (c.sebiUrl) {
            console.log(`      ${c.sebiUrl}`);
          }
        }
        console.log();
      }

      console.log(
        `Query completed in ${formatDuration(response.metadata.queryTimeMs)} ` +
        `(${response.metadata.chunksUsed} chunks used)`
      );
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Search command
program
  .command("search <query>")
  .description("Search for relevant document chunks (no LLM)")
  .option("-l, --limit <number>", "Number of results", "10")
  .option("-f, --fund <name>", "Filter by fund name")
  .option("-t, --type <type>", "Filter by scheme type")
  .option("-d, --doc-type <type>", "Filter by document type")
  .option("--json", "Output as JSON")
  .action(async (query: string, options) => {
    try {
      const pipeline = createPipeline();

      // Build filters
      const filters: QueryFilters = {};
      if (options.fund) filters.fundName = options.fund;
      if (options.type) filters.schemeType = options.type;
      if (options.docType) filters.docType = options.docType;

      const response = await pipeline.search({
        query,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        limit: parseInt(options.limit, 10),
      });

      if (options.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      // Text output
      console.log(`\nFound ${response.results.length} results:\n`);
      for (const r of response.results) {
        const pages = r.metadata.page_numbers.length === 1
          ? `p.${r.metadata.page_numbers[0]}`
          : `pp.${r.metadata.page_numbers.join(",")}`;
        console.log(`[${r.score.toFixed(3)}] ${r.metadata.fund_name} (${r.metadata.doc_type}, ${pages})`);
        console.log(`  ${r.text.slice(0, 150).replace(/\n/g, " ")}...`);
        console.log();
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Status command
program
  .command("status")
  .description("Check service health")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    try {
      const pipeline = createPipeline();
      const health = await pipeline.checkHealth();

      if (options.json) {
        console.log(JSON.stringify(health, null, 2));
        return;
      }

      // Text output
      console.log("\nService Status:");
      console.log(`  Vector:   ${health.services.vector ? "OK" : "FAIL"}`);
      console.log(`  Ollama:   ${health.services.ollama ? "OK" : "FAIL"}`);
      console.log(`  Postgres: ${health.services.postgres ? "OK" : "FAIL"}`);
      console.log();
      console.log(`Overall: ${health.status.toUpperCase()}`);

      if (health.status === "error") {
        process.exit(1);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Parse and run
program.parse();
