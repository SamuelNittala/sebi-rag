import { estimateTokenCount, type Chunk } from "./semantic-chunker.ts";
import type { FaqItem } from "../parsers/faq-parser.ts";
import type {
  FaqAuthority,
  FaqParserProfile,
} from "../sources/faq-sources.ts";

export interface FaqChunkSource {
  id: string;
  title: string;
  publisher: string;
  authority: FaqAuthority;
  canonicalUrl: string;
  sourceDate: string;
  sha256: string;
  parserProfile: FaqParserProfile;
}

export interface FaqChunkMetadata {
  sourceId: string;
  sourceTitle: string;
  publisher: string;
  authority: FaqAuthority;
  sourceUrl: string;
  sourceDate: string;
  sourceChecksum: string;
  sourceProfile: FaqParserProfile;
  topic: string | null;
  questionNumber: string | null;
  normalizedQuestionKey: string;
  originalQuestion: string;
  continuationIndex: number;
  firstPage: number;
  lastPage: number;
}

export interface FaqChunk extends Chunk {
  faq: FaqChunkMetadata;
}

export interface FaqChunkResult {
  chunks: FaqChunk[];
  totalChunks: number;
  totalTokens: number;
}

export interface FaqChunkInput {
  source: FaqChunkSource;
  items: FaqItem[];
  maxTokens?: number;
}

function normalizedQuestionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitWords(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current: string[] = [];
  for (const word of words) {
    const candidate = [...current, word].join(" ");
    if (current.length > 0 && estimateTokenCount(candidate) > maxTokens) {
      parts.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) parts.push(current.join(" "));
  return parts;
}

function splitLongParagraph(paragraph: string, maxTokens: number): string[] {
  if (estimateTokenCount(paragraph) <= maxTokens) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [paragraph];
  const result: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (estimateTokenCount(sentence) > maxTokens) {
      if (current) {
        result.push(current);
        current = "";
      }
      result.push(...splitWords(sentence, maxTokens));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && estimateTokenCount(candidate) > maxTokens) {
      result.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}

function splitAnswer(answer: string, maxTokens: number): string[] {
  const paragraphs = answer
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => splitLongParagraph(paragraph, maxTokens));
  const parts: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (current && estimateTokenCount(candidate) > maxTokens) {
      parts.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function renderChunk(
  source: FaqChunkSource,
  item: FaqItem,
  answerPart: string,
  continuationIndex: number,
  continuationCount: number,
): string {
  const lines = [
    `Source: ${source.title}`,
    `Publisher: ${source.publisher}`,
    `Source date: ${source.sourceDate}`,
    item.topic ? `Topic: ${item.topic}` : null,
    item.questionNumber ? `Question number: ${item.questionNumber}` : null,
    `Question: ${item.question}`,
    continuationCount > 1
      ? `Answer (continuation ${continuationIndex + 1} of ${continuationCount}): ${answerPart}`
      : `Answer: ${answerPart}`,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export function chunkFaqItems(input: FaqChunkInput): FaqChunkResult {
  const maxTokens = input.maxTokens ?? 700;
  if (!Number.isFinite(maxTokens) || maxTokens < 32) {
    throw new Error("FAQ maxTokens must be at least 32.");
  }
  const chunks: FaqChunk[] = [];

  for (const item of input.items) {
    if (!item.question.trim() || !item.answer.trim()) {
      throw new Error("FAQ chunks require non-empty question and answer text.");
    }
    if (item.pageNumbers.length === 0) {
      throw new Error("FAQ chunks require page provenance.");
    }
    const firstPage = Math.min(...item.pageNumbers);
    const lastPage = Math.max(...item.pageNumbers);
    const contextTokens = estimateTokenCount(renderChunk(input.source, item, "", 0, 1));
    const answerBudget = Math.max(20, maxTokens - contextTokens);
    const answerParts = splitAnswer(item.answer, answerBudget);

    answerParts.forEach((answerPart, continuationIndex) => {
      const text = renderChunk(
        input.source,
        item,
        answerPart,
        continuationIndex,
        answerParts.length,
      );
      chunks.push({
        text,
        chunkIndex: chunks.length,
        pageNumbers: [...item.pageNumbers],
        hasTable: false,
        sectionHeader: item.topic,
        tokenCount: estimateTokenCount(text),
        faq: {
          sourceId: input.source.id,
          sourceTitle: input.source.title,
          publisher: input.source.publisher,
          authority: input.source.authority,
          sourceUrl: input.source.canonicalUrl,
          sourceDate: input.source.sourceDate,
          sourceChecksum: input.source.sha256,
          sourceProfile: input.source.parserProfile,
          topic: item.topic,
          questionNumber: item.questionNumber,
          normalizedQuestionKey: normalizedQuestionKey(item.question),
          originalQuestion: item.question,
          continuationIndex,
          firstPage,
          lastPage,
        },
      });
    });
  }

  return {
    chunks,
    totalChunks: chunks.length,
    totalTokens: chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
  };
}
