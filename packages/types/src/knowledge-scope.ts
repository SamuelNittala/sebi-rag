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
