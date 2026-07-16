import type { ChunkFlagSeverity } from "@mf-rag/types";

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
export * from "./manual-edit.ts";

const DEFAULT_CONFIG: ChunkInspectorConfig = {
  inspectorVersion: "1.0.0",
  maxTextTokens: 512,
  maxTableTokens: 1024,
  headingOnlyMaxTokens: 20,
};

const TABLE_LABELS = [
  /\bdepartment\b/i,
  /\bdesignation\b/i,
  /\beducational\s+qualification\b/i,
  /\btotal\s+(?:no\.?\s+of\s+)?years?\s+of\s+experience\b/i,
  /\bexperience\s*&\s*background\b/i,
];

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

  return findings;
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
  return findings;
}

export class ChunkInspector implements ChunkInspectorContract {
  private readonly config: ChunkInspectorConfig;

  constructor(config: Partial<ChunkInspectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  inspect(input: InspectionInput): InspectionReport {
    const findings = input.candidates.flatMap((candidate) =>
      candidateFindings(candidate, input, this.config)
    );
    findings.push(...crossChunkFindings(input.candidates));

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
