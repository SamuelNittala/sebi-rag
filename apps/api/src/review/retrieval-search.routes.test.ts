import { describe, expect, mock, test } from "bun:test";

import type { RetrievalSearch } from "../retrieval/mcp-retrieval-search.ts";

const authorization = `Basic ${btoa("reviewer:secret")}`;
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

async function createTestApp(retrievalSearch: RetrievalSearch) {
  const { createReviewApp } = await import("./routes.ts");
  return createReviewApp(
    {} as Parameters<typeof createReviewApp>[0],
    { username: "reviewer", password: "secret" },
    retrievalSearch,
  );
}

describe("retrieval search route", () => {
  test("runs the query through the retrieval service and renders ranked chunks", async () => {
    const search = mock(async () => ({
      queryTimeMs: 15,
      denseCandidates: 40,
      lexicalCandidates: 40,
      fusion: "rrf" as const,
      rrfK: 60,
      intent: {
        factType: "investment_strategy",
        strategyId: "platinum-hybrid-long-short-fund",
        preferredDocumentScope: "strategy",
      },
      chunks: [{
        rank: 1,
        score: 0.984,
        chunkId: "chunk-1",
        sourceType: "scheme_document" as const,
        text: "There are no other existing strategies.",
        sectionHeader: "Existing strategies",
        pageNumbers: [23],
        retrievalMetadata: null,
      }],
    }));
    const retrievalSearch: RetrievalSearch = { search };
    const app = await createTestApp(retrievalSearch);

    const response = await app.request(
      "/search?q=what%20are%20the%20strategies%20of%20platinum%20sif%3F",
      { headers: { authorization } },
    );

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledWith("what are the strategies of platinum sif?");
    const html = await response.text();
    expect(html).toContain("Rank 1");
    expect(html).toContain("There are no other existing strategies.");
  });

  test("does not run retrieval for an empty query", async () => {
    const search = mock(async () => { throw new Error("should not run"); });
    const app = await createTestApp({ search });

    const response = await app.request("/search", {
      headers: { authorization },
    });

    expect(response.status).toBe(200);
    expect(search).not.toHaveBeenCalled();
  });
});
