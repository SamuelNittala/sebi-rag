import { describe, expect, test } from "bun:test";

import {
  renderCandidateEditor,
  renderDocumentReview,
  renderRetrievalSearch,
  renderReviewDashboard,
} from "./views.ts";

describe("review UI rendering", () => {
  test("renders a query form before a retrieval search is run", () => {
    const html = renderRetrievalSearch({ query: "" });

    expect(html).toContain("Retrieval debugger");
    expect(html).toContain('name="q"');
    expect(html).toContain('action="/review/search"');
    expect(html).not.toContain('<article class="retrieval-result">');
  });

  test("renders retrieved chunks in rank order with scores and retrieval traces", () => {
    const html = renderRetrievalSearch({
      query: "what are the strategies of platinum sif?",
      result: {
        queryTimeMs: 84,
        denseCandidates: 40,
        lexicalCandidates: 40,
        fusion: "rrf",
        rrfK: 60,
        reranking: {
          applied: true,
          provider: "tei",
          model: "BAAI/bge-reranker-v2-m3",
          candidates: 20,
          fallbackReason: null,
        },
        intent: {
          factType: "investment_strategy",
          strategyId: "platinum-hybrid-long-short-fund",
          preferredDocumentScope: "strategy",
        },
        chunks: [
          {
            rank: 2,
            score: 0.82,
            chunkId: "chunk-2",
            sourceType: "knowledge_base",
            text: "Second result",
            sectionHeader: null,
            documentTitle: "Product page",
            sourceUrl: "javascript:alert(1)",
            retrievalMetadata: null,
            retrievalTrace: {
              denseRank: 3,
              denseScore: 0.7,
              lexicalRank: null,
              lexicalScore: null,
              rrfScore: 0.48,
              metadataAdjustment: 0,
              metadataSignals: [],
              fusedScore: 0.82,
              preRerankRank: 1,
              rerankRank: 2,
              rerankScore: 0.82,
              finalScore: 0.82,
            },
          },
          {
            rank: 1,
            score: 0.984,
            chunkId: "chunk-1",
            sourceType: "scheme_document",
            text: "<strong>There are no other existing strategies.</strong>",
            sectionHeader: "Existing investment strategies",
            fundName: "Platinum Hybrid Long Short Fund",
            docType: "ISID",
            pageNumbers: [23],
            documentFilename: "ISID.pdf",
            sebiUrl: "https://example.com/isid.pdf",
            retrievalMetadata: {
              factType: "investment_strategy",
              documentScope: "strategy",
            },
            retrievalTrace: {
              denseRank: 1,
              denseScore: 0.795,
              lexicalRank: 3,
              lexicalScore: 18.33,
              rrfScore: 0.984,
              metadataAdjustment: 0.18,
              metadataSignals: ["fact_type:investment_strategy"],
              fusedScore: 1.164,
              preRerankRank: 2,
              rerankRank: 1,
              rerankScore: 0.984,
              finalScore: 0.984,
            },
          },
        ],
      },
    });

    expect(html.indexOf("Rank 1")).toBeLessThan(html.indexOf("Rank 2"));
    expect(html).toContain("0.984");
    expect(html).toContain("Dense rank");
    expect(html).toContain("Lexical rank");
    expect(html).toContain("BAAI/bge-reranker-v2-m3");
    expect(html).toContain("Rerank score");
    expect(html).toContain("fact_type:investment_strategy");
    expect(html).toContain("ISID.pdf");
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain("<strong>There are no other existing strategies.</strong>");
    expect(html).toContain("&lt;strong&gt;There are no other existing strategies.&lt;/strong&gt;");
  });

  test("renders document status and flag counts on the dashboard", () => {
    const html = renderReviewDashboard([{
      id: "run-1",
      sourceName: "SAI-SIF_March-2026.pdf",
      sourceType: "pdf",
      reviewPurpose: "metadata",
      status: "review_ready",
      candidateChunkCount: 441,
      flaggedChunkCount: 2,
      criticalCount: 1,
      blockingCount: 1,
      parserVersion: "pdf-v1",
      chunkerVersion: "semantic-v1",
      inspectorVersion: "1.0.0",
      createdAt: new Date("2026-07-16T00:00:00Z"),
    }]);

    expect(html).toContain("SAI-SIF_March-2026.pdf");
    expect(html).toContain("441 chunks");
    expect(html).toContain("1 blocking");
    expect(html).toContain("metadata review");
    expect(html).toContain("/review/documents/run-1");
  });

  test("renders all flagged chunks with adjacent context and decisions", () => {
    const html = renderDocumentReview({
      run: {
        id: "run-1",
        sourceName: "SAI-SIF_March-2026.pdf",
        sourceType: "pdf",
        sourceLocation: "/data/SAI-SIF_March-2026.pdf",
        status: "review_ready",
        candidateChunkCount: 3,
        inspectedChunkCount: 3,
        flaggedChunkCount: 1,
        criticalCount: 1,
        blockingCount: 1,
        parserVersion: "pdf-v1",
        chunkerVersion: "semantic-v1",
        inspectorVersion: "1.0.0",
      },
      candidates: [
        {
          id: "candidate-0",
          chunkIndex: 80,
          text: "Earlier staff directory content.",
          pageNumbers: [27],
          tokenCount: 5,
          hasTable: false,
          sectionHeader: null,
          metadata: { documentScope: "amc" },
          contentHash: "hash-0",
        },
        {
          id: "candidate-1",
          chunkIndex: 81,
          text: "ETF Mr. Akshay Udeshi 30 years ETF Product &",
          pageNumbers: [28],
          tokenCount: 10,
          hasTable: false,
          sectionHeader: null,
          metadata: { documentScope: "amc" },
          contentHash: "hash-1",
        },
        {
          id: "candidate-2",
          chunkIndex: 82,
          text: "Fund Manager MBA Finance 6 years Mr. Akshay Udeshi",
          pageNumbers: [28, 29],
          tokenCount: 10,
          hasTable: false,
          sectionHeader: "Fund Manager",
          metadata: { documentScope: "amc", sectionType: "staff_directory" },
          contentHash: "hash-2",
        },
      ],
      flags: [{
        id: "flag-1",
        chunkCandidateId: "candidate-2",
        chunkIndex: 82,
        ruleCode: "CROSS_CHUNK_ROW_CONTINUATION",
        severity: "critical",
        blocksApproval: true,
        message: "A structured row continues across the boundary.",
        evidence: {},
        status: "open",
        reviewer: null,
        reviewerNote: null,
      }],
    });

    expect(html).toContain("CROSS_CHUNK_ROW_CONTINUATION");
    expect(html).toContain("ETF Mr. Akshay Udeshi 30 years ETF Product &");
    expect(html).toContain("Fund Manager MBA Finance");
    expect(html).toContain("name=\"decision\" value=\"accepted\"");
    expect(html).toContain("name=\"decision\" value=\"resolved\"");
    expect(html).toContain("Approve document");
  });

  test("escapes source text before rendering it", () => {
    const html = renderReviewDashboard([{
      id: "run-xss",
      sourceName: "<script>alert(1)</script>.pdf",
      sourceType: "pdf",
      status: "review_ready",
      candidateChunkCount: 1,
      flaggedChunkCount: 0,
      criticalCount: 0,
      blockingCount: 0,
      parserVersion: "v1",
      chunkerVersion: "v1",
      inspectorVersion: "v1",
      createdAt: new Date(),
    }]);

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("shows the publication command after document approval", () => {
    const html = renderDocumentReview({
      run: {
        id: "run-approved",
        sourceName: "approved.pdf",
        sourceType: "pdf",
        sourceLocation: "/tmp/approved.pdf",
        status: "approved",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        flaggedChunkCount: 0,
        criticalCount: 0,
        blockingCount: 0,
        parserVersion: "v1",
        chunkerVersion: "v1",
        inspectorVersion: "v1",
      },
      candidates: [],
      flags: [],
    });

    expect(html).toContain("bun run review:publish run-approved");
    expect(html).not.toContain("Approve document");
  });

  test("renders an editor for every candidate with optimistic-lock hashes", () => {
    const html = renderCandidateEditor({
      run: {
        id: "run-edit",
        sourceName: "presentation.pdf",
        sourceType: "pdf",
        sourceLocation: "/tmp/presentation.pdf",
        status: "review_ready",
        candidateChunkCount: 2,
        inspectedChunkCount: 2,
        flaggedChunkCount: 1,
        criticalCount: 1,
        blockingCount: 1,
        parserVersion: "v1",
        chunkerVersion: "v1",
        inspectorVersion: "v1",
      },
      candidates: [
        {
          id: "candidate-a",
          chunkIndex: 10,
          text: "Broken row &",
          pageNumbers: [4],
          tokenCount: 4,
          hasTable: false,
          sectionHeader: null,
          metadata: { documentScope: "strategy" },
          contentHash: "hash-a",
        },
        {
          id: "candidate-b",
          chunkIndex: 11,
          text: "Fund Manager details",
          pageNumbers: [4],
          tokenCount: 4,
          hasTable: false,
          sectionHeader: "Fund Manager",
          metadata: { documentScope: "strategy" },
          contentHash: "hash-b",
        },
      ],
      flags: [],
    });

    expect(html).toContain("Edit all candidate chunks");
    expect(html).toContain("/review/candidates/candidate-a/edit");
    expect(html).toContain('name="expectedContentHash" value="hash-a"');
    expect(html).toContain('name="text"');
    expect(html).toContain('name="note"');
    expect(html).toContain("Chunk 10");
    expect(html).toContain("Chunk 11");
  });

  test("renders controlled metadata editors without allowing source text edits", () => {
    const html = renderCandidateEditor({
      run: {
        id: "metadata-run",
        sourceName: "KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
        sourceType: "pdf",
        sourceLocation: "/data/KIM-Platinum-Hybrid-Long-Short-Fund.pdf",
        status: "review_ready",
        candidateChunkCount: 1,
        inspectedChunkCount: 1,
        flaggedChunkCount: 0,
        criticalCount: 0,
        blockingCount: 0,
        parserVersion: "metadata-source-v1",
        chunkerVersion: "metadata-preserve-v1",
        inspectorVersion: "metadata-v1",
        reviewPurpose: "metadata",
      },
      candidates: [{
        id: "metadata-candidate",
        chunkIndex: 9,
        text: "The Investment Strategy shall seek to generate regular income.",
        pageNumbers: [6],
        tokenCount: 10,
        hasTable: false,
        sectionHeader: "Investment Objective",
        metadata: {
          documentScope: "strategy",
          sourceChunkId: "source-chunk",
          strategyId: "platinum-hybrid-long-short-fund",
          canonicalStrategyName: "Platinum Hybrid Long-Short Fund",
          sourceAuthority: "regulatory_filing",
          sectionType: "investment_objective",
          factType: "investment_objective",
          confidence: 1,
          classificationSource: "exact_heading",
          evidence: ["Investment Objective"],
        },
        contentHash: "hash-metadata",
      }],
      flags: [],
    });

    expect(html).toContain("Review chunk metadata");
    expect(html).toContain("/review/candidates/metadata-candidate/metadata");
    expect(html).toContain('name="sectionType"');
    expect(html).toContain('value="investment_objective" selected');
    expect(html).toContain('name="factType"');
    expect(html).not.toContain('name="text"');
  });
});
