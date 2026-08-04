import { describe, expect, test } from "bun:test";

import { DocumentRiskPolicy } from "./document-risk-policy.ts";

const cleanEstablished = {
  isFirstVersion: false,
  candidateChunkCount: 2,
  inspectedChunkCount: 2,
  openBlockingCount: 0,
  openWarningCount: 0,
  extractionAnomaly: false,
  ownershipDrift: false,
  configRevisionDrift: false,
  parserVersionDrift: false,
  chunkerVersionDrift: false,
  inspectorVersionDrift: false,
} as const;

describe("DocumentRiskPolicy", () => {
  const policy = new DocumentRiskPolicy();

  test("system-approves only a completely inspected clean established update", () => {
    expect(policy.evaluate(cleanEstablished)).toEqual({
      classification: "low",
      route: "system_approve",
      policyVersion: DocumentRiskPolicy.version,
      reasonCodes: ["CLEAN_ESTABLISHED_UPDATE"],
      evidence: cleanEstablished,
    });
  });

  test.each([
    ["FIRST_VERSION", { isFirstVersion: true }],
    ["OPEN_BLOCKERS", { openBlockingCount: 1 }],
    ["OPEN_WARNINGS", { openWarningCount: 1 }],
    ["INCOMPLETE_INSPECTION", { inspectedChunkCount: 1 }],
    ["EXTRACTION_ANOMALY", { extractionAnomaly: true }],
    ["OWNERSHIP_DRIFT", { ownershipDrift: true }],
    ["CONFIG_REVISION_DRIFT", { configRevisionDrift: true }],
    ["PARSER_VERSION_DRIFT", { parserVersionDrift: true }],
    ["CHUNKER_VERSION_DRIFT", { chunkerVersionDrift: true }],
    ["INSPECTOR_VERSION_DRIFT", { inspectorVersionDrift: true }],
  ] as const)("routes %s to a human", (reason, change) => {
    const decision = policy.evaluate({ ...cleanEstablished, ...change });
    expect(decision.route).toBe("human_review");
    expect(decision.reasonCodes).toContain(reason);
  });
});
