import type { KnowledgeScope } from "@mf-rag/types";

export interface KnowledgeSourceDescriptor {
  source: string;
  sourceUrl: string;
  title?: string;
  explicitScope?: KnowledgeScope;
}

const MIRAE_SIF_HOST = "platinumsif.miraeassetmf.co.in";
const SIF_PATTERN = /\bSIF\b|speciali[sz]ed[-_\s]+investment[-_\s]+fund/i;

function isMiraeSifSource(descriptor: KnowledgeSourceDescriptor): boolean {
  const documentIdentity = `${descriptor.sourceUrl} ${descriptor.title ?? ""}`;
  return descriptor.source.toLowerCase().includes("mirae-sif")
    || descriptor.sourceUrl.toLowerCase().includes(MIRAE_SIF_HOST)
    || (/\bmirae\b/i.test(documentIdentity)
      && (SIF_PATTERN.test(documentIdentity) || /\bplatinum\b.*\blong-short\b/i.test(documentIdentity)));
}

function isSebiSifSource(descriptor: KnowledgeSourceDescriptor): boolean {
  const source = descriptor.source.replace(/[-_]/g, " ");
  const isSebiSource = descriptor.source.toLowerCase().startsWith("sebi-")
    || descriptor.sourceUrl.toLowerCase().includes("sebi.gov.in/");
  return isSebiSource
    && SIF_PATTERN.test(`${source} ${descriptor.sourceUrl} ${descriptor.title ?? ""}`);
}

export function resolveKnowledgeScope(
  descriptor: KnowledgeSourceDescriptor
): KnowledgeScope {
  if (descriptor.explicitScope) return descriptor.explicitScope;

  if (isMiraeSifSource(descriptor)) {
    return {
      knowledgeDomain: "sif",
      sourceCollection: "mirae_sif",
      amcSlug: "mirae-asset",
    };
  }

  // IndusInd/BFIL demo corpus — mirrors the mirae-sif source mapping.
  if (descriptor.source.toLowerCase().includes("indusind-demo")) {
    return {
      knowledgeDomain: "microfinance",
      sourceCollection: "indusind_demo",
      amcSlug: "indusind-bfil",
    };
  }

  if (isSebiSifSource(descriptor)) {
    return {
      knowledgeDomain: "sif",
      sourceCollection: "sebi_regulatory",
      amcSlug: null,
    };
  }

  return {
    knowledgeDomain: "mutual_fund",
    sourceCollection: "default_corpus",
    amcSlug: null,
  };
}
