import { TeiReranker, type Reranker } from "./reranker.ts";

const DEFAULT_DENSE_SCORE_THRESHOLD = 0.3;
const DEFAULT_RERANK_CANDIDATE_LIMIT = 20;

export function resolveDenseScoreThreshold(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_DENSE_SCORE_THRESHOLD;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_DENSE_SCORE_THRESHOLD;
}

export function resolveRerankCandidateLimit(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_RERANK_CANDIDATE_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RERANK_CANDIDATE_LIMIT;
}

export function createRerankerFromEnv(
  env: Record<string, string | undefined>,
): Reranker | null {
  const configuredProvider = env.RERANK_PROVIDER?.trim().toLowerCase();
  if (configuredProvider === "none") return null;
  const provider = configuredProvider ?? (env.RERANK_BASE_URL ? "tei" : "none");
  if (provider === "none") return null;
  if (provider !== "tei" && provider !== "bge") {
    throw new Error(`Unsupported RERANK_PROVIDER: ${provider}`);
  }
  return new TeiReranker({
    model: env.RERANK_MODEL?.trim() || undefined,
    baseUrl: env.RERANK_BASE_URL?.trim() || undefined,
  });
}
