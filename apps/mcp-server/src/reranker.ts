export interface RerankResult {
  index: number;
  score: number;
}

export interface Reranker {
  readonly provider: string;
  readonly model: string;
  rerank(query: string, documents: string[], limit: number): Promise<RerankResult[]>;
  checkHealth(): Promise<boolean>;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TeiRerankerOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
}

interface TeiResult {
  index: number;
  score: number;
}

const DEFAULT_MODEL = "BAAI/bge-reranker-v2-m3";
const DEFAULT_BASE_URL = "http://localhost:8081";
const DEFAULT_TIMEOUT_MS = 30_000;

function isTeiResult(value: unknown): value is TeiResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return Number.isInteger(result.index)
    && Number.isFinite(result.score)
    && Number(result.score) >= 0
    && Number(result.score) <= 1;
}

function parseResults(payload: unknown, documentCount: number): RerankResult[] {
  if (!Array.isArray(payload)) {
    throw new Error("TEI rerank returned an invalid response");
  }
  if (payload.length === 0 && documentCount > 0) {
    throw new Error("TEI rerank returned no results");
  }
  const seenIndices = new Set<number>();
  return payload.map((result) => {
    if (!isTeiResult(result)) {
      throw new Error("TEI rerank returned an invalid result");
    }
    if (result.index < 0 || result.index >= documentCount) {
      throw new Error(`TEI rerank returned invalid result index ${result.index}`);
    }
    if (seenIndices.has(result.index)) {
      throw new Error(`TEI rerank returned duplicate result index ${result.index}`);
    }
    seenIndices.add(result.index);
    return { index: result.index, score: result.score };
  });
}

export class TeiReranker implements Reranker {
  readonly provider = "tei";
  readonly model: string;
  private readonly endpoint: string;
  private readonly healthEndpoint: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;

  constructor(options: TeiRerankerOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.endpoint = `${baseUrl}/rerank`;
    this.healthEndpoint = `${baseUrl}/health`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? fetch;
  }

  async rerank(query: string, documents: string[], limit: number): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        texts: documents,
        raw_scores: false,
        return_text: false,
        truncate: true,
        truncation_direction: "Right",
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`TEI rerank failed with HTTP ${response.status}`);
    }
    return parseResults(await response.json(), documents.length)
      .slice(0, Math.min(Math.max(1, limit), documents.length));
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.fetcher(this.healthEndpoint, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 3_000)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
