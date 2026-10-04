import { describe, expect, test } from "bun:test";

import type { DoclingWireChunk } from "../../../ingestion/src/parsers/docling-contract.ts";
import { buildPageViewModel, type PageViewModelInput } from "./page-view/page-view-model.ts";
import {
  renderCandidateEditor,
  renderDocumentPageView,
  renderDocumentReview,
  renderPageViewUnavailable,
  renderRetrievalSearch,
  renderReviewDashboard,
  serializeJsonForScript,
  type DocumentReviewViewModel,
  type PageViewAssets,
  type ReviewDashboardItem,
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

  test("renders generic FAQ identity without scheme placeholders", () => {
    const html = renderRetrievalSearch({
      query: "How do I complete KYC?",
      result: {
        queryTimeMs: 12,
        denseCandidates: 1,
        lexicalCandidates: 1,
        fusion: "rrf",
        rrfK: 60,
        reranking: {
          applied: false,
          provider: null,
          model: null,
          candidates: 0,
          fallbackReason: null,
        },
        intent: {
          factType: null,
          strategyId: null,
          preferredDocumentScope: null,
        },
        chunks: [{
          rank: 1,
          score: 0.9,
          chunkId: "faq-1",
          sourceType: "generic_document",
          text: "Follow the applicable KYC process.",
          sectionHeader: "KYC",
          retrievalMetadata: null,
          documentTitle: "FAQs for Mutual Fund Investors",
          publisher: "Securities and Exchange Board of India",
          sourceDate: "2024-09-25",
          sourceUrl: "https://sebi.example/faq.pdf",
          pageNumbers: [4, 5],
          question: "How do I complete KYC?",
          topic: "KYC",
        }],
      },
    });

    expect(html).toContain("FAQs for Mutual Fund Investors");
    expect(html).toContain("Securities and Exchange Board of India");
    expect(html).toContain("How do I complete KYC?");
    expect(html).toContain("pages 4, 5");
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
        visibilityScope: "TENANT",
        tenantId: "mirae-asset",
        ownershipManifestId: "review-ui-manifest",
        ownershipManifestVersion: 3,
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
        visibilityScope: "TENANT",
        tenantId: "mirae-asset",
        ownershipManifestId: "review-ui-manifest",
        ownershipManifestVersion: 3,
      }],
      flags: [],
    });

    expect(html).toContain("Review chunk metadata");
    expect(html).toContain("/review/candidates/metadata-candidate/metadata");
    expect(html).toContain('name="sectionType"');
    expect(html).toContain('value="investment_objective" selected');
    expect(html).toContain('name="factType"');
    expect(html).toContain("Ownership: TENANT · Tenant mirae-asset · Manifest review-ui-manifest v3");
    expect(html).not.toContain('name="visibilityScope"');
    expect(html).not.toContain('name="tenantId"');
    expect(html).not.toContain('name="text"');
  });
});

const PAGE_ASSETS: PageViewAssets = {
  clientUrl: "/review/assets/page-view.js?v=abc123",
  pdfjsUrl: "/review/assets/pdfjs/6.4.299/pdf.min.mjs",
  pdfjsWorkerUrl: "/review/assets/pdfjs/6.4.299/pdf.worker.min.mjs",
};

function wireChunk(overrides: Partial<DoclingWireChunk> & Pick<DoclingWireChunk, "chunkIndex">): DoclingWireChunk {
  return {
    type: "text",
    text: `Wire text ${overrides.chunkIndex}`,
    headings: ["Fund facts"],
    pages: [3],
    bboxes: [{ page: 3, l: 10, t: 800, r: 300, b: 700 }],
    itemRefs: [`#/texts/${overrides.chunkIndex}`],
    flags: [],
    picture: null,
    ...overrides,
  };
}

function pageModelInput(overrides: Partial<PageViewModelInput> = {}): PageViewModelInput {
  return {
    run: { id: "run-page", sourceName: "factsheet.pdf", parserVersion: "docling-2.132.0+norm-7+opts-x+none", status: "review_ready" },
    page: 3,
    pageCount: 5,
    rawPdfSha256: "a".repeat(64),
    summary: [
      { page: 3, chunkCount: 2, openFlagCount: 1, openBlockingCount: 1 },
      { page: 5, chunkCount: 1, openFlagCount: 2, openBlockingCount: 0 },
    ],
    candidates: [
      {
        id: "cand-0",
        chunkIndex: 0,
        text: "Scheme <b>bold</b> & </script><script>alert(1)</script>",
        pageNumbers: [3],
        sectionHeader: "Fund facts",
        metadata: { parser: "docling", chunkType: "table", normalizationFlags: ["title_row_heading"], sourceItemRefs: ["#/texts/0"] },
      },
      {
        id: "cand-addendum",
        chunkIndex: 1,
        text: "Addendum text",
        pageNumbers: [3],
        sectionHeader: null,
        metadata: { documentScope: "amc" },
      },
    ],
    flags: [{
      id: "flag-9",
      chunkCandidateId: "cand-0",
      ruleCode: "TABLE_ROW_SPLIT",
      severity: "critical",
      blocksApproval: true,
      message: "Row <split>",
      status: "open",
    }],
    editCounts: new Map([["cand-0", 1]]),
    wireChunks: [
      wireChunk({ chunkIndex: 0, type: "table", text: "Wire \u2028 line </script>" }),
      wireChunk({ chunkIndex: 7, type: "picture", picture: { classification: "bar_chart" } as DoclingWireChunk["picture"] }),
    ],
    ...overrides,
  };
}

describe("page view rendering", () => {
  test("serializes JSON for a script element without closing it or breaking lines", () => {
    const json = serializeJsonForScript({ text: "</script><!-- & \u2028 \u2029 >" });

    expect(json).not.toContain("<");
    expect(json).not.toContain(">");
    expect(json).not.toContain("&");
    expect(json).not.toContain("\u2028");
    expect(json).not.toContain("\u2029");
    expect(JSON.parse(json)).toEqual({ text: "</script><!-- & \u2028 \u2029 >" });
  });

  test("renders the page column, candidate cards, findings and editor links", () => {
    const html = renderDocumentPageView(buildPageViewModel(pageModelInput()), PAGE_ASSETS);

    expect(html).toContain('class="page-view"');
    expect(html).toContain('id="page-canvas"');
    expect(html).toContain('id="chunk-0"');
    expect(html).toContain('href="/review/documents/run-page/chunks#cand-0"');
    expect(html).toContain('href="/review/documents/run-page#flag-flag-9"');
    expect(html).toContain("TABLE_ROW_SPLIT");
    expect(html).toContain("blocks approval");
    expect(html).toContain("edited");
    expect(html).toContain("title_row_heading");
    expect(html).toContain("Candidates without Docling geometry");
    expect(html).toContain("Addendum text");
    expect(html).toContain('id="wire-7"');
    expect(html).toContain("Docling chunks not in candidates");
    expect(html).toContain("bar_chart");
    expect(html).toContain("<noscript>");
    expect(html).toContain('id="toggle-boxes"');
  });

  test("escapes chunk text in cards and in the JSON data block", () => {
    const html = renderDocumentPageView(buildPageViewModel(pageModelInput()), PAGE_ASSETS);

    expect(html).toContain("Scheme &lt;b&gt;bold&lt;/b&gt; &amp; &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("Row &lt;split&gt;");
    const data = html.match(/<script type="application\/json" id="page-view-data">([^<]*)<\/script>/);
    expect(data).not.toBeNull();
    const payload = JSON.parse(data![1]!);
    expect(payload.page).toBe(3);
    expect(payload.boxes.map((box: { targetId: string }) => box.targetId)).toEqual(["chunk-0", "wire-7"]);
  });

  test("references the versioned PDF and assets and renders the page picker and navigation", () => {
    const html = renderDocumentPageView(buildPageViewModel(pageModelInput()), PAGE_ASSETS);

    expect(html).toContain(`data-pdf-url="/review/documents/run-page/source.pdf?v=${"a".repeat(64)}"`);
    expect(html).toContain('data-pdfjs-url="/review/assets/pdfjs/6.4.299/pdf.min.mjs"');
    expect(html).toContain('data-pdfjs-worker-url="/review/assets/pdfjs/6.4.299/pdf.worker.min.mjs"');
    expect(html).toContain('<script type="module" src="/review/assets/page-view.js?v=abc123"></script>');
    expect(html).toContain('action="/review/documents/run-page/pages"');
    expect(html).toContain('<option value="3" selected>p3 - 2 chunks - 1 open (1 blocking)</option>');
    expect(html).toContain('href="/review/documents/run-page/pages/2"');
    expect(html).toContain('href="/review/documents/run-page/pages/4"');
    expect(html).toContain('href="/review/documents/run-page/pages/5"');
    expect(html).toContain("Next page with findings");
    expect(html).toContain('href="/review/documents/run-page"');
  });

  test("disables navigation at the document bounds", () => {
    const html = renderDocumentPageView(buildPageViewModel(pageModelInput({ page: 1, pageCount: 1, summary: [], candidates: [], flags: [], wireChunks: [] })), PAGE_ASSETS);

    expect(html).not.toContain('href="/review/documents/run-page/pages/0"');
    expect(html).not.toContain('href="/review/documents/run-page/pages/2"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("No Docling chunks or candidates on this page.");
  });

  test("explains why the page view is unavailable", () => {
    const legacy = renderPageViewUnavailable({ runId: "run-x", reason: { kind: "no_lineage", reason: "legacy_run", parserVersion: "unpdf-v1+<x>" } });
    const missing = renderPageViewUnavailable({ runId: "run-x", reason: { kind: "no_lineage", reason: "parse_output_missing", parserVersion: "docling-1" } });
    const unpdf = renderPageViewUnavailable({ runId: "run-x", reason: { kind: "not_docling", parserVersion: "pdf-v1", mediaType: "application/json" } });
    const disabled = renderPageViewUnavailable({ runId: "run-x", reason: { kind: "disabled" } });
    const error = renderPageViewUnavailable({ runId: "run-x", reason: { kind: "error", code: "ARTIFACT_READ_FAILED" } });

    expect(legacy).toContain("has no pipeline lineage");
    expect(legacy).toContain("unpdf-v1+&lt;x&gt;");
    expect(legacy).toContain('href="/review/documents/run-x"');
    expect(missing).toContain("no successful PARSE output");
    expect(unpdf).toContain("Page view needs a Docling-parsed pipeline run");
    expect(unpdf).toContain("pdf-v1");
    expect(disabled).toContain("ARTIFACT_STORE is not configured");
    expect(error).toContain("ARTIFACT_READ_FAILED");
    expect(error).toContain("error-panel");
  });
});

describe("page view entry links", () => {
  const dashboardRun = (overrides: Partial<ReviewDashboardItem>): ReviewDashboardItem => ({
    id: "run-d",
    sourceName: "factsheet.pdf",
    sourceType: "pdf",
    status: "review_ready",
    candidateChunkCount: 10,
    flaggedChunkCount: 0,
    criticalCount: 0,
    blockingCount: 0,
    parserVersion: "docling-2.132.0+norm-7+opts-da9fca75f112+none",
    chunkerVersion: "docling-hybrid-v1",
    inspectorVersion: "1.0.0",
    createdAt: new Date("2026-10-01T00:00:00Z"),
    pipelineRunId: "pipe-1",
    ...overrides,
  });

  test("the dashboard links Docling pipeline runs to the page view only", () => {
    const html = renderReviewDashboard([
      dashboardRun({}),
      dashboardRun({ id: "run-unpdf", parserVersion: "unpdf-v1+pdfplumber" }),
      dashboardRun({ id: "run-legacy", pipelineRunId: null }),
    ]);

    expect(html).toContain('href="/review/documents/run-d/pages"');
    expect(html).not.toContain('href="/review/documents/run-unpdf/pages"');
    expect(html).not.toContain('href="/review/documents/run-legacy/pages"');
  });

  const reviewModel = (parserVersion: string): DocumentReviewViewModel => ({
    run: {
      id: "run-r",
      sourceName: "factsheet.pdf",
      sourceType: "pdf",
      sourceLocation: null,
      status: "review_ready",
      candidateChunkCount: 1,
      inspectedChunkCount: 1,
      flaggedChunkCount: 1,
      criticalCount: 1,
      blockingCount: 1,
      parserVersion,
      chunkerVersion: "docling-hybrid-v1",
      inspectorVersion: "1.0.0",
      pipelineRunId: "pipe-1",
    },
    candidates: [{
      id: "cand-r",
      chunkIndex: 12,
      text: "Text",
      pageNumbers: [34, 35],
      tokenCount: 1,
      hasTable: false,
      sectionHeader: null,
      metadata: { documentScope: "strategy" },
      contentHash: "h",
    }],
    flags: [{
      id: "flag-r",
      chunkCandidateId: "cand-r",
      chunkIndex: 12,
      ruleCode: "TABLE_ROW_SPLIT",
      severity: "critical",
      blocksApproval: true,
      message: "m",
      evidence: {},
      status: "open",
      reviewer: null,
      reviewerNote: null,
    }],
  });

  test("the document review anchors flags and links them to their page", () => {
    const html = renderDocumentReview(reviewModel("docling-2.132.0+norm-7+opts-da9fca75f112+none"));

    expect(html).toContain('id="flag-flag-r"');
    expect(html).toContain('href="/review/documents/run-r/pages"');
    expect(html).toContain('href="/review/documents/run-r/pages/34#chunk-12"');
    expect(html).toContain("View page 34");
  });

  test("the document review keeps flag anchors but omits page links for non-Docling runs", () => {
    const html = renderDocumentReview(reviewModel("unpdf-v1"));

    expect(html).toContain('id="flag-flag-r"');
    expect(html).not.toContain("/pages");
  });

  test("the candidate editor links each candidate to its page", () => {
    const html = renderCandidateEditor(reviewModel("docling-2.132.0+norm-7+opts-da9fca75f112+none"));

    expect(html).toContain('href="/review/documents/run-r/pages/34#chunk-12"');
    expect(html).toContain("View on page 34");
  });
});
