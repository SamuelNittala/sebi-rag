import { Embedder } from "../packages/core/src/index.ts";
import { VectorClient } from "../packages/vector/src/index.ts";
import { createTenantAccessScope } from "../packages/types/src/index.ts";

import {
  searchHybridDocuments,
  type MergedResult,
} from "../apps/mcp-server/src/hybrid-search.ts";
import { resolveRetrievalScope } from "../apps/mcp-server/src/retrieval-scope.ts";

export interface GoldenCase {
  id: string;
  query: string;
  expectedTerms: string[];
}

export interface EvaluationResult {
  id: string;
  text: string;
  sourceType: string;
  knowledgeDomain: string;
  sourceCollection: string;
  documentTitle: string;
  publisher: string;
  sourceUrl: string;
  sourceDate: string | null;
  authority: string;
  pageNumbers: number[];
  question: string | null;
  topic: string | null;
  normalizedQuestionKey: string | null;
  lexicalRank: number | null;
}

export interface GoldenFixture {
  thresholds: {
    minimumPassRate: number;
    maxRank: number;
    maxDuplicateShare: number;
    staleAfterDays: number;
  };
  tenants: string[];
  cases: GoldenCase[];
  replayResults: Record<string, EvaluationResult[]>;
}

type TenantObservations = Record<string, Record<string, EvaluationResult[]>>;

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function citationComplete(result: EvaluationResult): boolean {
  return Boolean(
    result.sourceType === "generic_document"
    && result.documentTitle
    && result.publisher
    && result.sourceUrl
    && result.pageNumbers.length > 0
    && (result.question || result.topic),
  );
}

function repeatedQuestionShare(results: EvaluationResult[]): number {
  if (results.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = result.normalizedQuestionKey
      ?? result.question
      ?? `${result.sourceUrl}:${result.id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maximum = Math.max(...counts.values());
  return maximum <= 1 ? 0 : maximum / results.length;
}

function conflictWarnings(results: EvaluationResult[]) {
  const byQuestion = new Map<string, EvaluationResult[]>();
  for (const result of results) {
    const key = result.normalizedQuestionKey;
    if (!key) continue;
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), result]);
  }
  return [...byQuestion.entries()].flatMap(([question, variants]) => {
    const sources = new Set(variants.map((result) => result.sourceUrl));
    const answers = new Set(variants.map((result) => normalizedText(result.text)));
    return sources.size > 1 && answers.size > 1
      ? [{ question, sources: [...sources] }]
      : [];
  });
}

function staleWarnings(results: EvaluationResult[], staleAfterDays: number, now: Date) {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - staleAfterDays);
  return results.flatMap((result) => {
    if (!result.sourceDate) return [];
    const date = new Date(`${result.sourceDate}T00:00:00Z`);
    return date < cutoff
      ? [{ id: result.id, sourceDate: result.sourceDate, authority: result.authority }]
      : [];
  });
}

export function evaluateGoldenObservations(
  fixture: GoldenFixture,
  observations: TenantObservations,
  now = new Date(),
) {
  const primaryTenant = fixture.tenants[0]!;
  const evaluations = fixture.cases.map((golden) => {
    const results = observations[primaryTenant]?.[golden.id] ?? [];
    const expectedRankIndex = results.slice(0, fixture.thresholds.maxRank)
      .findIndex((result) => {
        const text = normalizedText(`${result.question ?? ""} ${result.topic ?? ""} ${result.text}`);
        return golden.expectedTerms.every((term) =>
          text.includes(normalizedText(term)));
      });
    const relevance = expectedRankIndex >= 0;
    const citations = results.slice(0, fixture.thresholds.maxRank)
      .filter((result) => result.sourceCollection === "general_mf_faq")
      .every(citationComplete);
    const sifExcluded = results.every((result) =>
      result.knowledgeDomain !== "sif"
      && result.sourceCollection === "general_mf_faq");
    const lexicalParticipation = results.some((result) => result.lexicalRank !== null);
    const duplicateShare = repeatedQuestionShare(results);
    return {
      id: golden.id,
      query: golden.query,
      passed: relevance
        && citations
        && sifExcluded
        && lexicalParticipation
        && duplicateShare <= fixture.thresholds.maxDuplicateShare,
      expectedRank: expectedRankIndex < 0 ? null : expectedRankIndex + 1,
      relevance,
      citationCompleteness: citations,
      sifExcluded,
      lexicalParticipation,
      duplicateShare,
      resultIds: results.map((result) => result.id),
    };
  });
  const tenantParity = fixture.cases.every((golden) => {
    const expected = (observations[primaryTenant]?.[golden.id] ?? [])
      .map((result) => result.id);
    return fixture.tenants.slice(1).every((tenant) => {
      const actual = (observations[tenant]?.[golden.id] ?? [])
        .map((result) => result.id);
      return JSON.stringify(actual) === JSON.stringify(expected);
    });
  });
  const allResults = fixture.cases.flatMap((golden) =>
    observations[primaryTenant]?.[golden.id] ?? []);
  const passed = evaluations.filter((item) => item.passed).length;
  const passRate = evaluations.length === 0 ? 0 : passed / evaluations.length;
  return {
    summary: {
      cases: evaluations.length,
      passed,
      failed: evaluations.length - passed,
      passRate,
      tenantParity,
      passedThreshold:
        passRate >= fixture.thresholds.minimumPassRate && tenantParity,
    },
    evaluations,
    warnings: {
      missingAuthority: allResults
        .filter((result) => !result.authority)
        .map((result) => result.id),
      stale: staleWarnings(
        allResults,
        fixture.thresholds.staleAfterDays,
        now,
      ),
      conflicts: conflictWarnings(allResults),
    },
    cutover: {
      investorAgentTransportParity: "unmet",
      productionActivation: "blocked",
    },
  };
}

function serializeResult(result: MergedResult): EvaluationResult {
  return {
    id: result.id,
    text: result.text,
    sourceType: result.source_type,
    knowledgeDomain: result.knowledgeDomain ?? "",
    sourceCollection: result.sourceCollection ?? "",
    documentTitle: result.documentTitle ?? "",
    publisher: result.publisher ?? "",
    sourceUrl: result.sourceUrl ?? "",
    sourceDate: result.sourceDate ?? null,
    authority: result.authority ?? "",
    pageNumbers: result.pageNumbers ?? [],
    question: result.question ?? null,
    topic: result.topic ?? null,
    normalizedQuestionKey: result.normalizedQuestionKey ?? null,
    lexicalRank: result.retrievalTrace?.lexicalRank ?? null,
  };
}

async function liveObservations(fixture: GoldenFixture): Promise<TenantObservations> {
  const embedder = new Embedder({
    baseUrl: process.env.OLLAMA_BASE_URL,
    model: process.env.EMBEDDING_MODEL ?? "bge-m3",
  });
  const vectors = await embedder.embedBatch(
    fixture.cases.map((golden) => golden.query),
  );
  const vectorClient = new VectorClient();
  const observations: TenantObservations = {};
  for (const tenant of fixture.tenants) {
    observations[tenant] = {};
    const accessScope = createTenantAccessScope(tenant);
    for (const [index, golden] of fixture.cases.entries()) {
      const scope = resolveRetrievalScope({
        question: golden.query,
        topic: "general_mutual_fund",
      });
      const response = await searchHybridDocuments(
        vectorClient,
        golden.query,
        vectors[index]!,
        {
          accessScope,
          limit: 10,
          scoreThreshold: Number(process.env.RETRIEVAL_SCORE_THRESHOLD ?? 0.5),
          candidateLimit: Number(process.env.RETRIEVAL_CANDIDATE_LIMIT ?? 40),
          rrfK: Number(process.env.RETRIEVAL_RRF_K ?? 60),
          ...scope,
        },
      );
      observations[tenant]![golden.id] = response.results.map(serializeResult);
    }
  }
  return observations;
}

function replayObservations(fixture: GoldenFixture): TenantObservations {
  return Object.fromEntries(fixture.tenants.map((tenant) => [
    tenant,
    Object.fromEntries(fixture.cases.map((golden) => [
      golden.id,
      structuredClone(fixture.replayResults[golden.id] ?? []),
    ])),
  ]));
}

export async function runGeneralMfFaqEvaluation(args = process.argv.slice(2)) {
  const fixturePath = args.find((arg) => arg.startsWith("--fixture="))
    ?.slice("--fixture=".length)
    ?? "tests/retrieval/general-mf-faq-golden.json";
  const mode = args.includes("--mode=replay") ? "replay" : "live";
  const fixture = await Bun.file(fixturePath).json() as GoldenFixture;
  const observations = mode === "replay"
    ? replayObservations(fixture)
    : await liveObservations(fixture);
  return {
    mode,
    fixture: fixturePath,
    ...evaluateGoldenObservations(fixture, observations),
  };
}

if (import.meta.main) {
  const report = await runGeneralMfFaqEvaluation();
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.passedThreshold) process.exitCode = 1;
}
