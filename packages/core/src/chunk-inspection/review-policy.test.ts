import { describe, expect, test } from "bun:test";

import { ReviewApprovalPolicy } from "./review-policy.ts";

describe("ReviewApprovalPolicy", () => {
  test("allows a fully inspected review with no open blockers", () => {
    const result = new ReviewApprovalPolicy().evaluate({
      status: "review_ready",
      candidateChunkCount: 12,
      inspectedChunkCount: 12,
      openBlockingCount: 0,
      openWarningCount: 0,
    });

    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  test("rejects approval when not every candidate was inspected", () => {
    const result = new ReviewApprovalPolicy().evaluate({
      status: "review_ready",
      candidateChunkCount: 12,
      inspectedChunkCount: 11,
      openBlockingCount: 0,
      openWarningCount: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Not every candidate chunk was inspected.");
  });

  test("rejects approval while blocking findings remain open", () => {
    const result = new ReviewApprovalPolicy().evaluate({
      status: "review_ready",
      candidateChunkCount: 12,
      inspectedChunkCount: 12,
      openBlockingCount: 1,
      openWarningCount: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Blocking inspection findings remain open.");
  });

  test("rejects approval from a non-reviewable state", () => {
    const result = new ReviewApprovalPolicy().evaluate({
      status: "published",
      candidateChunkCount: 12,
      inspectedChunkCount: 12,
      openBlockingCount: 0,
      openWarningCount: 0,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Review run is not ready for review.");
  });

  test("rejects approval until every warning is acknowledged or resolved", () => {
    const result = new ReviewApprovalPolicy().evaluate({
      status: "review_ready",
      candidateChunkCount: 12,
      inspectedChunkCount: 12,
      openBlockingCount: 0,
      openWarningCount: 1,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("Inspection warnings remain unacknowledged.");
  });
});
