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

const FACT_PATTERNS: ReadonlyArray<[RetrievalFactIntent, RegExp]> = [
  ["fund_manager", /\b(?:fund\s+manager|who\s+manages|managed\s+by)\b/i],
  ["investment_objective", /\binvestment\s+objective\b/i],
  ["investment_approach", /\binvestment\s+approach\b/i],
  ["benchmark", /\bbenchmark\b/i],
  ["minimum_investment", /\bminimum\s+(?:investment|application|subscription)\b/i],
  ["exit_load", /\bexit\s+load\b/i],
  ["expenses", /\b(?:expenses?|expense\s+ratio|TER)\b/i],
  ["redemption", /\b(?:redemption|redeem|repurchase)\b/i],
  ["eligibility", /\b(?:eligibility|eligible|who\s+can\s+invest)\b/i],
  ["risk", /\brisk(?:\s+profile|\s+factors?)?\b/i],
  ["investment_strategy", /\binvestment\s+strateg(?:y|ies)\b/i],
];

export function resolveRetrievalIntent(query: string): RetrievalIntent {
  const factType = FACT_PATTERNS.find(([, pattern]) => pattern.test(query))?.[0] ?? null;
  const platinum = PLATINUM_PATTERN.test(query);
  const sif = SIF_PATTERN.test(query);
  if (factType) {
    return {
      factType,
      strategyId: platinum ? PLATINUM_STRATEGY_ID : null,
      preferredDocumentScope: platinum ? "strategy" : null,
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

function metadataAdjustment(
  metadata: CandidateChunkMetadata | null,
  intent: RetrievalIntent,
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
    0.27,
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
    -0.03,
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
  const fused = [...states.values()].map((state): FusedRetrievalCandidate<T> => {
    const rawRrfScore = (state.denseRank ? 1 / (rrfK + state.denseRank) : 0)
      + (state.lexicalRank ? 1 / (rrfK + state.lexicalRank) : 0);
    const rrfScore = rawRrfScore / maximumRrfScore;
    const metadata = metadataAdjustment(state.candidate.metadata, input.intent);
    const finalScore = Math.max(0, rrfScore + metadata.adjustment);
    const trace: RetrievalTrace = {
      denseRank: state.denseRank,
      denseScore: state.denseScore,
      lexicalRank: state.lexicalRank,
      lexicalScore: state.lexicalScore,
      rrfScore,
      metadataAdjustment: metadata.adjustment,
      metadataSignals: metadata.signals,
      finalScore,
    };
    return { candidate: state.candidate, trace };
  });

  return fused
    .sort((left, right) => right.trace.finalScore - left.trace.finalScore)
    .slice(0, input.limit);
}
