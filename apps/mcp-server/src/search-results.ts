import type { MergedResult } from "./hybrid-search.ts";

export function buildRawSearchResults(results: MergedResult[]) {
  return results.map((result, index) => ({
    rank: index + 1,
    score: result.score.toFixed(3),
    source_type: result.source_type,
    ...(result.source_type === "scheme_document" && {
      scheme: result.fundName,
      document: result.docType,
      pages: result.pageNumbers,
    }),
    ...(result.source_type === "generic_document" && {
      title: result.documentTitle,
      publisher: result.publisher,
      url: result.sourceUrl,
      sourceDate: result.sourceDate,
      authority: result.authority,
      pages: result.pageNumbers,
      question: result.question,
      questionNumber: result.questionNumber,
      topic: result.topic,
    }),
    ...(result.source_type === "knowledge_base" && {
      title: result.documentTitle,
      category: result.contentCategory,
      url: result.sourceUrl,
    }),
    excerpt: result.text.slice(0, 300) + (result.text.length > 300 ? "..." : ""),
    retrievalTrace: result.retrievalTrace,
  }));
}
