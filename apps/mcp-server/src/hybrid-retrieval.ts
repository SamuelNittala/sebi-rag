import type { CandidateChunkMetadata } from "@mf-rag/types";

import type {
  FusedRetrievalCandidate,
  HybridFusionInput,
  HybridRetrievalCandidate,
  RetrievalFactIntent,
  RetrievalIntent,
  RetrievalTrace,
} from "./hybrid-retrieval-contracts.ts";

const PLATINUM_STRATEGY_ID = "platinum-hybrid-long-short-fund";
const PLATINUM_PATTERN = /\bplatinum\b/i;
const SIF_PATTERN = /\bSIFs?\b|speciali[sz]ed\s+investment\s+funds?\b/i;
const FACT_COORDINATOR_PATTERN = /\b(?:and|or)\b|[&,;/]/i;

const FACT_PATTERNS: ReadonlyArray<[RetrievalFactIntent, RegExp]> = [
  ["fund_manager", /\b(?:fund\s+manager|who\s+manages|managed\s+by)\b/i],
  ["investment_objective", /\binvestment\s+objective\b/i],
  ["investment_approach", /\binvestment\s+approach\b/i],
  ["benchmark", /\bbenchmark\b/i],
  ["minimum_investment", /\b(?:minimum\s+(?:investment|application|subscription|SIP|installment)|minimum\s+amount\s+to\s+invest|SIP\s+(?:minimum|installment))\b/i],
  ["exit_load", /\b(?:exit\s+load|exit\s+early|early\s+exit)\b/i],
  ["expenses", /\b(?:expenses?|expense\s+ratio|TER)\b/i],
  ["redemption", /\b(?:redemption|redeem|repurchase|withdrawal|SWP)\b/i],
  ["eligibility", /\b(?:eligibility|eligible|who\s+can\s+invest)\b/i],
  ["risk", /\brisk(?:\s+profile|\s+factors?)?\b/i],
  ["investment_strategy", /\binvestment\s+strateg(?:y|ies)\b/i],
];

function resolveSupersessionKey(
  query: string,
  factType: RetrievalFactIntent | null,
): RetrievalIntent["supersessionKey"] {
  if (factType === "exit_load") return "exit_load_window";
  if (
    factType === "minimum_investment"
    && /\baccredited\s+investors?\b/i.test(query)
    && /\bminimum\s+(?:application|investment|amount)\b/i.test(query)
  ) {
    return "accredited_minimum_application";
  }
  if (
    factType === "minimum_investment"
    && /\bSIP\b/i.test(query)
    && /\b(?:minimum|installment|amount)\b/i.test(query)
  ) {
    return "minimum_sip_installment";
  }
  if (
    factType === "redemption"
    && /\b(?:SWP|withdrawal)\b/i.test(query)
    && /\b(?:minimum|amount)\b/i.test(query)
  ) {
    return "minimum_swp_withdrawal";
  }
  return undefined;
}

export function resolveRetrievalIntent(query: string): RetrievalIntent {
  const matchedFacts = FACT_PATTERNS.flatMap(([factType, pattern]) => {
    const match = pattern.exec(query);
    return match
      ? [{ factType, start: match.index, end: match.index + match[0].length }]
      : [];
  });
  const factsByPosition = [...matchedFacts].sort((left, right) => left.start - right.start);
  const hasCoordinatedFacts = factsByPosition.some((fact, index) => {
    const previousFact = factsByPosition[index - 1];
    return previousFact
      ? FACT_COORDINATOR_PATTERN.test(query.slice(previousFact.end, fact.start))
      : false;
  });
  const factType = hasCoordinatedFacts ? null : matchedFacts[0]?.factType ?? null;
  const platinum = PLATINUM_PATTERN.test(query);
  const sif = SIF_PATTERN.test(query);
  if (factType) {
    const supersessionKey = resolveSupersessionKey(query, factType);
    return {
      factType,
      strategyId: platinum ? PLATINUM_STRATEGY_ID : null,
      preferredDocumentScope: platinum ? "strategy" : null,
      ...(supersessionKey ? { supersessionKey } : {}),
    };
  }
  if (hasCoordinatedFacts && platinum) {
    return {
      factType: null,
      strategyId: PLATINUM_STRATEGY_ID,
      preferredDocumentScope: "strategy",
    };
  }
  return {
    factType: null,
    strategyId: null,
    preferredDocumentScope: sif ? "sif_umbrella" : null,
  };
}

function candidateKey(candidate: HybridRetrievalCandidate): string {
  return `${candidate.sourceType}:${candidate.id}`;
}

function addSignal(
  signals: string[],
  condition: boolean,
  signal: string,
  weight: number,
): number {
  if (!condition) return 0;
  signals.push(signal);
  return weight;
}

function isEffectiveAddendum(
  metadata: CandidateChunkMetadata | null,
  intent: RetrievalIntent,
  asOfDate: string,
): boolean {
  return Boolean(
    intent.factType
    && intent.supersessionKey
    && metadata?.documentType === "Addendum"
    && metadata.factType === intent.factType
    && metadata.supersessionKey === intent.supersessionKey
    && (!intent.strategyId || metadata.strategyId === intent.strategyId)
    && typeof metadata.effectiveDate === "string"
    && metadata.effectiveDate <= asOfDate
  );
}

function normalizeProvisionText(text: string): string {
  return text
    .replace(/\bapplicati\s*(?:\|\s*)+on\b/gi, "application")
    .replace(/\baccredite\s*(?:\|\s*)+d\b/gi, "accredited")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ");
}

function matchesSupersededProvision(
  candidate: HybridRetrievalCandidate,
  intent: RetrievalIntent,
): boolean {
  if (!intent.supersessionKey) return false;
  if (candidate.metadata?.supersessionKey === intent.supersessionKey) return true;
  const text = normalizeProvisionText(candidate.text ?? "");
  switch (intent.supersessionKey) {
    case "accredited_minimum_application":
      return /\baccredited\s+investors?\b/i.test(text)
        && /\bminimum\s+(?:application|investment|amount)\b/i.test(text);
    case "minimum_sip_installment":
      return /\bSIP\b|Systematic\s+Investment\s+Plan/i.test(text)
        && /\b(?:minimum|installment|amount)\b/i.test(text);
    case "minimum_swp_withdrawal":
      return /\bSWP\b|Systematic\s+Withdrawal\s+Plan/i.test(text)
        && /\b(?:minimum|withdrawal\s+amount)\b/i.test(text);
    case "exit_load_window":
      return /\bexit\s+load\b/i.test(text)
        || /\bType\s+of\s+Load\b[\s\S]{0,200}\bExit\b/i.test(text);
  }
}

function candidateStrategyId(
  candidate: HybridRetrievalCandidate,
): string | null {
  if (candidate.metadata?.strategyId) return candidate.metadata.strategyId;
  const strategyEvidence = [
    candidate.metadata?.canonicalStrategyName,
    candidate.metadata?.fundName,
    candidate.fundName,
    candidate.documentFilename,
    candidate.documentTitle,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return PLATINUM_PATTERN.test(strategyEvidence) ? PLATINUM_STRATEGY_ID : null;
}

function metadataAdjustment(
  metadata: CandidateChunkMetadata | null,
  intent: RetrievalIntent,
  asOfDate: string,
): { adjustment: number; signals: string[] } {
  if (!metadata) return { adjustment: 0, signals: [] };
  const signals: string[] = [];
  let adjustment = 0;
  adjustment += addSignal(
    signals,
    Boolean(intent.factType && metadata.factType === intent.factType),
    `fact_type:${intent.factType}`,
    0.18,
  );
  adjustment += addSignal(
    signals,
    Boolean(
      intent.factType
      && metadata.factType === intent.factType
      && (
        metadata.classificationSource === "exact_heading"
        || metadata.classificationSource === "human"
      )
    ),
    `classification:${metadata.classificationSource}`,
    0.4,
  );
  adjustment += addSignal(
    signals,
    Boolean(
      intent.factType
      && metadata.factType === intent.factType
      && (metadata.confidence ?? 0) >= 0.9
    ),
    "confidence:high",
    0.04,
  );
  adjustment += addSignal(
    signals,
    Boolean(intent.strategyId && metadata.strategyId === intent.strategyId),
    `strategy:${intent.strategyId}`,
    0.05,
  );
  adjustment += addSignal(
    signals,
    Boolean(intent.preferredDocumentScope
      && metadata.documentScope === intent.preferredDocumentScope),
    `scope:${intent.preferredDocumentScope}`,
    0.04,
  );
  adjustment += addSignal(
    signals,
    Boolean(intent.factType && (
      metadata.sourceAuthority === "regulatory_filing"
      || metadata.sourceAuthority === "official_product_page"
    )),
    `authority:${metadata.sourceAuthority}`,
    0.02,
  );
  adjustment += addSignal(
    signals,
    intent.factType === "fund_manager" && metadata.sectionType === "staff_directory",
    "penalty:staff_directory",
    -0.25,
  );
  adjustment += addSignal(
    signals,
    Boolean(intent.factType && metadata.factType && metadata.factType !== intent.factType),
    `penalty:fact_mismatch:${metadata.factType}`,
    -0.15,
  );
  adjustment += addSignal(
    signals,
    isEffectiveAddendum(metadata, intent, asOfDate),
    "temporal:effective_addendum",
    0.5,
  );
  return { adjustment, signals };
}

interface CandidateState<T extends HybridRetrievalCandidate> {
  candidate: T;
  denseRank: number | null;
  denseScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
}

export function fuseHybridCandidates<T extends HybridRetrievalCandidate>(
  input: HybridFusionInput<T>,
): Array<FusedRetrievalCandidate<T>> {
  const rrfK = input.rrfK ?? 60;
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const states = new Map<string, CandidateState<T>>();
  input.dense.forEach(({ candidate, score }, index) => {
    states.set(candidateKey(candidate), {
      candidate,
      denseRank: index + 1,
      denseScore: score,
      lexicalRank: null,
      lexicalScore: null,
    });
  });
  input.lexical.forEach(({ candidate, score }, index) => {
    const key = candidateKey(candidate);
    const existing = states.get(key);
    states.set(key, {
      candidate: existing?.candidate ?? candidate,
      denseRank: existing?.denseRank ?? null,
      denseScore: existing?.denseScore ?? null,
      lexicalRank: index + 1,
      lexicalScore: score,
    });
  });

  const maximumRrfScore = 2 / (rrfK + 1);
  const candidateStates = [...states.values()];
  const effectiveAddendumKeys = new Set(
    candidateStates
      .filter((state) => isEffectiveAddendum(state.candidate.metadata, input.intent, asOfDate))
      .map((state) => {
        const metadata = state.candidate.metadata;
        return metadata?.strategyId && metadata.supersessionKey
          ? `${metadata.strategyId}:${metadata.supersessionKey}`
          : null;
      })
      .filter((key): key is string => Boolean(key)),
  );
  const currentStates = candidateStates.filter((state) => {
    const metadata = state.candidate.metadata;
    const strategyId = candidateStrategyId(state.candidate);
    const key = strategyId && input.intent.supersessionKey
      ? `${strategyId}:${input.intent.supersessionKey}`
      : null;
    return !(
      key
      && metadata?.documentType !== "Addendum"
      && effectiveAddendumKeys.has(key)
      && matchesSupersededProvision(state.candidate, input.intent)
    );
  });

  const fused = currentStates.map((state): FusedRetrievalCandidate<T> => {
    const rawRrfScore = (state.denseRank ? 1 / (rrfK + state.denseRank) : 0)
      + (state.lexicalRank ? 1 / (rrfK + state.lexicalRank) : 0);
    const rrfScore = rawRrfScore / maximumRrfScore;
    const metadata = metadataAdjustment(state.candidate.metadata, input.intent, asOfDate);
    const finalScore = Math.max(0, rrfScore + metadata.adjustment);
    const trace: RetrievalTrace = {
      denseRank: state.denseRank,
      denseScore: state.denseScore,
      lexicalRank: state.lexicalRank,
      lexicalScore: state.lexicalScore,
      rrfScore,
      metadataAdjustment: metadata.adjustment,
      metadataSignals: metadata.signals,
      fusedScore: finalScore,
      preRerankRank: 0,
      rerankRank: null,
      rerankScore: null,
      finalScore,
    };
    return { candidate: state.candidate, trace };
  });

  return fused
    .sort((left, right) => right.trace.finalScore - left.trace.finalScore)
    .slice(0, input.limit)
    .map((item, index) => ({
      ...item,
      trace: { ...item.trace, preRerankRank: index + 1 },
    }));
}
