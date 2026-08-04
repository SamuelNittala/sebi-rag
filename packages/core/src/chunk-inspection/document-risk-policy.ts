export const documentRiskRoutes = ["system_approve", "human_review"] as const;
export type DocumentRiskRoute = (typeof documentRiskRoutes)[number];

export const documentRiskClassifications = ["low", "elevated"] as const;
export type DocumentRiskClassification = (typeof documentRiskClassifications)[number];

export interface DocumentRiskEvidence {
  readonly isFirstVersion: boolean;
  readonly candidateChunkCount: number;
  readonly inspectedChunkCount: number;
  readonly openBlockingCount: number;
  readonly openWarningCount: number;
  readonly extractionAnomaly: boolean;
  readonly ownershipDrift: boolean;
  readonly configRevisionDrift: boolean;
  readonly parserVersionDrift: boolean;
  readonly chunkerVersionDrift: boolean;
  readonly inspectorVersionDrift: boolean;
}

export interface DocumentRiskDecision {
  readonly classification: DocumentRiskClassification;
  readonly route: DocumentRiskRoute;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly evidence: DocumentRiskEvidence;
}

/** Pure, versioned fail-closed policy. Every elevated signal requires a person. */
export class DocumentRiskPolicy {
  static readonly version = "document-risk-v1";

  evaluate(evidence: DocumentRiskEvidence): DocumentRiskDecision {
    const reasonCodes: string[] = [];
    if (evidence.isFirstVersion) reasonCodes.push("FIRST_VERSION");
    if (evidence.candidateChunkCount <= 0
      || evidence.inspectedChunkCount !== evidence.candidateChunkCount) {
      reasonCodes.push("INCOMPLETE_INSPECTION");
    }
    if (evidence.openBlockingCount > 0) reasonCodes.push("OPEN_BLOCKERS");
    if (evidence.openWarningCount > 0) reasonCodes.push("OPEN_WARNINGS");
    if (evidence.extractionAnomaly) reasonCodes.push("EXTRACTION_ANOMALY");
    if (evidence.ownershipDrift) reasonCodes.push("OWNERSHIP_DRIFT");
    if (evidence.configRevisionDrift) reasonCodes.push("CONFIG_REVISION_DRIFT");
    if (evidence.parserVersionDrift) reasonCodes.push("PARSER_VERSION_DRIFT");
    if (evidence.chunkerVersionDrift) reasonCodes.push("CHUNKER_VERSION_DRIFT");
    if (evidence.inspectorVersionDrift) reasonCodes.push("INSPECTOR_VERSION_DRIFT");
    const elevated = reasonCodes.length > 0;
    return {
      classification: elevated ? "elevated" : "low",
      route: elevated ? "human_review" : "system_approve",
      policyVersion: DocumentRiskPolicy.version,
      reasonCodes: elevated ? reasonCodes : ["CLEAN_ESTABLISHED_UPDATE"],
      evidence,
    };
  }
}
