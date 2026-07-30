import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { chunkFaqItems, type FaqChunkResult } from "../chunkers/faq-chunker.ts";
import { parseFaqPages, type FaqParseResult } from "../parsers/faq-parser.ts";
import { parsePDF } from "../parsers/pdf-parser.ts";
import {
  downloadCuratedFaqSource,
  getFaqSource,
  type FaqSourceDefinition,
} from "../sources/index.ts";

export interface PrepareCuratedFaqOptions {
  root?: string;
}

export interface PreparedCuratedFaq {
  source: FaqSourceDefinition;
  artifactPath: string;
  artifactReused: boolean;
  markdownPreviewPath: string;
  chunkManifestPath: string;
  parse: FaqParseResult;
  chunks: FaqChunkResult;
}

interface FaqPreviewManifest {
  schemaVersion: 1;
  source: {
    id: string;
    title: string;
    publisher: string;
    authority: string;
    canonicalUrl: string;
    sourceDate: string;
    sha256: string;
    parserProfile: string;
    documentKind: "FAQ";
    knowledgeDomain: "mutual_fund";
    sourceCollection: "general_mf_faq";
    ownership: FaqSourceDefinition["ownership"];
    questionNumberContract: FaqSourceDefinition["expectedQuestionNumbers"] | null;
  };
  readiness: {
    reviewReady: boolean;
    blockers: string[];
    warnings: FaqParseResult["warnings"];
  };
  coverage: FaqParseResult["coverage"];
  questionCount: number;
  chunkCount: number;
  chunks: FaqChunkResult["chunks"];
}

function renderMarkdown(
  source: FaqSourceDefinition,
  parse: FaqParseResult,
): string {
  const lines = [
    `# ${source.title}`,
    "",
    `- Source ID: \`${source.id}\``,
    `- Publisher: ${source.publisher}`,
    `- Authority: ${source.authority}`,
    `- Source date: ${source.sourceDate}`,
    `- Canonical URL: ${source.canonicalUrl}`,
    `- SHA-256: \`${source.sha256}\``,
    `- Parser profile: \`${source.parserProfile}\``,
    `- Ownership: GLOBAL (\`${source.ownership.ownershipManifestId}@${source.ownership.ownershipManifestVersion}\`)`,
    `- Review ready: ${parse.reviewReady ? "yes" : "no"}`,
    `- Questions: ${parse.items.length}`,
    `- Coverage: ${parse.coverage.assignedSegmentCount} assigned, ${parse.coverage.excluded.length} excluded, ${parse.coverage.unexplained.length} unexplained`,
    "",
  ];
  if (source.expectedQuestionNumbers?.exclusions?.length) {
    lines.push("## Source numbering exclusions", "");
    for (const exclusion of source.expectedQuestionNumbers.exclusions) {
      lines.push(`- ${exclusion.number}: ${exclusion.reason}`);
    }
    lines.push("");
  }

  if (parse.blockers.length > 0) {
    lines.push("## Blocking findings", "");
    for (const blocker of parse.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }
  if (parse.warnings.length > 0) {
    lines.push("## Review warnings", "");
    for (const warning of parse.warnings) lines.push(`- ${warning.message}`);
    lines.push("");
  }
  if (parse.coverage.excluded.length > 0) {
    const exclusionCounts = new Map<string, number>();
    for (const exclusion of parse.coverage.excluded) {
      exclusionCounts.set(
        exclusion.reason,
        (exclusionCounts.get(exclusion.reason) ?? 0) + 1,
      );
    }
    lines.push("## Accounted exclusions", "");
    for (const [reason, count] of [...exclusionCounts].sort()) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }
  if (parse.coverage.unexplained.length > 0) {
    lines.push("## Unexplained source segments", "");
    for (const segment of parse.coverage.unexplained) {
      lines.push(`- Page ${segment.pageNumber}: ${segment.text}`);
    }
    lines.push("");
  }

  lines.push("## FAQ candidates", "");
  parse.items.forEach((item, index) => {
    const number = item.questionNumber ? `${item.questionNumber}. ` : "";
    lines.push(`### ${number}${item.question}`, "");
    lines.push(`Pages: ${item.pageNumbers.join(", ")}`);
    if (item.topic) lines.push(`Topic: ${item.topic}`);
    lines.push("", item.answer, "");
  });
  return `${lines.join("\n").trim()}\n`;
}

function buildManifest(
  source: FaqSourceDefinition,
  parse: FaqParseResult,
  chunks: FaqChunkResult,
): FaqPreviewManifest {
  return {
    schemaVersion: 1,
    source: {
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      authority: source.authority,
      canonicalUrl: source.canonicalUrl,
      sourceDate: source.sourceDate,
      sha256: source.sha256,
      parserProfile: source.parserProfile,
      documentKind: source.documentKind,
      knowledgeDomain: source.knowledgeDomain,
      sourceCollection: source.sourceCollection,
      ownership: source.ownership,
      questionNumberContract: source.expectedQuestionNumbers ?? null,
    },
    readiness: {
      reviewReady: parse.reviewReady,
      blockers: parse.blockers,
      warnings: parse.warnings,
    },
    coverage: parse.coverage,
    questionCount: parse.items.length,
    chunkCount: chunks.totalChunks,
    chunks: chunks.chunks,
  };
}

async function writeImmutable(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(path, "utf8");
    if (existing !== content) {
      throw new Error(
        `Immutable FAQ preview already exists with different content: ${path}`,
      );
    }
  }
}

export function assertFaqReviewReady(prepared: PreparedCuratedFaq): void {
  if (!prepared.parse.reviewReady) {
    throw new Error(
      `FAQ source ${prepared.source.id} is not review-ready: ${prepared.parse.blockers.join(" ")}`,
    );
  }
}

/**
 * Downloads, verifies, parses, chunks, and writes review artifacts only.
 * This function intentionally has no embedding or publication dependency.
 */
export async function prepareCuratedFaqSource(
  sourceId: string,
  options: PrepareCuratedFaqOptions = {},
): Promise<PreparedCuratedFaq> {
  const root = resolve(options.root ?? "data/curated-faq");
  const source = getFaqSource(sourceId);
  const download = await downloadCuratedFaqSource(source, { root });
  const pdf = await parsePDF(download.artifactPath);
  const parse = parseFaqPages({
    profile: source.parserProfile,
    pages: pdf.pages,
    expectedQuestionCount: source.expectedQuestionCount,
    expectedQuestionNumbers: source.expectedQuestionNumbers,
  });
  const chunks = chunkFaqItems({
    source,
    items: parse.items.filter((item) => item.question && item.answer),
  });
  const previewRoot = join(root, "previews", source.id, source.sha256);
  const markdownPreviewPath = join(previewRoot, "cleaned.md");
  const chunkManifestPath = join(previewRoot, "chunks.json");
  await writeImmutable(markdownPreviewPath, renderMarkdown(source, parse));
  await writeImmutable(
    chunkManifestPath,
    `${JSON.stringify(buildManifest(source, parse, chunks), null, 2)}\n`,
  );

  return {
    source,
    artifactPath: download.artifactPath,
    artifactReused: download.reused,
    markdownPreviewPath,
    chunkManifestPath,
    parse,
    chunks,
  };
}
