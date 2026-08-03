import type { MergedResult } from "./hybrid-search.ts";

export interface SchemeDocumentCitation {
  fundName: string;
  docType: string;
  amendmentNumber: string;
  pageNumbers: number[];
  sebiUrl: string;
  sourceUrl: string;
}

export interface GenericDocumentCitation {
  title: string;
  publisher: string;
  sourceUrl: string;
  sourceDate: string | null;
  authority: string | null;
  pageNumbers: number[];
  question: string | null;
  topic: string | null;
}

function mergePages(current: number[], incoming: number[] | undefined): number[] {
  return [...new Set([...current, ...(incoming ?? [])])].sort((a, b) => a - b);
}

export function buildSchemeDocumentCitations(results: MergedResult[]): SchemeDocumentCitation[] {
  const citations = new Map<string, SchemeDocumentCitation>();
  for (const result of results.filter((item) => item.source_type === "scheme_document")) {
    const amendmentNumber = typeof result.metadata?.amendmentNumber === "string"
      ? result.metadata.amendmentNumber
      : "";
    const key = result.sourceUrl
      ? `${result.sourceUrl}|${amendmentNumber}`
      : `${result.fundName}|${result.docType}|${amendmentNumber}`;
    const existing = citations.get(key);
    if (existing) {
      existing.pageNumbers = mergePages(existing.pageNumbers, result.pageNumbers);
    } else {
      citations.set(key, {
        fundName: result.fundName ?? "",
        docType: result.docType ?? "",
        amendmentNumber,
        pageNumbers: [...(result.pageNumbers ?? [])],
        sebiUrl: result.sebiUrl ?? "",
        sourceUrl: result.sourceUrl ?? "",
      });
    }
  }
  return [...citations.values()];
}

export function buildGenericDocumentCitations(results: MergedResult[]): GenericDocumentCitation[] {
  const citations = new Map<string, GenericDocumentCitation>();
  for (const result of results.filter((item) => item.source_type === "generic_document")) {
    const key = [
      result.sourceUrl ?? result.documentTitle ?? result.documentFilename ?? "",
      result.question ?? result.topic ?? "",
    ].join("|");
    const existing = citations.get(key);
    if (existing) {
      existing.pageNumbers = mergePages(existing.pageNumbers, result.pageNumbers);
    } else {
      citations.set(key, {
        title: result.documentTitle ?? result.documentFilename ?? "",
        publisher: result.publisher ?? "",
        sourceUrl: result.sourceUrl ?? "",
        sourceDate: result.sourceDate ?? null,
        authority: result.authority ?? null,
        pageNumbers: [...(result.pageNumbers ?? [])],
        question: result.question ?? null,
        topic: result.topic ?? null,
      });
    }
  }
  return [...citations.values()];
}
