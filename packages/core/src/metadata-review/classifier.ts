import { createHash } from "node:crypto";

import type {
  MetadataReviewFinding,
  MiraeSifDocumentIdentity,
  MiraeSifFactType,
  MiraeSifMetadataProposal,
  MiraeSifSectionType,
  MiraeSifSourceChunk,
  MiraeSifSourceDocument,
  PreparedMetadataReview,
} from "./contracts.ts";

const PLATINUM_STRATEGY_ID = "platinum-hybrid-long-short-fund";
const PLATINUM_STRATEGY_NAME = "Platinum Hybrid Long-Short Fund";

interface SectionRule {
  sectionType: MiraeSifSectionType;
  factType: MiraeSifFactType | null;
  pattern: RegExp;
}

const SECTION_RULES: readonly SectionRule[] = [
  { sectionType: "investment_objective", factType: "investment_objective", pattern: /\binvestment\s+objective\b/i },
  { sectionType: "strategy_management", factType: "fund_manager", pattern: /who\s+manages\s+the\s+investment\s+strategy|^fund\s+managers?$/i },
  { sectionType: "investment_approach", factType: "investment_approach", pattern: /\binvestment\s+approach\b/i },
  { sectionType: "investment_strategy", factType: "investment_strategy", pattern: /\binvestment\s+strateg(?:y|ies)\b/i },
  { sectionType: "minimum_investment", factType: "minimum_investment", pattern: /minimum\s+(?:investment|application|subscription)/i },
  { sectionType: "exit_load", factType: "exit_load", pattern: /\bexit\s+load\b|^load\s+structure$/i },
  { sectionType: "benchmark", factType: "benchmark", pattern: /\bbenchmark\b/i },
  { sectionType: "expenses", factType: "expenses", pattern: /\b(?:expenses?|expense\s+ratio|TER)\b/i },
  { sectionType: "redemption", factType: "redemption", pattern: /\b(?:redemption|redeem|repurchase)\b/i },
  { sectionType: "eligibility", factType: "eligibility", pattern: /\b(?:eligibility|eligible|who\s+can\s+invest)\b/i },
  { sectionType: "risk", factType: "risk", pattern: /\brisk(?:\s+band|\s+profile|\s+factors?)?\b/i },
  { sectionType: "fund_facts", factType: null, pattern: /^fund\s+(?:facts?|details)$/i },
];

const BODY_RULES: readonly SectionRule[] = [
  { sectionType: "investment_objective", factType: "investment_objective", pattern: /\b(?:the\s+)?investment\s+(?:strategy's\s+)?objective\s+(?:is|shall|will|seeks?)\b/i },
  { sectionType: "strategy_management", factType: "fund_manager", pattern: /\b(?:fund\s+manager|managed\s+by)\b/i },
  { sectionType: "minimum_investment", factType: "minimum_investment", pattern: /\bminimum\s+(?:investment|application)\s+(?:amount|threshold)\b/i },
  { sectionType: "exit_load", factType: "exit_load", pattern: /\bexit\s+load\b/i },
  { sectionType: "benchmark", factType: "benchmark", pattern: /\bbenchmark(?:\s+index)?\b/i },
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuid(value: string): string {
  const hash = sha256(value);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function platinumIdentity(
  sourceAuthority: MiraeSifDocumentIdentity["sourceAuthority"],
): MiraeSifDocumentIdentity {
  return {
    documentScope: "strategy",
    strategyId: PLATINUM_STRATEGY_ID,
    canonicalStrategyName: PLATINUM_STRATEGY_NAME,
    sourceAuthority,
  };
}

export function resolveMiraeSifDocumentIdentity(
  document: MiraeSifSourceDocument,
): MiraeSifDocumentIdentity {
  const name = document.sourceName;
  const location = document.sourceLocation ?? "";
  if (/SAI[-_\s]SIF/i.test(name)) {
    return {
      documentScope: "sif_umbrella",
      strategyId: null,
      canonicalStrategyName: null,
      sourceAuthority: "regulatory_filing",
    };
  }
  if (document.sourceType === "html" && (
    name === PLATINUM_STRATEGY_NAME || /schemeCode=3166/i.test(location)
  )) {
    return platinumIdentity("official_product_page");
  }
  if (/\b(?:ISID|KIM)[-_]/i.test(name)) {
    return platinumIdentity("regulatory_filing");
  }
  if (/\b(?:Presentation|One-Pager)\b/i.test(name)) {
    return platinumIdentity("marketing");
  }
  return {
    documentScope: "unknown",
    strategyId: null,
    canonicalStrategyName: null,
    sourceAuthority: "unknown",
  };
}

function staffDirectoryOverride(
  heading: string,
  identity: MiraeSifDocumentIdentity,
): SectionRule | null {
  if (identity.documentScope !== "strategy" && /^fund\s+manager$/i.test(heading.trim())) {
    return { sectionType: "staff_directory", factType: null, pattern: /^fund\s+manager$/i };
  }
  return null;
}

function matchingRules(text: string, rules: readonly SectionRule[]): SectionRule[] {
  return rules.filter((rule) => rule.pattern.test(text));
}

function metadataForChunk(
  identity: MiraeSifDocumentIdentity,
  chunk: MiraeSifSourceChunk,
): { proposal: MiraeSifMetadataProposal; findings: MetadataReviewFinding[] } {
  const heading = chunk.sectionHeader?.trim() ?? "";
  const staffDirectory = heading ? staffDirectoryOverride(heading, identity) : null;
  const rawHeadingMatches = staffDirectory ? [staffDirectory] : matchingRules(heading, SECTION_RULES);
  const headingMatches = rawHeadingMatches[0]?.sectionType === "strategy_management"
    ? [rawHeadingMatches[0]]
    : rawHeadingMatches;
  const bodyMatches = headingMatches.length === 0
    ? matchingRules(chunk.text, BODY_RULES).map((match) => (
        identity.documentScope !== "strategy" && match.factType === "fund_manager"
          ? { ...match, sectionType: "staff_directory" as const, factType: null }
          : match
      ))
    : [];
  const matches = headingMatches.length > 0 ? headingMatches : bodyMatches;
  const selected = matches[0];
  const classificationSource = headingMatches.length > 0
    ? "exact_heading" as const
    : bodyMatches.length > 0
      ? "body_evidence" as const
      : "document_manifest" as const;
  const confidence = headingMatches.length > 0 ? 1 : bodyMatches.length > 0 ? 0.7 : 0.5;
  const evidence = headingMatches.length > 0
    ? [heading]
    : bodyMatches.length > 0
      ? [chunk.text.slice(0, 240)]
      : ["No recognized fact evidence; inherited document identity only."];
  const proposal: MiraeSifMetadataProposal = {
    ...identity,
    sourceChunkId: chunk.id,
    sectionType: selected?.sectionType ?? "unknown",
    factType: selected?.factType ?? null,
    confidence,
    classificationSource,
    evidence,
  };
  const findings: MetadataReviewFinding[] = [];
  const candidateId = stableUuid(`${chunk.id}:${sha256(chunk.text)}`);
  if (bodyMatches.length === 1) {
    findings.push({
      candidateId,
      chunkIndex: chunk.chunkIndex,
      ruleCode: "METADATA_BODY_ONLY_FACT",
      severity: "warning",
      blocksApproval: false,
      message: "A fact type was inferred from body text because no recognized section heading was available.",
      evidence: { factType: proposal.factType, excerpt: evidence[0] },
    });
  }
  if (matches.length > 1) {
    findings.push({
      candidateId,
      chunkIndex: chunk.chunkIndex,
      ruleCode: "METADATA_AMBIGUOUS_FACT",
      severity: "critical",
      blocksApproval: true,
      message: "More than one metadata fact type matched this chunk.",
      evidence: { matches: matches.map((match) => match.factType ?? match.sectionType) },
    });
  }
  return { proposal, findings };
}

function estimateTokenCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round(words * 1.3);
}

export function prepareMiraeSifMetadataReview(input: {
  document: MiraeSifSourceDocument;
  chunks: MiraeSifSourceChunk[];
}): PreparedMetadataReview {
  const identity = resolveMiraeSifDocumentIdentity(input.document);
  const findings: MetadataReviewFinding[] = [];
  if (identity.documentScope === "unknown") {
    findings.push({
      candidateId: null,
      chunkIndex: null,
      ruleCode: "METADATA_UNKNOWN_DOCUMENT",
      severity: "critical",
      blocksApproval: true,
      message: "This document is not in the reviewed Mirae SIF metadata manifest.",
      evidence: {
        sourceName: input.document.sourceName,
        sourceLocation: input.document.sourceLocation,
      },
    });
  }
  const candidates = input.chunks.map((chunk) => {
    const classified = metadataForChunk(identity, chunk);
    findings.push(...classified.findings);
    const contentHash = sha256(chunk.text);
    return {
      id: stableUuid(`${chunk.id}:${contentHash}`),
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      pageNumbers: chunk.pageNumbers,
      tokenCount: estimateTokenCount(chunk.text),
      hasTable: chunk.hasTable,
      sectionHeader: chunk.sectionHeader,
      metadata: classified.proposal,
      contentHash,
    };
  });
  return { candidates, findings };
}
