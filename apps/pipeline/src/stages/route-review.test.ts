import { describe, expect, test } from "bun:test";

import { RouteReviewStage } from "./route-review.ts";

const context = {
  pipelineRunId: "pipeline-1",
  documentVersionId: "version-2",
  accessScopeId: "scope-1",
  sourceId: "source-1",
  inputChecksum: "a".repeat(64),
  signal: new AbortController().signal,
};

describe("RouteReviewStage", () => {
  test("system-approves only a clean update relative to its published lineage", async () => {
    let persisted: { route: string; actor: string; reasonCodes: readonly string[] } | undefined;
    const run = {
      id: "review-1",
      pipelineRunId: context.pipelineRunId,
      documentVersionId: context.documentVersionId,
      candidateChunkCount: 1,
      inspectedChunkCount: 1,
      blockingCount: 0,
      warningCount: 0,
      criticalCount: 0,
      visibilityScope: "TENANT",
      tenantId: "910",
      ownershipManifestId: "source-registry:r1",
      ownershipManifestVersion: 1,
      configRevisionId: "r1",
      parserVersion: "parser-v1",
      chunkerVersion: "chunker-v1",
      inspectorVersion: "inspector-v1",
    };
    const stage = new RouteReviewStage({
      repository: {
        loadReviewRunId: async () => run.id,
        loadRiskContext: async () => ({
          run: run as never,
          isFirstVersion: false,
          previousPublication: {
            ...run,
            configRevisionId: "r1",
            parserVersion: "parser-v1",
            chunkerVersion: "chunker-v1",
            inspectorVersion: "inspector-v1",
          } as never,
        }),
        persist: async (input) => {
          persisted = input;
          return { id: input.runId };
        },
      },
    });

    const result = await stage.execute(context);

    expect(persisted).toMatchObject({
      route: "system_approve",
      actor: "system:risk-policy",
      reasonCodes: ["CLEAN_ESTABLISHED_UPDATE"],
    });
    expect(result.outputRef).toBe("risk-decision:review-1");
    expect(result.outputChecksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
