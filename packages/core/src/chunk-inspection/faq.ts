export function extractFaqAnswer(text: string): string {
  return text.match(
    /(?:^|\n)Answer(?:\s*\([^)]*\))?:\s*([\s\S]+)$/i,
  )?.[1]?.trim() ?? "";
}
