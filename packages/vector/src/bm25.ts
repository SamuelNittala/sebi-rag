const BM25_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "the", "to", "what", "when", "where",
  "which", "who", "why", "with",
]);

export function tokenizeBm25Query(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(tokens.filter((token) =>
    token.length > 1 && !BM25_STOP_WORDS.has(token)))];
}

export interface Bm25TermInput {
  termFrequency: number;
  documentLength: number;
  averageDocumentLength: number;
  documentCount: number;
  documentFrequency: number;
  k1?: number;
  b?: number;
}

export function calculateBm25TermScore(input: Bm25TermInput): number {
  if (input.termFrequency <= 0 || input.documentCount <= 0) return 0;
  const k1 = input.k1 ?? 1.2;
  const b = input.b ?? 0.75;
  const averageLength = Math.max(1, input.averageDocumentLength);
  const inverseDocumentFrequency = Math.log(
    1 + (input.documentCount - input.documentFrequency + 0.5)
      / (input.documentFrequency + 0.5),
  );
  const saturation = input.termFrequency * (k1 + 1)
    / (input.termFrequency + k1 * (
      1 - b + b * input.documentLength / averageLength
    ));
  return inverseDocumentFrequency * saturation;
}
