import {
  estimateTokenCount,
  type Chunk,
  type ChunkResult,
} from "./semantic-chunker.ts";

export interface AddendumChunkInput {
  pages: Array<{ pageNumber: number; text: string }>;
  fundName: string;
  amendmentNumber: string;
  effectiveDate: string;
  amendedDocumentTypes: string[];
}

interface AmendmentPair {
  previous: string;
  current: string;
}

function normalized(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function repeatedSections(text: string, heading: string): string[] {
  const pattern = new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const matches = [...text.matchAll(pattern)];
  return matches.map((match, index) =>
    text.slice(match.index, matches[index + 1]?.index ?? text.length)
  );
}

function firstCapture(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1]?.replace(/\s+/g, "") ?? null;
}

function currencyPair(values: Array<string | null>): AmendmentPair | null {
  if (values.length !== 2) return null;
  const [previous, current] = values;
  return previous && current ? { previous, current } : null;
}

function amendmentContext(input: AddendumChunkInput): string {
  return [
    `Notice-cum-Addendum ${input.amendmentNumber}.`,
    `Fund: ${input.fundName}.`,
    `Effective date: ${input.effectiveDate}.`,
  ].join(" ");
}

function pagesContaining(input: AddendumChunkInput, term: RegExp): number[] {
  const matches = input.pages
    .filter((page) => term.test(page.text))
    .map((page) => page.pageNumber);
  return matches.length > 0 ? matches : input.pages.map((page) => page.pageNumber);
}

function createChunk(
  input: AddendumChunkInput,
  sectionHeader: string,
  text: string,
  pageNumbers: number[],
  chunkIndex: number,
): Chunk {
  const completeText = `${amendmentContext(input)}\n\n${text}`;
  return {
    text: completeText,
    chunkIndex,
    pageNumbers,
    hasTable: false,
    sectionHeader,
    tokenCount: estimateTokenCount(completeText),
  };
}

/**
 * Converts an addendum's interleaved Existing/Proposed columns into explicit,
 * effective-dated facts. Returning null keeps the generic semantic chunker as
 * the safe fallback for addenda whose amendment pairs cannot be established.
 */
export function chunkAddendum(input: AddendumChunkInput): ChunkResult | null {
  const text = normalized(input.pages.map((page) => page.text).join("\n"));
  const accreditedAmounts = [...text.matchAll(
    /Minimum amount for accredited investor.*?Rs\.?\s*([\d,]+)/gi,
  )].map((match) => match[1]?.replace(/\s+/g, "") ?? null);
  const sipSections = repeatedSections(text, "Systematic Investment Plan");
  const swpSections = repeatedSections(text, "Systematic Withdrawal Plan");
  const sipAmendments = sipSections.map((section) => ({
    section,
    amount: firstCapture(section, /minimum amount of Rs\.?\s*([\d,]+)/i),
  })).filter((item): item is { section: string; amount: string } => Boolean(item.amount));
  const swpAmendments = swpSections.map((section) => ({
    section,
    amount: firstCapture(section, /for a minimum of Rs\.?\s*([\d,]+)/i),
  })).filter((item): item is { section: string; amount: string } => Boolean(item.amount));
  const exitLoads = [...text.matchAll(
    /redeemed within\s+(\d+)\s+days.*?(\d+(?:\.\d+)?)\s*%/gi,
  )].map((match) => ({ days: match[1], percent: match[2] }));

  const application = currencyPair(accreditedAmounts);
  const sip = currencyPair(sipAmendments.map((item) => item.amount));
  const swp = currencyPair(swpAmendments.map((item) => item.amount));
  const [previousExitLoad, currentExitLoad] = exitLoads.length === 2 ? exitLoads : [];
  if (!application || !sip || !swp || !previousExitLoad || !currentExitLoad) {
    return null;
  }

  const currentSip = sipAmendments[1]?.section ?? "";
  const currentSwp = swpAmendments[1]?.section ?? "";
  const sipGeneralMinimum = firstCapture(
    currentSip,
    /minimum investment amount.*?less than Rs\.?\s*([\d,]+)/i,
  );
  const sipAccreditedMinimum = firstCapture(
    currentSip,
    /accredited investor.*?at least Rs\.?\s*([\d,]+)/i,
  );
  const sipMinimumInstallments = firstCapture(
    currentSip,
    /minimum of\s+(\d+)\s+instal/i,
  );
  const swpGeneralMinimum = firstCapture(
    currentSwp,
    /minimum investment amount after each withdrawal.*?Rs\.?\s*([\d,]+)/i,
  );
  const swpAccreditedMinimum = firstCapture(
    currentSwp,
    /accredited investor.*?at least Rs\.?\s*([\d,]+)/i,
  );

  const chunks = [
    createChunk(
      input,
      "Addendum scope",
      `This addendum amends the ${input.amendedDocumentTypes.join(", ")} only for the provisions stated below. The amended provisions apply from ${input.effectiveDate}; all other terms and conditions remain unchanged.`,
      input.pages.map((page) => page.pageNumber),
      0,
    ),
    createChunk(
      input,
      "Minimum application amount",
      `Current minimum application amount for an accredited investor from ${input.effectiveDate}: Rs. ${application.current}. This supersedes the prior provision of Rs. ${application.previous}; do not use the prior amount for current queries.`,
      pagesContaining(input, /Minimum\s+Application\s+Amount/i),
      1,
    ),
    createChunk(
      input,
      "Systematic Investment Plan",
      [
        `Current minimum SIP installment from ${input.effectiveDate}: Rs. ${sip.current}.`,
        `This supersedes the prior installment of Rs. ${sip.previous}; do not use the prior amount for current queries.`,
        sipMinimumInstallments
          ? `The minimum number of SIP installments remains ${sipMinimumInstallments}.`
          : "",
        sipGeneralMinimum
          ? `The general minimum investment across Platinum SIF strategies is Rs. ${sipGeneralMinimum}.`
          : "",
        sipAccreditedMinimum
          ? `For an accredited investor in this fund, the minimum is Rs. ${sipAccreditedMinimum}.`
          : "",
      ].filter(Boolean).join(" "),
      pagesContaining(input, /Systematic Investment Plan/i),
      2,
    ),
    createChunk(
      input,
      "Systematic Withdrawal Plan",
      [
        `Current minimum SWP withdrawal from ${input.effectiveDate}: Rs. ${swp.current}.`,
        `This supersedes the prior withdrawal minimum of Rs. ${swp.previous}; do not use the prior amount for current queries.`,
        swpGeneralMinimum
          ? `After withdrawal, the general minimum investment is Rs. ${swpGeneralMinimum}.`
          : "",
        swpAccreditedMinimum
          ? `For an accredited investor in this fund, the maintained minimum is Rs. ${swpAccreditedMinimum}.`
          : "",
      ].filter(Boolean).join(" "),
      pagesContaining(input, /Systematic Withdrawal Plan/i),
      3,
    ),
    createChunk(
      input,
      "Exit Load",
      `Current exit load from ${input.effectiveDate}: ${currentExitLoad.percent}% when redeemed within ${currentExitLoad.days} days, and NIL afterward. This supersedes the prior ${previousExitLoad.days}-day window; do not use the prior window for current queries.`,
      pagesContaining(input, /Exit Load/i),
      4,
    ),
  ];

  return {
    chunks,
    totalChunks: chunks.length,
    totalTokens: chunks.reduce((total, item) => total + item.tokenCount, 0),
  };
}
