export interface EmbeddingContext {
  fund?: string | null;
  document: string;
  publisher?: string | null;
  topic?: string | null;
  question?: string | null;
  section?: string | null;
  pages?: number[];
  contentType: string;
}

function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const firstPage = sorted[0];
  const secondPage = sorted[1];
  if (firstPage !== undefined && secondPage === firstPage + 1 && sorted.length === 2) {
    return `${firstPage}–${secondPage}`;
  }
  return sorted.join(", ");
}

export function buildContextualEmbeddingText(
  sourceText: string,
  context: EmbeddingContext
): string {
  const prefix: string[] = [];
  if (context.fund) prefix.push(`Fund: ${context.fund}`);
  prefix.push(`Document: ${context.document}`);
  if (context.publisher) prefix.push(`Publisher: ${context.publisher}`);
  if (context.topic) prefix.push(`Topic: ${context.topic}`);
  if (context.question) prefix.push(`Question: ${context.question}`);
  if (context.section) prefix.push(`Section: ${context.section}`);
  if (context.pages?.length) prefix.push(`Pages: ${formatPages(context.pages)}`);
  prefix.push(`Content type: ${context.contentType}`);

  return `${prefix.join("\n")}\n\n${sourceText}`;
}
