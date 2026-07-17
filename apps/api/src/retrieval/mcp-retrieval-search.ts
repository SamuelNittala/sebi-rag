import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface RetrievalTraceView {
  denseRank: number | null;
  denseScore: number | null;
  lexicalRank: number | null;
  lexicalScore: number | null;
  rrfScore: number;
  metadataAdjustment: number;
  metadataSignals: string[];
  finalScore: number;
}

export interface RetrievalChunkView {
  rank: number;
  score: number;
  chunkId: string | null;
  sourceType: "scheme_document" | "knowledge_base";
  text: string;
  sectionHeader: string | null;
  retrievalTrace?: RetrievalTraceView;
  retrievalMetadata: Record<string, unknown> | null;
  fundName?: string;
  docType?: string;
  pageNumbers?: number[];
  documentFilename?: string;
  sebiUrl?: string;
  documentTitle?: string;
  contentCategory?: string;
  sourceUrl?: string;
}

export interface RetrievalSearchResult {
  chunks: RetrievalChunkView[];
  queryTimeMs: number;
  denseCandidates: number;
  lexicalCandidates: number;
  fusion: string;
  rrfK: number;
  intent: {
    factType: string | null;
    strategyId: string | null;
    preferredDocumentScope: string | null;
  };
}

export interface RetrievalSearch {
  search(query: string): Promise<RetrievalSearchResult>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return optionalString(value) ?? null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTrace(value: unknown): RetrievalTraceView | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const trace = record(value);
  return {
    denseRank: nullableNumber(trace.denseRank),
    denseScore: nullableNumber(trace.denseScore),
    lexicalRank: nullableNumber(trace.lexicalRank),
    lexicalScore: nullableNumber(trace.lexicalScore),
    rrfScore: finiteNumber(trace.rrfScore),
    metadataAdjustment: finiteNumber(trace.metadataAdjustment),
    metadataSignals: Array.isArray(trace.metadataSignals)
      ? trace.metadataSignals.filter((signal): signal is string => typeof signal === "string")
      : [],
    finalScore: finiteNumber(trace.finalScore),
  };
}

function parseChunk(value: unknown, index: number): RetrievalChunkView {
  const chunk = record(value);
  const sourceType = chunk.source_type === "knowledge_base"
    ? "knowledge_base"
    : "scheme_document";
  const retrievalMetadata = typeof chunk.retrievalMetadata === "object"
    && chunk.retrievalMetadata !== null
    ? record(chunk.retrievalMetadata)
    : null;
  const retrievalTrace = parseTrace(chunk.retrievalTrace);
  return {
    rank: finiteNumber(chunk.rank, index + 1),
    score: finiteNumber(chunk.score),
    chunkId: nullableString(chunk.chunkId),
    sourceType,
    text: optionalString(chunk.text) ?? "",
    sectionHeader: nullableString(chunk.sectionHeader),
    retrievalMetadata,
    ...(retrievalTrace && { retrievalTrace }),
    ...(optionalString(chunk.fundName) && { fundName: optionalString(chunk.fundName) }),
    ...(optionalString(chunk.docType) && { docType: optionalString(chunk.docType) }),
    ...(Array.isArray(chunk.pageNumbers) && {
      pageNumbers: chunk.pageNumbers.filter((page): page is number => typeof page === "number"),
    }),
    ...(optionalString(chunk.documentFilename) && {
      documentFilename: optionalString(chunk.documentFilename),
    }),
    ...(optionalString(chunk.sebiUrl) && { sebiUrl: optionalString(chunk.sebiUrl) }),
    ...(optionalString(chunk.documentTitle) && {
      documentTitle: optionalString(chunk.documentTitle),
    }),
    ...(optionalString(chunk.contentCategory) && {
      contentCategory: optionalString(chunk.contentCategory),
    }),
    ...(optionalString(chunk.sourceUrl) && { sourceUrl: optionalString(chunk.sourceUrl) }),
  };
}

function textPayload(toolResult: unknown): string {
  const result = record(toolResult);
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content
    .map(record)
    .find((block) => block.type === "text" && typeof block.text === "string");
  if (!textBlock || typeof textBlock.text !== "string") {
    throw new Error("The retrieval service did not return a text payload.");
  }
  return textBlock.text;
}

export function parseRetrievalToolResult(toolResult: unknown): RetrievalSearchResult {
  const payload = record(JSON.parse(textPayload(toolResult)));
  const metadata = record(payload.metadata);
  const retrieval = record(metadata.retrieval);
  const intent = record(retrieval.intent);
  const chunks = Array.isArray(payload.chunks)
    ? payload.chunks.map(parseChunk).sort((left, right) => left.rank - right.rank)
    : [];
  return {
    chunks,
    queryTimeMs: finiteNumber(metadata.queryTimeMs),
    denseCandidates: finiteNumber(retrieval.denseCandidates),
    lexicalCandidates: finiteNumber(retrieval.lexicalCandidates),
    fusion: optionalString(retrieval.fusion) ?? "unknown",
    rrfK: finiteNumber(retrieval.rrfK),
    intent: {
      factType: nullableString(intent.factType),
      strategyId: nullableString(intent.strategyId),
      preferredDocumentScope: nullableString(intent.preferredDocumentScope),
    },
  };
}

export class McpRetrievalSearch implements RetrievalSearch {
  constructor(private readonly endpoint: URL) {}

  async search(query: string): Promise<RetrievalSearchResult> {
    const transport = new StreamableHTTPClientTransport(this.endpoint);
    const client = new Client(
      { name: "mf-rag-review-retrieval-debugger", version: "1.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "query_mutual_funds",
        arguments: { question: query },
      });
      return parseRetrievalToolResult(response);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
