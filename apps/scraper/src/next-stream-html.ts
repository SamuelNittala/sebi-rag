import { load as cheerioLoad } from "cheerio";

interface StreamReplacement {
  boundaryId: string;
  segmentId: string;
}

const STREAM_REPLACEMENT_PATTERN = /\$RC\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g;

function streamedReplacements(html: string): StreamReplacement[] {
  return [...html.matchAll(STREAM_REPLACEMENT_PATTERN)].map((match) => ({
    boundaryId: match[1]!,
    segmentId: match[2]!,
  }));
}

function containsStreamReplacement(script: string): boolean {
  STREAM_REPLACEMENT_PATTERN.lastIndex = 0;
  const containsReplacement = STREAM_REPLACEMENT_PATTERN.test(script);
  STREAM_REPLACEMENT_PATTERN.lastIndex = 0;
  return containsReplacement;
}

/**
 * Applies the server-streamed React suspense replacements embedded in a Next.js
 * HTML response so downstream extraction sees resolved content, not fallbacks.
 */
export function resolveNextStreamedHtml(html: string): string {
  const replacements = streamedReplacements(html);
  if (replacements.length === 0) return html;

  const $ = cheerioLoad(html);
  const elementById = (id: string) => $("[id]").filter((_, element) => (
    $(element).attr("id") === id
  )).first();

  for (const replacement of replacements) {
    const boundary = elementById(replacement.boundaryId);
    const segment = elementById(replacement.segmentId);
    if (boundary.length === 0 || segment.length === 0) continue;

    const fallback = boundary.next();
    const streamedHtml = segment.html();
    if (streamedHtml) boundary.replaceWith(streamedHtml);
    else boundary.remove();

    if (/^Loading\b.*\.\.\.$/s.test(fallback.text().trim())) fallback.remove();
    segment.remove();
  }

  $("*").filter((_, element) => (
    $(element).children().length === 0
      && /^Loading\b.*\.\.\.$/s.test($(element).text().trim())
  )).remove();
  $("script").filter((_, element) => containsStreamReplacement($(element).text())).remove();
  return $.html();
}
