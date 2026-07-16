import { describe, expect, test } from "bun:test";

import {
  renderCandidateEditor,
  renderDocumentReview,
  renderReviewDashboard,
} from "./views.ts";

describe("review UI rendering", () => {
  test("renders document status and flag counts on the dashboard", () => {
    const html = renderReviewDashboard([{
      id: "run-1",
      sourceName: "SAI-SIF_March-2026.pdf",
      sourceType: "pdf",
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
});
