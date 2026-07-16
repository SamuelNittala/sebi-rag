import type { ReviewRunStatus } from "@mf-rag/types";

export interface ReviewApprovalState {
  status: ReviewRunStatus;
  candidateChunkCount: number;
  inspectedChunkCount: number;
  openBlockingCount: number;
}
export interface ReviewApprovalDecision {
  allowed: boolean;
  reasons: string[];
}

export class ReviewApprovalPolicy {
  evaluate(state: ReviewApprovalState): ReviewApprovalDecision {
    const reasons: string[] = [];
    if (state.status !== "review_ready") {
      reasons.push("Review run is not ready for review.");
    }
    if (state.inspectedChunkCount !== state.candidateChunkCount) {
      reasons.push("Not every candidate chunk was inspected.");
    }
    if (state.openBlockingCount > 0) {
      reasons.push("Blocking inspection findings remain open.");
    }
    return { allowed: reasons.length === 0, reasons };
  }
}
