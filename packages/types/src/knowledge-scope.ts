export type KnowledgeDomain = "mutual_fund" | "sif";

export type SourceCollection =
  | "default_corpus"
  | "mirae_sif"
  | "sebi_regulatory";

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
