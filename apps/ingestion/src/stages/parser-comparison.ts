/**
 * Pure comparison of the unpdf and Docling parse paths after chunk inspection
 * (used by `scripts/compare-pdf-parsers.ts`, `bun run parse:compare`).
 *
 * Spec:
 * - Chunk counts: total, estimated tokens, and counts by chunk type. Docling
 *   candidates carry `metadata.chunkType`; unpdf candidates are `table` when
 *   `hasTable`, otherwise `text`.
 * - Findings: per rule code, each side's count and `delta = docling - unpdf`,
 *   with the rule's most severe observed severity; plus per-side totals.
 * - Numeric tokens (percentages, rupee amounts, plain decimals, dates), compared
 *   as sets per page over candidate chunk text. A chunk's tokens count for every
 *   page it covers, so a multi-page chunk can mask a gap on one of its pages.
 *   Plain integers are ignored (page numbers, counts and years are too noisy).
 * - Output is deterministic: rule codes, chunk types, pages and tokens sorted.
 */

import type { InspectionFinding, InspectionReport } from "@mf-rag/core/chunk-inspection";

import type { DoclingParserDiagnostics } from "../chunkers/docling-chunk-mapper.ts";
import type { PdfParseArtifact } from "./chunk-inspect-stage.ts";
import type { DoclingPdfParseArtifact } from "./docling-parse-stage.ts";

export interface PageRange {
  readonly first: number;
  readonly last: number;
}

export interface ComparisonCandidate {
  readonly text: string;
  readonly pageNumbers: readonly number[];
  readonly tokenCount: number;
  readonly hasTable: boolean;
  /** Docling candidates carry `chunkType`; any other metadata is ignored. */
  readonly metadata: object;
}

export interface ComparisonSideInput {
  readonly candidates: readonly ComparisonCandidate[];
  readonly report: InspectionReport;
  readonly parserDiagnostics?: DoclingParserDiagnostics | null;
  /** unpdf only: pdfplumber status; a failure means the unpdf side has no table chunks. */
  readonly tableExtractionStatus?: "succeeded" | "failed";
}

export interface ChunkSummary {
  readonly total: number;
  readonly tokens: number;
  readonly byType: Readonly<Record<string, number>>;
}

export interface RuleDelta {
  readonly ruleCode: string;
  readonly severity: string;
  readonly unpdf: number;
  readonly docling: number;
  readonly delta: number;
}

export interface FindingTotals {
  readonly findings: number;
  readonly critical: number;
  readonly warning: number;
  readonly blocking: number;
}

export interface PageTokenGap {
  readonly pageNumber: number;
  readonly unpdfCount: number;
  readonly doclingCount: number;
  readonly missingFromDocling: readonly string[];
  readonly missingFromUnpdf: readonly string[];
}

export interface ParserComparison {
  readonly filename: string;
  readonly pageRange: PageRange | null;
  readonly chunks: { readonly unpdf: ChunkSummary; readonly docling: ChunkSummary };
  readonly findings: {
    readonly byRule: readonly RuleDelta[];
    readonly totals: { readonly unpdf: FindingTotals; readonly docling: FindingTotals };
  };
  readonly numericTokens: {
    readonly pages: readonly PageTokenGap[];
    readonly totals: {
      readonly unpdf: number;
      readonly docling: number;
      readonly missingFromDocling: number;
      readonly missingFromUnpdf: number;
    };
  };
  readonly doclingDiagnostics: DoclingParserDiagnostics | null;
  readonly unpdfTableExtraction: "succeeded" | "failed" | null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const MONTH = `(${MONTHS.join("|")})[a-z]*\\.?`;
const NUMBER = String.raw`\d+(?:,\d{2,3})*(?:\.\d+)?`;
const DECIMAL = String.raw`\d+(?:,\d{2,3})*\.\d+`;
// A sign counts only when it is not a range or word hyphen (`1.2-3.4`, `FY-23`).
const SIGN = String.raw`(?:(?<![\w.,])([-−–]))?`;
const NOT_INSIDE_NUMBER = String.raw`(?<![\d.,])`;
const TOKEN_PATTERN = new RegExp([
  String.raw`(?<dmy>\b(\d{1,2})\s*(?:st|nd|rd|th)?[\s\-/.,]*${MONTH}[\s\-/.,]*(\d{4}|\d{2})\b)`,
  String.raw`(?<mdy>\b${MONTH}\s+(\d{1,2})\s*(?:st|nd|rd|th)?,?\s+(\d{4})\b)`,
  String.raw`(?<numeric>\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b)`,
  String.raw`(?<rupee>(?:₹|\bRs\.?|\bINR)\s*${SIGN}(${NUMBER})(?![\d]))`,
  String.raw`(?<percent>${SIGN}${NOT_INSIDE_NUMBER}(${NUMBER})\s*%)`,
  String.raw`(?<decimal>${SIGN}${NOT_INSIDE_NUMBER}(${DECIMAL})(?![\d]))`,
].join("|"), "giu");

/** Numeric tokens in text order, canonicalized so formatting differences between parsers do not count. */
export function extractNumericTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = canonicalToken(match);
    if (token) tokens.push(token);
  }
  return tokens;
}

function canonicalToken(match: RegExpMatchArray): string | null {
  const groups = match.slice(1);
  const at = (offset: number) => groups[offset];
  const sign = (value: string | undefined) => (value ? "-" : "");
  const g = match.groups ?? {};
  // Positional capture layout: dmy(0..3) mdy(4..7) numeric(8..11) rupee(12..14) percent(15..17) decimal(18..20).
  if (g.dmy) return dayMonthYear(at(1), at(2), at(3));
  if (g.mdy) return dayMonthYear(at(6), at(5), at(7));
  if (g.numeric) {
    const day = Number(at(9));
    const month = Number(at(10));
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${at(9)!.padStart(2, "0")}/${at(10)!.padStart(2, "0")}/${at(11)}`;
  }
  if (g.rupee) return `₹${sign(at(13))}${at(14)}`;
  if (g.percent) return `${sign(at(16))}${at(17)}%`;
  if (g.decimal) return `${sign(at(19))}${at(20)}`;
  return null;
}

function dayMonthYear(day: string | undefined, month: string | undefined, year: string | undefined): string | null {
  const dayNumber = Number(day);
  if (!month || !year || dayNumber < 1 || dayNumber > 31) return null;
  return `${dayNumber} ${month.toLowerCase().slice(0, 3)} ${year.length === 2 ? `20${year}` : year}`;
}

export function compareParserInspections(input: {
  readonly filename: string;
  readonly pageRange: PageRange | null;
  readonly unpdf: ComparisonSideInput;
  readonly docling: ComparisonSideInput;
}): ParserComparison {
  const unpdfTokens = tokensByPage(input.unpdf.candidates);
  const doclingTokens = tokensByPage(input.docling.candidates);
  const pageNumbers = [...new Set([...unpdfTokens.keys(), ...doclingTokens.keys()])].sort((a, b) => a - b);
  const pages = pageNumbers.map((pageNumber): PageTokenGap => {
    const unpdf = unpdfTokens.get(pageNumber) ?? new Set<string>();
    const docling = doclingTokens.get(pageNumber) ?? new Set<string>();
    return {
      pageNumber,
      unpdfCount: unpdf.size,
      doclingCount: docling.size,
      missingFromDocling: [...unpdf].filter((token) => !docling.has(token)).sort(),
      missingFromUnpdf: [...docling].filter((token) => !unpdf.has(token)).sort(),
    };
  });
  const sum = (pick: (page: PageTokenGap) => number) => pages.reduce((total, page) => total + pick(page), 0);
  return {
    filename: input.filename,
    pageRange: input.pageRange,
    chunks: { unpdf: chunkSummary(input.unpdf.candidates), docling: chunkSummary(input.docling.candidates) },
    findings: {
      byRule: ruleDeltas(input.unpdf.report.findings, input.docling.report.findings),
      totals: { unpdf: findingTotals(input.unpdf.report.findings), docling: findingTotals(input.docling.report.findings) },
    },
    numericTokens: {
      pages,
      totals: {
        unpdf: sum((page) => page.unpdfCount),
        docling: sum((page) => page.doclingCount),
        missingFromDocling: sum((page) => page.missingFromDocling.length),
        missingFromUnpdf: sum((page) => page.missingFromUnpdf.length),
      },
    },
    doclingDiagnostics: input.docling.parserDiagnostics ?? null,
    unpdfTableExtraction: input.unpdf.tableExtractionStatus ?? null,
  };
}

function tokensByPage(candidates: readonly ComparisonCandidate[]): Map<number, Set<string>> {
  const byPage = new Map<number, Set<string>>();
  for (const candidate of candidates) {
    const tokens = extractNumericTokens(candidate.text);
    for (const pageNumber of candidate.pageNumbers) {
      const set = byPage.get(pageNumber) ?? new Set<string>();
      for (const token of tokens) set.add(token);
      byPage.set(pageNumber, set);
    }
  }
  return byPage;
}

function chunkSummary(candidates: readonly ComparisonCandidate[]): ChunkSummary {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const { chunkType } = candidate.metadata as { readonly chunkType?: unknown };
    const type = typeof chunkType === "string" ? chunkType : candidate.hasTable ? "table" : "text";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return {
    total: candidates.length,
    tokens: candidates.reduce((total, candidate) => total + candidate.tokenCount, 0),
    byType: Object.fromEntries([...counts].sort(([a], [b]) => compareText(a, b))),
  };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 3, warning: 2, info: 1 };

function ruleDeltas(unpdf: readonly InspectionFinding[], docling: readonly InspectionFinding[]): RuleDelta[] {
  const rules = new Map<string, { severity: string; unpdf: number; docling: number }>();
  const add = (finding: InspectionFinding, sideKey: "unpdf" | "docling") => {
    const entry = rules.get(finding.ruleCode) ?? { severity: finding.severity, unpdf: 0, docling: 0 };
    if ((SEVERITY_RANK[finding.severity] ?? 0) > (SEVERITY_RANK[entry.severity] ?? 0)) entry.severity = finding.severity;
    entry[sideKey] += 1;
    rules.set(finding.ruleCode, entry);
  };
  unpdf.forEach((finding) => add(finding, "unpdf"));
  docling.forEach((finding) => add(finding, "docling"));
  return [...rules]
    .sort(([a], [b]) => compareText(a, b))
    .map(([ruleCode, entry]) => ({ ruleCode, ...entry, delta: entry.docling - entry.unpdf }));
}

function findingTotals(findings: readonly InspectionFinding[]): FindingTotals {
  return {
    findings: findings.length,
    critical: findings.filter((finding) => finding.severity === "critical").length,
    warning: findings.filter((finding) => finding.severity === "warning").length,
    blocking: findings.filter((finding) => finding.blocksApproval).length,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ComparisonReportContext {
  readonly parserVersions: { readonly unpdf: string; readonly docling: string };
}

export function renderComparisonMarkdown(
  comparisons: readonly ParserComparison[],
  context: ComparisonReportContext,
): string {
  const lines = [
    "# Parser comparison",
    "",
    `unpdf: \`${context.parserVersions.unpdf}\` · Docling: \`${context.parserVersions.docling}\``,
    "",
    "Numeric tokens are percentages, rupee amounts, plain decimals and dates, compared per page over inspected chunk text.",
    "",
    "## Summary",
    "",
    "| Document | unpdf chunks | Docling chunks | unpdf findings | Docling findings | unpdf blocking | Docling blocking | Tokens missing from Docling | Tokens missing from unpdf |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...comparisons.map((c) => row([
      documentLabel(c),
      c.chunks.unpdf.total,
      c.chunks.docling.total,
      c.findings.totals.unpdf.findings,
      c.findings.totals.docling.findings,
      c.findings.totals.unpdf.blocking,
      c.findings.totals.docling.blocking,
      c.numericTokens.totals.missingFromDocling,
      c.numericTokens.totals.missingFromUnpdf,
    ])),
  ];
  for (const comparison of comparisons) lines.push("", ...documentSection(comparison));
  return `${lines.join("\n")}\n`;
}

function documentSection(c: ParserComparison): string[] {
  const types = [...new Set([...Object.keys(c.chunks.unpdf.byType), ...Object.keys(c.chunks.docling.byType)])].sort(compareText);
  const gaps = c.numericTokens.pages.filter((page) => page.missingFromDocling.length + page.missingFromUnpdf.length > 0);
  const lines = [
    `## ${escapeCell(documentLabel(c))}`,
    "",
    ...(c.unpdfTableExtraction === "failed"
      ? ["**Warning:** unpdf table extraction failed (pdfplumber); the unpdf side has no table chunks.", ""]
      : []),
    "### Chunks",
    "",
    "| Type | unpdf | Docling |",
    "| --- | --- | --- |",
    ...types.map((type) => row([type, c.chunks.unpdf.byType[type] ?? 0, c.chunks.docling.byType[type] ?? 0])),
    row(["**total**", c.chunks.unpdf.total, c.chunks.docling.total]),
    row(["estimated tokens", c.chunks.unpdf.tokens, c.chunks.docling.tokens]),
    "",
    "### Findings by rule",
    "",
  ];
  if (c.findings.byRule.length === 0) {
    lines.push("No findings on either side.");
  } else {
    lines.push(
      "| Rule | Severity | unpdf | Docling | Delta |",
      "| --- | --- | --- | --- | --- |",
      ...c.findings.byRule.map((rule) => row([rule.ruleCode, rule.severity, rule.unpdf, rule.docling, signed(rule.delta)])),
    );
  }
  if (c.doclingDiagnostics) {
    lines.push(
      "",
      `Docling low-structure pages: ${pageList(c.doclingDiagnostics.lowStructurePages)}; uncovered pages: ${pageList(c.doclingDiagnostics.uncoveredPages)}.`,
    );
  }
  const totals = c.numericTokens.totals;
  lines.push(
    "",
    "### Numeric tokens",
    "",
    `Distinct per-page tokens: unpdf ${totals.unpdf}, Docling ${totals.docling}; missing from Docling ${totals.missingFromDocling}, missing from unpdf ${totals.missingFromUnpdf}.`,
    "",
  );
  if (gaps.length === 0) {
    lines.push("No per-page gaps.");
  } else {
    lines.push(
      "| Page | Missing from Docling | Missing from unpdf |",
      "| --- | --- | --- |",
      ...gaps.map((page) => row([page.pageNumber, page.missingFromDocling.join(", "), page.missingFromUnpdf.join(", ")])),
    );
  }
  return lines;
}

function documentLabel(c: ParserComparison): string {
  return c.pageRange ? `${c.filename} (pages ${c.pageRange.first}-${c.pageRange.last})` : c.filename;
}

function row(cells: readonly (string | number)[]): string {
  return `| ${cells.map((cell) => escapeCell(String(cell))).join(" | ")} |`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function pageList(pages: readonly number[]): string {
  return pages.length ? pages.join(", ") : "none";
}

/** `"7"` or an inclusive `"34-35"`; one-indexed. */
export function parsePageRange(value: string): PageRange {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value.trim());
  const first = Number(match?.[1]);
  const last = match?.[2] === undefined ? first : Number(match[2]);
  if (!match || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
    throw new Error(`Invalid page range '${value}': use N or FIRST-LAST (one-indexed, FIRST <= LAST).`);
  }
  return { first, last };
}

/**
 * Restricts a full-document parse artifact to a page range before chunking, so
 * both parsers see the same pages. Page numbers and `diagnostics.pageCount`
 * stay those of the full document; Docling chunks are kept only when every page
 * they cover is in range (a chunk straddling the boundary is dropped).
 */
export function restrictArtifactToPages<T extends PdfParseArtifact>(artifact: T, range: PageRange): T;
export function restrictArtifactToPages(artifact: PdfParseArtifact, range: PageRange): PdfParseArtifact {
  if (range.last > artifact.pages.length) {
    throw new Error(`Page range ${range.first}-${range.last} exceeds the document's ${artifact.pages.length} pages.`);
  }
  const inRange = (pageNumber: number) => pageNumber >= range.first && pageNumber <= range.last;
  if ("kind" in artifact.parser && artifact.parser.kind === "docling") {
    const docling = artifact as DoclingPdfParseArtifact;
    return {
      ...docling,
      pages: docling.pages.filter((page) => inRange(page.pageNumber)),
      chunks: docling.chunks.filter((chunk) => chunk.pages.every(inRange)),
    };
  }
  const unpdf = artifact as Exclude<PdfParseArtifact, DoclingPdfParseArtifact>;
  return {
    ...unpdf,
    pages: unpdf.pages.filter((page) => inRange(page.pageNumber)),
    tables: unpdf.tables.filter((table) => inRange(table.pageNumber)),
  };
}
