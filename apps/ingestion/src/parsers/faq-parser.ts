import type { FaqParserProfile } from "../sources/faq-sources.ts";

export interface FaqPage {
  pageNumber: number;
  text: string;
}

export interface FaqItem {
  question: string;
  answer: string;
  questionNumber: string | null;
  topic: string | null;
  pageNumbers: number[];
}

export type FaqExclusionReason =
  | "cover"
  | "contents"
  | "credits"
  | "page_footer"
  | "empty_artifact"
  | "topic_heading"
  | "source_numbering_artifact"
  | "editorial_note"
  | "preamble";

export interface FaqCoverageSegment {
  pageNumber: number;
  text: string;
}

export interface FaqExcludedSegment extends FaqCoverageSegment {
  reason: FaqExclusionReason;
}

export interface FaqCoverageReport {
  sourceSegmentCount: number;
  assignedSegmentCount: number;
  excluded: FaqExcludedSegment[];
  unexplained: FaqCoverageSegment[];
}

export interface FaqWarning {
  kind: "time_sensitive";
  itemIndex: number;
  terms: string[];
  message: string;
}

export interface FaqParseInput {
  profile: FaqParserProfile;
  pages: FaqPage[];
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
}

export interface FaqParseResult {
  profile: FaqParserProfile;
  items: FaqItem[];
  coverage: FaqCoverageReport;
  warnings: FaqWarning[];
  blockers: string[];
  reviewReady: boolean;
}

interface LineSegment extends FaqCoverageSegment {
  id: number;
  disposition?: "assigned" | "excluded" | "unexplained";
  exclusionReason?: FaqExclusionReason;
}

interface MutableFaqItem {
  questionSegments: LineSegment[];
  answerSegments: LineSegment[];
  questionNumber: string | null;
  topic: string | null;
}

const QUESTION_START = /^(?:(\d+)\s*[.)]\s*)?(what|why|when|where|who|whom|whose|which|how|can|could|do|does|is|are|should|will|would|may|if)\b/i;
const NISM_QUESTION_START = /^(\d+)\s*[.)]\s*(.*)$/;
const ANSWER_START = /^(?:\d+\.\s+)?Ans(?:wer)?\s*[.:)]?\s*(.*)$/i;
const TOPIC_HEADING = /^(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)\.\s+(.+)$/;
const TIME_SENSITIVE_TERMS = [
  "tax",
  "regulation",
  "limit",
  "cut-off",
  "cut off",
  "deadline",
  "days",
  "process",
  "kyc",
  "redemption",
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizedQuestionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueSortedPages(segments: LineSegment[]): number[] {
  return [...new Set(segments.map((segment) => segment.pageNumber))]
    .sort((left, right) => left - right);
}

function exclude(segment: LineSegment, reason: FaqExclusionReason): void {
  segment.disposition = "excluded";
  segment.exclusionReason = reason;
}

function assign(segment: LineSegment): void {
  segment.disposition = "assigned";
}

function unexplained(segment: LineSegment): void {
  segment.disposition = "unexplained";
}

function boilerplateReason(text: string): FaqExclusionReason | null {
  if (/^\[(?:image|icon|logo)\]$/i.test(text) || /^<image\b/i.test(text)) {
    return "empty_artifact";
  }
  if (
    /^Page\s+\d+\s+of\s+\d+$/i.test(text)
    || /^-\s*\d+\s*-$/.test(text)
    || /^\d+\s*\/\s*\d+$/.test(text)
  ) {
    return "page_footer";
  }
  if (
    /^(?:table of )?contents?$/i.test(text)
    || /\.{3,}\s*\d+\s*$/.test(text)
    || /^[IVXLCDM]+\.\s+.+\s+\d+\s*-\s*\d+$/.test(text)
  ) {
    return "contents";
  }
  if (
    /^(?:mutual fund faqs?|frequently asked questions(?: \(faqs?\))?)$/i.test(text)
    || /^national institute of securities markets$/i.test(text)
  ) {
    return "cover";
  }
  if (/^(?:copyright|©|all rights reserved|disclaimer)\b/i.test(text)) {
    return "credits";
  }
  if (/^(?:Too jumpy\b|single place\.$)/i.test(text)) {
    return "editorial_note";
  }
  return null;
}

function splitExtractedLine(
  text: string,
  profile: FaqParserProfile,
): string[] {
  if (profile !== "nism-numbered-v1") return [text];
  return text
    // Some NISM PDF text objects concatenate a complete numbered question to
    // the previous answer line. A terminal question mark is required so
    // ordinary numbered clauses remain answer content.
    .replace(/\s+(?=\d{1,3}\.\s+[^?\n]{2,240}\?)/g, "\n")
    // The answer marker may share the same extracted line as the question.
    .replace(/\s+(?=(?:\d{1,3}\.\s+)?Ans(?:wer)?\s*[.:)])/gi, "\n")
    // One source-side editing note is embedded after question 392.
    .replace(/\?\s+(?=Too jumpy\b)/i, "?\n")
    .split("\n")
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function toSegments(
  pages: FaqPage[],
  profile: FaqParserProfile,
): LineSegment[] {
  let id = 0;
  return pages.flatMap((page) =>
    page.text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(normalizeWhitespace)
      .filter(Boolean)
      .flatMap((text) => splitExtractedLine(text, profile))
      .map((text) => ({
        id: id++,
        pageNumber: page.pageNumber,
        text,
      }))
  );
}

function preclassifyBoilerplate(
  segments: LineSegment[],
  profile: FaqParserProfile,
): void {
  const nismCreditsPage = profile === "nism-numbered-v1"
    ? segments.find((segment) => /^Collators:$/i.test(segment.text))?.pageNumber
    : undefined;
  for (const segment of segments) {
    if (segment.pageNumber === nismCreditsPage) {
      exclude(
        segment,
        /^(?:FAQs? on Mutual Funds|Index)$/i.test(segment.text)
          ? "cover"
          : "credits",
      );
      continue;
    }
    const reason = boilerplateReason(segment.text);
    if (reason) exclude(segment, reason);
  }
}

function finalizeItem(item: MutableFaqItem): FaqItem {
  const question = normalizeWhitespace(item.questionSegments.map((segment) => {
    return segment.text.replace(/^\d+\s*[.)]\s*/, "");
  }).join(" "));
  const answer = normalizeWhitespace(item.answerSegments.map((segment) => segment.text).join(" "));
  return {
    question,
    answer,
    questionNumber: item.questionNumber,
    topic: item.topic,
    pageNumbers: uniqueSortedPages([
      ...item.questionSegments,
      ...item.answerSegments,
    ]),
  };
}

function parseSebi(segments: LineSegment[]): FaqItem[] {
  const items: FaqItem[] = [];
  let current: MutableFaqItem | null = null;
  let pendingQuestion = false;
  let seenQuestion = false;

  for (const segment of segments) {
    if (segment.disposition) continue;
    if (pendingQuestion && current) {
      current.questionSegments.push(segment);
      assign(segment);
      pendingQuestion = !segment.text.includes("?");
      continue;
    }
    const questionMatch = segment.text.match(QUESTION_START);
    const startsQuestion = Boolean(questionMatch)
      && (segment.text.includes("?") || /^\d+\s*[.)]/.test(segment.text));

    if (startsQuestion) {
      if (current) items.push(finalizeItem(current));
      const number = segment.text.match(/^(\d+)\s*[.)]/)?.[1] ?? null;
      current = {
        questionSegments: [segment],
        answerSegments: [],
        questionNumber: number,
        topic: null,
      };
      assign(segment);
      pendingQuestion = !segment.text.includes("?");
      seenQuestion = true;
      continue;
    }

    if (current) {
      current.answerSegments.push(segment);
      assign(segment);
    } else if (!seenQuestion) {
      exclude(segment, "preamble");
    } else {
      unexplained(segment);
    }
  }

  if (current) items.push(finalizeItem(current));
  return items;
}

function parseNism(segments: LineSegment[]): FaqItem[] {
  const items: FaqItem[] = [];
  let current: MutableFaqItem | null = null;
  let currentTopic: string | null = null;
  let waitingForAnswer = false;
  let seenQuestion = false;
  let lastQuestionNumber = 0;

  for (const segment of segments) {
    if (segment.disposition) continue;

    const topicMatch = segment.text.match(TOPIC_HEADING);
    const topicTitle = topicMatch?.[2];
    if (topicTitle && !segment.text.includes("?")) {
      currentTopic = normalizeWhitespace(topicTitle);
      exclude(segment, "topic_heading");
      continue;
    }

    const answerMatch = segment.text.match(ANSWER_START);
    if (answerMatch && current && waitingForAnswer) {
      assign(segment);
      if (answerMatch[1]) {
        current.answerSegments.push({
          ...segment,
          text: answerMatch[1],
          disposition: "assigned",
        });
      }
      waitingForAnswer = false;
      continue;
    }

    if (current && /^\d+\.\s*$/.test(segment.text)) {
      exclude(segment, "source_numbering_artifact");
      continue;
    }

    const questionMatch = segment.text.match(NISM_QUESTION_START);
    const questionNumberText = questionMatch?.[1] ?? "";
    const questionText = questionMatch?.[2] ?? "";
    const questionNumber = Number.parseInt(questionNumberText, 10) || 0;
    if (
      questionMatch
      && questionNumber > lastQuestionNumber
      && questionText.length < 250
      && (
        questionNumber === lastQuestionNumber + 1
        || questionText.includes("?")
        || QUESTION_START.test(questionText)
      )
    ) {
      if (current) items.push(finalizeItem(current));
      current = {
        questionSegments: [segment],
        answerSegments: [],
        questionNumber: questionNumberText,
        topic: currentTopic,
      };
      assign(segment);
      waitingForAnswer = true;
      seenQuestion = true;
      lastQuestionNumber = questionNumber;
      continue;
    }

    if (current && !waitingForAnswer) {
      current.answerSegments.push(segment);
      assign(segment);
    } else if (current && waitingForAnswer && !current.questionSegments.at(-1)?.text.includes("?")) {
      current.questionSegments.push(segment);
      assign(segment);
    } else if (!seenQuestion) {
      exclude(segment, "preamble");
    } else {
      unexplained(segment);
    }
  }

  if (current) items.push(finalizeItem(current));
  return items;
}

function buildWarnings(items: FaqItem[]): FaqWarning[] {
  return items.flatMap((item, itemIndex) => {
    const haystack = `${item.question} ${item.answer}`.toLowerCase();
    const terms = TIME_SENSITIVE_TERMS.filter((term) => haystack.includes(term));
    return terms.length === 0
      ? []
      : [{
          kind: "time_sensitive" as const,
          itemIndex,
          terms: [...terms],
          message: `Potentially time-sensitive FAQ guidance (${terms.join(", ")}); verify against source authority and date.`,
        }];
  });
}

function buildBlockers(
  items: FaqItem[],
  coverage: FaqCoverageReport,
  expectedQuestionCount: FaqParseInput["expectedQuestionCount"],
  expectedQuestionNumbers?: FaqParseInput["expectedQuestionNumbers"],
): string[] {
  const blockers: string[] = [];
  if (items.length === 0) blockers.push("FAQ extraction produced no questions.");
  if (
    items.length < expectedQuestionCount.min
    || items.length > expectedQuestionCount.max
  ) {
    blockers.push(
      `FAQ question count ${items.length} is outside approved bounds ${expectedQuestionCount.min}-${expectedQuestionCount.max}.`,
    );
  }
  items.forEach((item, index) => {
    if (!item.question) blockers.push(`FAQ item ${index + 1} has an empty question.`);
    if (!item.answer) blockers.push(`FAQ item ${index + 1} has an empty answer.`);
    if (item.pageNumbers.length === 0) {
      blockers.push(`FAQ item ${index + 1} has no page provenance.`);
    }
  });
  const keys = new Map<string, number>();
  items.forEach((item, index) => {
    const key = normalizedQuestionKey(item.question);
    const previous = keys.get(key);
    if (previous !== undefined) {
      blockers.push(
        `FAQ items ${previous + 1} and ${index + 1} are unresolved exact duplicate questions.`,
      );
    } else if (key) {
      keys.set(key, index);
    }
  });
  if (coverage.unexplained.length > 0) {
    blockers.push(
      `FAQ extraction left ${coverage.unexplained.length} non-boilerplate source segment(s) unexplained.`,
    );
  }
  if (expectedQuestionNumbers) {
    const observed = new Set(
      items.flatMap((item) => item.questionNumber ? [Number(item.questionNumber)] : []),
    );
    const missing: number[] = [];
    const excluded = new Set(
      expectedQuestionNumbers.exclusions?.map((entry) => entry.number) ?? [],
    );
    for (
      let number = expectedQuestionNumbers.first;
      number <= expectedQuestionNumbers.last;
      number += 1
    ) {
      if (!observed.has(number) && !excluded.has(number)) missing.push(number);
    }
    if (missing.length > 0) {
      blockers.push(
        `FAQ question-number sequence is incomplete; missing: ${missing.join(", ")}.`,
      );
    }
  }
  return blockers;
}

export function parseFaqPages(input: FaqParseInput): FaqParseResult {
  if (
    input.profile !== "sebi-unnumbered-v1"
    && input.profile !== "nism-numbered-v1"
  ) {
    throw new Error(`Unsupported FAQ parser profile: ${input.profile}`);
  }
  if (input.pages.length === 0 || input.pages.every((page) => !page.text.trim())) {
    throw new Error("FAQ extraction is empty.");
  }

  const segments = toSegments(input.pages, input.profile);
  preclassifyBoilerplate(segments, input.profile);
  const items = input.profile === "sebi-unnumbered-v1"
    ? parseSebi(segments)
    : parseNism(segments);
  for (const segment of segments) {
    if (!segment.disposition) unexplained(segment);
  }
  const coverage: FaqCoverageReport = {
    sourceSegmentCount: segments.length,
    assignedSegmentCount: segments.filter(
      (segment) => segment.disposition === "assigned",
    ).length,
    excluded: segments
      .filter((segment) => segment.disposition === "excluded")
      .map((segment) => ({
        pageNumber: segment.pageNumber,
        text: segment.text,
        reason: segment.exclusionReason!,
      })),
    unexplained: segments
      .filter((segment) => segment.disposition === "unexplained")
      .map(({ pageNumber, text }) => ({ pageNumber, text })),
  };
  const blockers = buildBlockers(
    items,
    coverage,
    input.expectedQuestionCount,
    input.expectedQuestionNumbers,
  );
  return {
    profile: input.profile,
    items,
    coverage,
    warnings: buildWarnings(items),
    blockers,
    reviewReady: blockers.length === 0,
  };
}
