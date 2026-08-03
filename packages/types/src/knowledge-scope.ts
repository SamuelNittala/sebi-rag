export type KnowledgeDomain = "mutual_fund" | "sif";

export type SourceCollection =
  | "default_corpus"
  | "mirae_sif"
  | "sebi_regulatory"
  | "general_mf_faq";

export interface KnowledgeScope {
  knowledgeDomain: KnowledgeDomain;
  sourceCollection: SourceCollection;
  amcSlug: string | null;
}

export const visibilityScopes = ["GLOBAL", "TENANT", "UNCLASSIFIED"] as const;
export type VisibilityScope = (typeof visibilityScopes)[number];

export type KnowledgeOwnership =
  | {
      visibilityScope: "GLOBAL";
      tenantId: null;
      ownershipManifestId: string;
      ownershipManifestVersion: number;
    }
  | {
      visibilityScope: "TENANT";
      tenantId: string;
      ownershipManifestId: string;
      ownershipManifestVersion: number;
    }
  | {
      visibilityScope: "UNCLASSIFIED";
      tenantId: null;
      ownershipManifestId: null;
      ownershipManifestVersion: null;
    };

export type ClassifiedKnowledgeOwnership = Exclude<
  KnowledgeOwnership,
  { visibilityScope: "UNCLASSIFIED" }
>;

export function assertClassifiedKnowledgeOwnership(
  ownership: KnowledgeOwnership | null | undefined,
): asserts ownership is ClassifiedKnowledgeOwnership {
  if (!ownership) {
    throw new Error("Trusted ownership is required.");
  }
  if (ownership.visibilityScope === "UNCLASSIFIED") {
    throw new Error("Trusted ownership must be GLOBAL or TENANT; UNCLASSIFIED content cannot enter review.");
  }
  if (typeof ownership.ownershipManifestId !== "string"
    || !ownership.ownershipManifestId.trim()) {
    throw new Error("Trusted ownership requires an ownership manifest ID.");
  }
  if (!Number.isInteger(ownership.ownershipManifestVersion)
    || ownership.ownershipManifestVersion <= 0) {
    throw new Error("Trusted ownership requires a positive ownership manifest version.");
  }
  if (ownership.visibilityScope === "GLOBAL" && ownership.tenantId !== null) {
    throw new Error("GLOBAL ownership cannot specify a tenant.");
  }
  if (ownership.visibilityScope === "TENANT"
    && (typeof ownership.tenantId !== "string" || !ownership.tenantId.trim())) {
    throw new Error("TENANT ownership requires a tenant ID.");
  }
}
