const BM25_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "for", "from", "how",
  "in", "is", "it", "of", "on", "or", "the", "to", "what", "when", "where",
  "which", "who", "why", "with",
]);
const BM25_UPPERCASE_ACRONYMS = new Set(["CAN"]);
const BM25_ACRONYM_CONTEXT = new Set(["details", "id", "number"]);

const REDEMPTION_EQUIVALENTS = ["redemption", "redeem"] as const;
const BM25_EQUIVALENT_TERMS = new Map(
  REDEMPTION_EQUIVALENTS.map(
    (term) => [term, REDEMPTION_EQUIVALENTS] as const
  ),
);

export function tokenizeBm25Query(query: string): string[] {
  const tokens = query.match(/[a-z0-9]+/gi) ?? [];
  const hasMixedCaseContext = /[a-z]/.test(query);
  const meaningfulTokens = tokens
    .filter((token, index) => {
      const normalized = token.toLowerCase();
      const previousToken = tokens[index - 1]?.toLowerCase();
      const nextToken = tokens[index + 1]?.toLowerCase();
      const identifierContext = previousToken === "my"
        || (nextToken !== undefined && BM25_ACRONYM_CONTEXT.has(nextToken));
      const uppercaseAcronym = BM25_UPPERCASE_ACRONYMS.has(token)
        && (hasMixedCaseContext || identifierContext);
      return token.length > 1
        && (!BM25_STOP_WORDS.has(normalized) || uppercaseAcronym);
    })
    .map((token) => token.toLowerCase());
  return [...new Set(meaningfulTokens.flatMap(
    (token) => BM25_EQUIVALENT_TERMS.get(token) ?? [token]
  ))];
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
