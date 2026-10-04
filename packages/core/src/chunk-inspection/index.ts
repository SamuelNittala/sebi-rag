import {
  isCuratedFaqMetadata,
  type ChunkFlagSeverity,
} from "@mf-rag/types";

import type {
  ChunkInspectorConfig,
  ChunkInspectorContract,
  InspectionCandidate,
  InspectionFinding,
  InspectionInput,
  InspectionReport,
} from "./types.ts";

export * from "./types.ts";
export * from "./review-policy.ts";
export * from "./document-risk-policy.ts";
export * from "./manual-edit.ts";
export * from "./faq.ts";

const DEFAULT_CONFIG: ChunkInspectorConfig = {
  inspectorVersion: "1.2.0",
  maxTextTokens: 512,
  maxTableTokens: 1536,
  headingOnlyMaxTokens: 20,
};

const TABLE_LABELS = [
  /\bdepartment\b/i,
  /\bdesignation\b/i,
  /\beducational\s+qualification\b/i,
  /\btotal\s+(?:no\.?\s+of\s+)?years?\s+of\s+experience\b/i,
  /\bexperience\s*&\s*background\b/i,
];

const UNBOUND_CHART_FLAGS = ["chart_multi_series_unparsed", "chart_unpaired"];
/** Every value of the unbound chart also appears in a table or key-value chunk on its page. */
const CHART_VALUES_IN_TABLE_FLAG = "chart_values_in_table";
/** A label of at least 6 characters ending in `:` repeated adjacently, e.g. `Net AUM: Net AUM:`. */
const REPEATED_LABEL = /(?:^|\s)([^\s:|][^:|\n]{4,}:)\s*\1/u;
/** One `row label, column = value` triplet of Docling's table serialization. */
const TRIPLET = /^(.+?), (.+?) = (.+?)\.?$/u;

function finding(
  candidate: InspectionCandidate | null,
  ruleCode: string,
  severity: ChunkFlagSeverity,
  blocksApproval: boolean,
  message: string,
  evidence: Record<string, unknown> = {},
): InspectionFinding {
  return {
    candidateId: candidate?.id ?? null,
    chunkIndex: candidate?.chunkIndex ?? null,
    ruleCode,
    severity,
    blocksApproval,
    message,
    evidence,
  };
}

function normalizedHeading(text: string): string {
  return text.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function looksLikeUnmarkedTable(candidate: InspectionCandidate): boolean {
  if (candidate.hasTable) return false;
  const labelMatches = TABLE_LABELS.filter((pattern) => pattern.test(candidate.text)).length;
  const shortLineRatio = candidate.text.split("\n").filter((line) => {
    const length = line.trim().length;
    return length > 0 && length <= 32;
  }).length;
  return labelMatches >= 3 && shortLineRatio >= 5;
}

function hasBrokenContinuation(
  previous: InspectionCandidate,
  current: InspectionCandidate,
): boolean {
  const previousText = previous.text.trim();
  const currentText = current.text.trim();
  if (/--\s*$/.test(previousText) || /https?:\/\/\S*\/\s*$/i.test(previousText)) return false;
  if (!/(?:&|\band|[,/\-])\s*$/i.test(previousText)) return false;
  if (/^(?:fund\s+manager|dealer|analyst|head\b|manager\b)/i.test(currentText)) return true;
  const firstLine = currentText.split("\n", 1)[0] ?? "";
  return current.sectionHeader !== null
    && normalizedHeading(firstLine) === normalizedHeading(current.sectionHeader);
}

function candidateFindings(
  candidate: InspectionCandidate,
  input: InspectionInput,
  config: ChunkInspectorConfig,
): InspectionFinding[] {
  const findings: InspectionFinding[] = [];
  const text = candidate.text.trim();

  if (!text) {
    findings.push(finding(candidate, "EMPTY_CHUNK", "critical", true, "Chunk contains no text."));
  }

  if (candidate.pageNumbers.length === 0) {
    findings.push(finding(candidate, "MISSING_PAGE_REFERENCE", "critical", true, "Chunk has no page reference."));
  }

  const pageNumberBase = input.document.pageNumberBase ?? 1;
  const lastPage = input.document.pageCount === null
    ? null
    : input.document.pageCount - (pageNumberBase === 0 ? 1 : 0);
  const invalidPages = lastPage === null
    ? []
    : candidate.pageNumbers.filter((page) => page < pageNumberBase || page > lastPage);
  if (invalidPages.length > 0) {
    findings.push(finding(candidate, "PAGE_OUT_OF_RANGE", "critical", true, "Chunk references a page outside the document.", { invalidPages }));
  }

  const tokenLimit = candidate.hasTable ? config.maxTableTokens : config.maxTextTokens;
  if (candidate.tokenCount > tokenLimit) {
    findings.push(finding(candidate, "TOKEN_LIMIT_EXCEEDED", "critical", true, `Chunk exceeds its ${tokenLimit}-token limit.`, {
      tokenCount: candidate.tokenCount,
      tokenLimit,
    }));
  }

  if (looksLikeUnmarkedTable(candidate)) {
    findings.push(finding(candidate, "TABLE_LIKE_TEXT_NOT_MARKED_TABLE", "critical", true, "Chunk contains tabular labels but is marked as ordinary text."));
  }

  if (candidate.sectionHeader && candidate.tokenCount <= config.headingOnlyMaxTokens) {
    const body = normalizedHeading(text);
    const header = normalizedHeading(candidate.sectionHeader);
    if (body === header) {
      findings.push(finding(candidate, "HEADING_ONLY_CHUNK", "warning", false, "Chunk contains only its section heading."));
    }
  }

  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(candidate.text)) {
    findings.push(finding(candidate, "CORRUPTED_TEXT", "critical", true, "Chunk contains invalid control characters."));
  }

  if (candidate.metadata.documentScope === "unknown") {
    findings.push(finding(candidate, "REQUIRED_METADATA_MISSING", "warning", false, "Document scope is unknown.", { field: "documentScope" }));
  }

  const faq = isCuratedFaqMetadata(candidate.metadata);
  if (faq) {
    const question = typeof candidate.metadata.originalQuestion === "string"
      ? candidate.metadata.originalQuestion.trim()
      : "";
    const answer = typeof candidate.metadata.answer === "string"
      ? candidate.metadata.answer.trim()
      : "";
    const title = typeof candidate.metadata.documentTitle === "string"
      ? candidate.metadata.documentTitle.trim()
      : "";
    const publisher = typeof candidate.metadata.publisher === "string"
      ? candidate.metadata.publisher.trim()
      : "";
    const sourceUrl = typeof candidate.metadata.sourceUrl === "string"
      ? candidate.metadata.sourceUrl.trim()
      : "";
    if (!question) {
      findings.push(finding(candidate, "FAQ_QUESTION_MISSING", "critical", true, "FAQ candidate has no original question."));
    }
    if (!answer) {
      findings.push(finding(candidate, "FAQ_ANSWER_MISSING", "critical", true, "FAQ candidate has no answer."));
    }
    if (!title || !publisher || !sourceUrl) {
      findings.push(finding(candidate, "FAQ_SOURCE_MISSING", "critical", true, "FAQ candidate is missing title, publisher, or canonical source URL.", {
        fields: [
          ...(!title ? ["documentTitle"] : []),
          ...(!publisher ? ["publisher"] : []),
          ...(!sourceUrl ? ["sourceUrl"] : []),
        ],
      }));
    }
    if (input.ownership?.visibilityScope !== "GLOBAL" || input.ownership.tenantId !== null) {
      findings.push(finding(candidate, "FAQ_GLOBAL_OWNERSHIP_REQUIRED", "critical", true, "Curated FAQ candidates must use GLOBAL ownership."));
    }
    const questionMarkers = candidate.text.match(
      /(?:^|\n)\s*(?:Question\s*:|\d+[.)]\s+(?:what|why|when|where|who|which|how|can|could|do|does|is|are|should|will|would|may|if)\b)/gi,
    ) ?? [];
    if (questionMarkers.length > 1) {
      findings.push(finding(candidate, "FAQ_MERGED_QUESTIONS", "critical", true, "FAQ candidate appears to contain more than one question.", {
        questionMarkers: questionMarkers.length,
      }));
    }
    if (candidate.metadata.sourceCoverageComplete === false) {
      findings.push(finding(candidate, "FAQ_SOURCE_TEXT_LOSS", "critical", true, "FAQ parse contains unexplained source-text loss."));
    }
    if (/(?:^|\n)\s*(?:table of contents|contents|index)\s*(?:\n|$)/i.test(candidate.text)) {
      findings.push(finding(candidate, "FAQ_INDEX_LEAKAGE", "critical", true, "FAQ candidate contains cover or index-like content."));
    }
    if (/\b(?:tax|regulat(?:ion|ory)|limit|cut[- ]?off|deadline|current(?:ly)?|process|rate|percent|%)\b/i.test(
      `${question}\n${answer}`,
    )) {
      findings.push(finding(candidate, "FAQ_TIME_SENSITIVE", "warning", false, "FAQ guidance may be time-sensitive and requires reviewer acknowledgement.", {
        sourceDate: candidate.metadata.sourceDate ?? null,
        authority: candidate.metadata.authority ?? null,
      }));
    }
  }

  return findings;
}

function isDoclingCandidate(candidate: InspectionCandidate): boolean {
  return candidate.metadata.parser === "docling";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** First span duplication a missed Docling table span leaves behind, if any. */
function tableSpanDuplication(text: string): { pattern: string; line: string } | null {
  for (const line of text.split("\n").map((value) => value.trim())) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.some((cell, index) =>
      index > 0 && cell === cells[index - 1] && cell.length >= 6 && /\p{L}/u.test(cell)
    )) {
      return { pattern: "adjacent_cell", line: line.slice(0, 120) };
    }
    if (REPEATED_LABEL.test(line)) return { pattern: "repeated_label", line: line.slice(0, 120) };
    const tripletRepeatsLabel = line.split(/\.\s+/).some((part) => {
      const match = TRIPLET.exec(part.trim());
      const label = match?.[1]?.trim() ?? "";
      return /\p{L}/u.test(label) && label.toLowerCase() === match?.[3]?.trim().toLowerCase();
    });
    if (tripletRepeatsLabel) return { pattern: "triplet_label_value", line: line.slice(0, 120) };
  }
  return null;
}

/** Rules for Docling-parsed candidates only, so other parsers keep their findings unchanged. */
function doclingCandidateFindings(candidate: InspectionCandidate): InspectionFinding[] {
  if (!isDoclingCandidate(candidate)) return [];
  const findings: InspectionFinding[] = [];
  const chunkType = candidate.metadata.chunkType;
  const flags = stringList(candidate.metadata.normalizationFlags);
  if (chunkType === "table" || chunkType === "key_value") {
    const duplication = tableSpanDuplication(candidate.text);
    if (duplication) {
      findings.push(finding(candidate, "TABLE_SPAN_DUPLICATION", "critical", true, "Table text repeats a spanned cell or label; the parser likely missed a merged cell.", duplication));
    }
  }
  if (chunkType === "picture" && flags.some((flag) => UNBOUND_CHART_FLAGS.includes(flag))) {
    const inTable = flags.includes(CHART_VALUES_IN_TABLE_FLAG);
    findings.push(finding(
      candidate,
      "CHART_VALUES_UNBOUND",
      inTable ? "info" : "warning",
      false,
      inTable
        ? "Chart values could not be bound to their labels; all of its values appear in a table on the same page."
        : "Chart values could not be bound to their labels; verify them against the tabular source.",
      {
        classification: candidate.metadata.pictureClassification ?? null,
        flags,
      },
    ));
  }
  return findings;
}

function doclingDocumentFindings(candidates: InspectionCandidate[]): InspectionFinding[] {
  const diagnostics = candidates.find(isDoclingCandidate)?.metadata.parserDiagnostics as
    | { lowStructurePages?: unknown; uncoveredPages?: unknown }
    | undefined;
  const lowStructurePages = pageList(diagnostics?.lowStructurePages);
  const uncoveredPages = pageList(diagnostics?.uncoveredPages);
  if (lowStructurePages.length === 0 && uncoveredPages.length === 0) return [];
  return [finding(null, "LOW_STRUCTURE_PAGE", "warning", false, "Some pages yielded little structured text or no chunks; verify them against the source PDF.", {
    lowStructurePages,
    uncoveredPages,
  })];
}

function pageList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
}

function crossChunkFindings(candidates: InspectionCandidate[]): InspectionFinding[] {
  const findings: InspectionFinding[] = [];
  for (let index = 1; index < candidates.length; index++) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (!hasBrokenContinuation(previous, current)) continue;
    findings.push(finding(current, "CROSS_CHUNK_ROW_CONTINUATION", "critical", true, "A structured row or designation appears to continue across a chunk boundary.", {
      previousChunkIndex: previous.chunkIndex,
      currentChunkIndex: current.chunkIndex,
      previousEnding: previous.text.trim().slice(-120),
      currentBeginning: current.text.trim().slice(0, 120),
    }));
  }
  const faqCandidates = candidates.filter((candidate) =>
    isCuratedFaqMetadata(candidate.metadata)
  );
  const normalizedText = new Map<string, InspectionCandidate>();
  const normalizedQuestion = new Map<string, InspectionCandidate>();
  for (const candidate of faqCandidates) {
    const textKey = candidate.text.replace(/\s+/g, " ").trim().toLowerCase();
    const duplicate = normalizedText.get(textKey);
    if (textKey && duplicate) {
      findings.push(finding(candidate, "FAQ_EXACT_DUPLICATE", "critical", true, "FAQ candidate text exactly duplicates another candidate.", {
        duplicateCandidateId: duplicate.id,
      }));
    } else if (textKey) {
      normalizedText.set(textKey, candidate);
    }

    const questionKey = typeof candidate.metadata.normalizedQuestionKey === "string"
      ? candidate.metadata.normalizedQuestionKey.trim()
      : "";
    const previous = normalizedQuestion.get(questionKey);
    if (questionKey && previous) {
      const previousAnswer = String(previous.metadata.answer ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const answer = String(candidate.metadata.answer ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const differentSource = previous.metadata.sourceUrl !== candidate.metadata.sourceUrl;
      if (differentSource && previousAnswer && answer && previousAnswer !== answer) {
        findings.push(finding(candidate, "FAQ_CROSS_SOURCE_CONFLICT", "warning", false, "Different authoritative sources provide materially different answers to the same normalized question.", {
          comparedCandidateId: previous.id,
          sourceUrls: [previous.metadata.sourceUrl, candidate.metadata.sourceUrl],
          sourceDates: [previous.metadata.sourceDate, candidate.metadata.sourceDate],
        }));
      }
    } else if (questionKey) {
      normalizedQuestion.set(questionKey, candidate);
    }
  }
  return findings;
}

function documentFindings(candidates: InspectionCandidate[]): InspectionFinding[] {
  const addendum = candidates.find((candidate) => candidate.metadata.documentType === "Addendum");
  if (!addendum) return [];

  const requiredFields = ["fundName", "amendmentNumber", "effectiveDate"] as const;
  const missingFields = requiredFields.filter((field) => {
    const value = addendum.metadata[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  const semanticFallback = addendum.metadata.addendumChunkingMode === "semantic_fallback";
  if (missingFields.length === 0 && !semanticFallback) return [];

  const incompleteMetadata = missingFields.length > 0;

  return [finding(
    null,
    incompleteMetadata
      ? "ADDENDUM_METADATA_INCOMPLETE"
      : "ADDENDUM_SPECIALIZED_CHUNKING_UNAVAILABLE",
    "warning",
    false,
    incompleteMetadata
      ? "Addendum metadata is incomplete; semantic fallback chunks require reviewer acknowledgement."
      : "Addendum provisions could not be paired safely; semantic fallback chunks require reviewer acknowledgement.",
    {
      missingFields,
      fallbackReason: addendum.metadata.addendumFallbackReason ?? null,
    },
  )];
}

export class ChunkInspector implements ChunkInspectorContract {
  private readonly config: ChunkInspectorConfig;

  constructor(config: Partial<ChunkInspectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  inspect(input: InspectionInput): InspectionReport {
    const findings = input.candidates.flatMap((candidate) => [
      ...candidateFindings(candidate, input, this.config),
      ...doclingCandidateFindings(candidate),
    ]);
    findings.push(...crossChunkFindings(input.candidates));
    findings.push(...documentFindings(input.candidates));
    findings.push(...doclingDocumentFindings(input.candidates));

    if (input.candidates.length === 0) {
      findings.push(finding(null, "NO_CHUNKS", "critical", true, "Document produced no candidate chunks."));
    }

    return {
      inspectorVersion: this.config.inspectorVersion,
      candidateChunkCount: input.candidates.length,
      inspectedChunkCount: input.candidates.length,
      findings,
      criticalCount: findings.filter((item) => item.severity === "critical").length,
      warningCount: findings.filter((item) => item.severity === "warning").length,
      blockingCount: findings.filter((item) => item.blocksApproval).length,
    };
  }
}
