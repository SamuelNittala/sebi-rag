/**
 * HTML (Markdown) Parser for MF-RAG System
 *
 * Reads stored .md files with frontmatter and produces ChunkInput
 * compatible with the existing semantic chunker.
 *
 * Splitting strategy:
 * 1. Parse YAML frontmatter for metadata
 * 2. Split content at h2 boundaries as primary sections
 * 3. Each h2 section becomes a "page" in ChunkInput
 * 4. Tables are extracted and passed separately
 */

import type { ChunkInput } from "../chunkers/semantic-chunker.ts";
import type { ContentCategory } from "@mf-rag/types";

export interface ParsedHtmlFrontmatter {
  title: string;
  source_url: string;
  content_category: ContentCategory;
  source: string;
  scraped_at: string;
  source_date?: string;
  source_artifact_url?: string;
}

export interface ParsedHtmlDocument {
  frontmatter: ParsedHtmlFrontmatter;
  sections: Array<{
    heading: string | null;
    text: string;
    sectionIndex: number;
  }>;
  rawText: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed metadata and the remaining content.
 */
export function parseFrontmatter(content: string): {
  frontmatter: ParsedHtmlFrontmatter;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error("No frontmatter found in markdown file");
  }

  const yamlBlock = match[1];
  const body = content.slice(match[0].length).trim();

  // Simple YAML parser - handles key: value and key: "quoted value"
  const frontmatter: Record<string, string> = {};
  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2];
    }
  }

  return {
    frontmatter: {
      title: frontmatter.title || "",
      source_url: frontmatter.source_url || "",
      content_category: (frontmatter.content_category || "education") as ContentCategory,
      source: frontmatter.source || "",
      scraped_at: frontmatter.scraped_at || "",
      source_date: frontmatter.source_date || undefined,
      source_artifact_url: frontmatter.source_artifact_url || undefined,
    },
    body,
  };
}

/**
 * Split markdown content into sections by h2 headings.
 * Content before the first h2 goes into the first section.
 */
export function splitByHeadings(markdown: string): Array<{
  heading: string | null;
  text: string;
}> {
  const sections: Array<{ heading: string | null; text: string }> = [];

  // Split at h2 boundaries (## Heading)
  const h2Pattern = /^## .+$/gm;
  const headingMatches: Array<{ index: number; heading: string }> = [];

  let match;
  while ((match = h2Pattern.exec(markdown)) !== null) {
    headingMatches.push({
      index: match.index,
      heading: match[0].replace(/^## /, "").trim(),
    });
  }

  if (headingMatches.length === 0) {
    // No h2 headings found - return entire content as one section
    const trimmed = markdown.trim();
    if (trimmed) {
      sections.push({ heading: null, text: trimmed });
    }
    return sections;
  }

  // Content before first h2
  const preamble = markdown.slice(0, headingMatches[0].index).trim();
  if (preamble) {
    // Extract h1 as heading if present
    const h1Match = preamble.match(/^# (.+)$/m);
    sections.push({
      heading: h1Match ? h1Match[1].trim() : null,
      text: preamble,
    });
  }

  // Each h2 section
  for (let i = 0; i < headingMatches.length; i++) {
    const start = headingMatches[i].index;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : markdown.length;
    const text = markdown.slice(start, end).trim();

    if (text) {
      sections.push({
        heading: headingMatches[i].heading,
        text,
      });
    }
  }

  return sections;
}

/**
 * Extract markdown tables from a section.
 * Returns the tables and the section text with tables removed.
 */
export function extractTables(text: string): {
  textWithoutTables: string;
  tables: string[];
} {
  const tablePattern = /(?:^|\n)(\|.+\|(?:\n\|.+\|)+)/g;
  const tables: string[] = [];
  let textWithoutTables = text;

  let match;
  while ((match = tablePattern.exec(text)) !== null) {
    tables.push(match[1].trim());
  }

  if (tables.length > 0) {
    for (const table of tables) {
      textWithoutTables = textWithoutTables.replace(table, "").trim();
    }
  }

  return { textWithoutTables, tables };
}

/**
 * Parse a markdown file and produce a ParsedHtmlDocument.
 */
export function parseHtmlMarkdown(content: string): ParsedHtmlDocument {
  const { frontmatter, body } = parseFrontmatter(content);
  const rawSections = splitByHeadings(body);

  const sections = rawSections.map((section, idx) => ({
    heading: section.heading,
    text: section.text,
    sectionIndex: idx,
  }));

  return {
    frontmatter,
    sections,
    rawText: body,
  };
}

/**
 * Convert a ParsedHtmlDocument to ChunkInput for the semantic chunker.
 * Each section becomes a "page" (using sectionIndex as pageNumber).
 * Tables are extracted and passed separately.
 */
export function toChunkInput(parsed: ParsedHtmlDocument): ChunkInput {
  const pages: ChunkInput["pages"] = [];
  const tables: NonNullable<ChunkInput["tables"]> = [];

  for (const section of parsed.sections) {
    const { textWithoutTables, tables: sectionTables } = extractTables(section.text);

    pages.push({
      pageNumber: section.sectionIndex,
      text: textWithoutTables,
    });

    for (const table of sectionTables) {
      tables.push({
        pageNumber: section.sectionIndex,
        markdown: table,
      });
    }
  }

  return { pages, tables: tables.length > 0 ? tables : undefined };
}

/**
 * Read and parse a .md file from disk.
 */
export async function parseHtmlFile(filePath: string): Promise<ParsedHtmlDocument> {
  const file = Bun.file(filePath);
  const content = await file.text();
  return parseHtmlMarkdown(content);
}
