#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { resolveKnowledgeScope } from "../apps/ingestion/src/metadata/knowledge-scope.ts";
import { parseHtmlFile } from "../apps/ingestion/src/parsers/html-parser.ts";

const MIRAE_SCOPE = {
  knowledgeDomain: "sif",
  sourceCollection: "mirae_sif",
  amcSlug: "mirae-asset",
} as const;

function optionValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1]!)
    : resolve(fallback);
}

async function fileHash(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function scan(directory: string, pattern: string): Promise<string[]> {
  try {
    const files: string[] = [];
    for await (const file of new Bun.Glob(pattern).scan({ cwd: directory, absolute: true })) {
      files.push(file);
    }
    return files.sort();
  } catch {
    return [];
  }
}

async function scopedHtmlFiles(directory: string): Promise<string[]> {
  const candidates = await scan(directory, "**/*.md");
  const scoped: string[] = [];

  for (const filePath of candidates) {
    const parsed = await parseHtmlFile(filePath);
    const scope = resolveKnowledgeScope({
      source: parsed.frontmatter.source,
      sourceUrl: parsed.frontmatter.source_url,
      title: parsed.frontmatter.title,
    });
    if (scope.knowledgeDomain === "sif") scoped.push(filePath);
  }

  return scoped;
}

async function replacePdf(filePath: string): Promise<void> {
  const { db, deleteDocument, getDocumentByHash } = await import("@mf-rag/db");
  const { ingestDocument } = await import("../apps/ingestion/src/orchestrator/ingest.ts");
  const existing = await getDocumentByHash(db, await fileHash(filePath));
  if (existing) await deleteDocument(db, existing.id);

  const result = await ingestDocument(filePath, {
    knowledgeScope: MIRAE_SCOPE,
    ollamaUrl: process.env.OLLAMA_BASE_URL,
  });
  const error = result.error ? `: ${result.error}` : "";
  console.log(`[${result.status}] PDF ${filePath} (${result.chunkCount ?? 0} chunks)${error}`);
}

async function replaceHtml(filePath: string): Promise<void> {
  const { db, deleteHtmlDocument, getHtmlDocumentByUrl } = await import("@mf-rag/db");
  const { ingestHtmlDocument } = await import("../apps/ingestion/src/orchestrator/ingest-html.ts");
  const parsed = await parseHtmlFile(filePath);
  const existing = await getHtmlDocumentByUrl(db, parsed.frontmatter.source_url);
  if (existing) await deleteHtmlDocument(db, existing.id);

  const result = await ingestHtmlDocument(filePath);
  const error = result.error ? `: ${result.error}` : "";
  console.log(`[${result.status}] HTML ${filePath} (${result.chunkCount ?? 0} chunks)${error}`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const pdfDirectory = optionValue("--pdf-dir", "data/mirae-sif-pdfs");
  const htmlDirectory = optionValue("--html-dir", "data/html-sources");
  const pdfFiles = await scan(pdfDirectory, "**/*.pdf");
  const htmlFiles = await scopedHtmlFiles(htmlDirectory);

  console.log(`Mirae SIF PDFs: ${pdfFiles.length}`);
  console.log(`SIF HTML/regulatory sources: ${htmlFiles.length}`);

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to replace and re-embed these sources.");
    return;
  }

  for (const filePath of pdfFiles) await replacePdf(filePath);
  for (const filePath of htmlFiles) await replaceHtml(filePath);
}

await main();
