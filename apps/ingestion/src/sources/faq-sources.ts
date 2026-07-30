import type { ClassifiedKnowledgeOwnership } from "@mf-rag/types";

export type FaqParserProfile = "sebi-unnumbered-v1" | "nism-numbered-v1";
export type FaqAuthority = "regulator" | "sebi_established_institute";

export interface FaqSourceDefinition {
  id: string;
  title: string;
  publisher: string;
  canonicalUrl: string;
  sourceDate: string;
  sha256: string;
  authority: FaqAuthority;
  parserProfile: FaqParserProfile;
  expectedQuestionCount: {
    min: number;
    max: number;
  };
  expectedQuestionNumbers?: {
    first: number;
    last: number;
    exclusions?: Array<{
      number: number;
      reason: string;
    }>;
  };
  knowledgeDomain: "mutual_fund";
  sourceCollection: "general_mf_faq";
  documentKind: "FAQ";
  ownership: ClassifiedKnowledgeOwnership;
}

const GLOBAL_FAQ_OWNERSHIP: ClassifiedKnowledgeOwnership = {
  visibilityScope: "GLOBAL",
  tenantId: null,
  ownershipManifestId: "curated-global-faq",
  ownershipManifestVersion: 1,
};

/**
 * Trusted source selection for the first global FAQ milestone.
 *
 * Checksums were computed from successful application/pdf responses with a
 * %PDF- signature inside the Docker Compose runner on 2026-07-30.
 */
export const FAQ_SOURCE_MANIFEST: readonly FaqSourceDefinition[] = [
  {
    id: "sebi-mutual-fund-investor-faq",
    title: "FAQs for Mutual Fund Investors",
    publisher: "Securities and Exchange Board of India",
    canonicalUrl:
      "https://www.sebi.gov.in/sebi_data/faqfiles/sep-2024/1727242783639.pdf",
    sourceDate: "2024-09-25",
    sha256: "19c8112711530dd769b95bdc73e298342ac6ee62d047dc4e97bf6515dd2953ed",
    authority: "regulator",
    parserProfile: "sebi-unnumbered-v1",
    expectedQuestionCount: { min: 35, max: 60 },
    knowledgeDomain: "mutual_fund",
    sourceCollection: "general_mf_faq",
    documentKind: "FAQ",
    ownership: GLOBAL_FAQ_OWNERSHIP,
  },
  {
    id: "nism-mutual-fund-faq",
    title: "Mutual Fund FAQs",
    publisher: "National Institute of Securities Markets",
    canonicalUrl:
      "https://www.nism.ac.in/wp-content/uploads/2021/02/FAQsOnMfs-3-1.pdf",
    sourceDate: "2021-02-01",
    sha256: "8109a4132ff91936203e3a66c137b6060f041adf9d7b9ae1efaf6b3342daff05",
    authority: "sebi_established_institute",
    parserProfile: "nism-numbered-v1",
    expectedQuestionCount: { min: 436, max: 436 },
    expectedQuestionNumbers: {
      first: 1,
      last: 440,
      exclusions: [
        { number: 141, reason: "The PDF contains only the standalone number 141 with no question or answer text." },
        { number: 346, reason: "The PDF prefixes question 345's answer marker with 346; it is not a separate FAQ." },
        { number: 347, reason: "The PDF contains only the standalone number 347 with no question or answer text." },
        { number: 399, reason: "The PDF inserts standalone 399 between question 398 and its answer." },
      ],
    },
    knowledgeDomain: "mutual_fund",
    sourceCollection: "general_mf_faq",
    documentKind: "FAQ",
    ownership: GLOBAL_FAQ_OWNERSHIP,
  },
] as const;

const SUPPORTED_PROFILES = new Set<FaqParserProfile>([
  "sebi-unnumbered-v1",
  "nism-numbered-v1",
]);

export function validateFaqSource(
  source: FaqSourceDefinition,
): FaqSourceDefinition {
  const requiredStrings: Array<keyof Pick<
    FaqSourceDefinition,
    "id" | "title" | "publisher" | "canonicalUrl" | "sourceDate" | "sha256"
  >> = ["id", "title", "publisher", "canonicalUrl", "sourceDate", "sha256"];
  for (const field of requiredStrings) {
    if (!source[field]?.trim()) {
      throw new Error(`FAQ source ${field} is required.`);
    }
  }

  const url = new URL(source.canonicalUrl);
  if (url.protocol !== "https:") {
    throw new Error("FAQ source canonicalUrl must use HTTPS.");
  }
  if (!/^(?:www\.)?(?:sebi\.gov\.in|nism\.ac\.in)$/.test(url.hostname)) {
    throw new Error(`FAQ source host is not trusted: ${url.hostname}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.sourceDate)) {
    throw new Error("FAQ source sourceDate must be ISO YYYY-MM-DD.");
  }
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error("FAQ source sha256 must be a lowercase SHA-256 digest.");
  }
  if (!SUPPORTED_PROFILES.has(source.parserProfile)) {
    throw new Error(`Unsupported FAQ parser profile: ${source.parserProfile}`);
  }
  if (
    !Number.isInteger(source.expectedQuestionCount.min)
    || !Number.isInteger(source.expectedQuestionCount.max)
    || source.expectedQuestionCount.min < 1
    || source.expectedQuestionCount.max < source.expectedQuestionCount.min
  ) {
    throw new Error("FAQ source expected question-count bounds are invalid.");
  }
  if (source.expectedQuestionNumbers) {
    const { first, last, exclusions = [] } = source.expectedQuestionNumbers;
    const excludedNumbers = new Set(exclusions.map((entry) => entry.number));
    if (
      !Number.isInteger(first)
      || !Number.isInteger(last)
      || first < 1
      || last < first
      || excludedNumbers.size !== exclusions.length
      || exclusions.some((entry) =>
        entry.number < first || entry.number > last || !entry.reason.trim())
    ) {
      throw new Error("FAQ source expected question-number contract is invalid.");
    }
    const expectedCount = last - first + 1 - exclusions.length;
    if (
      source.expectedQuestionCount.min !== expectedCount
      || source.expectedQuestionCount.max !== expectedCount
    ) {
      throw new Error(
        "FAQ source question-count bounds do not match its number contract.",
      );
    }
  }
  if (
    source.knowledgeDomain !== "mutual_fund"
    || source.sourceCollection !== "general_mf_faq"
    || source.documentKind !== "FAQ"
  ) {
    throw new Error("FAQ source generic education metadata is invalid.");
  }
  if (
    source.ownership.visibilityScope !== "GLOBAL"
    || source.ownership.tenantId !== null
    || !source.ownership.ownershipManifestId
    || !Number.isInteger(source.ownership.ownershipManifestVersion)
  ) {
    throw new Error("FAQ source ownership must be classified GLOBAL manifest ownership.");
  }

  return source;
}

export function getFaqSource(id: string): FaqSourceDefinition {
  const source = FAQ_SOURCE_MANIFEST.find((candidate) => candidate.id === id);
  if (!source) {
    throw new Error(`Curated FAQ source not found: ${id}`);
  }
  return validateFaqSource(source);
}
