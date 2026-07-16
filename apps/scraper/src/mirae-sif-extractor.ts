interface MiraeFaq {
  question?: string;
  answer?: string;
}

function decodeFlightPayloads(html: string): string {
  const payloads: string[] = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    try {
      payloads.push(JSON.parse(match[1] ?? "\"\"") as string);
    } catch {
      // Ignore malformed or non-string flight frames.
    }
  }

  return payloads.join("");
}

function extractTextReferences(flightText: string): Map<string, string> {
  const references = new Map<string, string>();
  const pattern = /([0-9a-z]+):T([0-9a-f]+),/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(flightText)) !== null) {
    const referenceId = match[1];
    const encodedLength = match[2];
    if (!referenceId || !encodedLength) continue;

    const length = Number.parseInt(encodedLength, 16);
    const valueStart = match.index + match[0].length;
    references.set(referenceId, flightText.slice(valueStart, valueStart + length));
  }

  return references;
}

function extractJsonArray(text: string, marker: string): string | null {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "[") depth++;
    if (character === "]") depth--;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function stripLeakedFlightFrame(markdown: string): string {
  return markdown.replace(/\d+:\["\$","\$L[0-9a-z]+",null,\{.*$/is, "").trim();
}

function formatAnswer(answer: string): string {
  return stripLeakedFlightFrame(answer)
    .replace(/\r/g, "")
    .replace(/\s*#\s*/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function repairSplitFaqFields(faqs: MiraeFaq[]): MiraeFaq[] {
  const repaired = faqs.map((faq) => ({ ...faq }));

  for (let index = 1; index < repaired.length; index++) {
    const current = repaired[index];
    const previous = repaired[index - 1];
    if (!current?.question?.trim().startsWith("Yes.") || !previous?.answer) continue;

    const splitQuestion = previous.answer.match(/\s*#(Does[^#]*\?)\s*$/i);
    if (!splitQuestion?.[1] || splitQuestion.index === undefined) continue;

    previous.answer = previous.answer.slice(0, splitQuestion.index).trim();
    current.answer = `${current.question.trim()} ${current.answer?.trim() ?? ""}`.trim();
    current.question = splitQuestion[1].trim();
  }

  return repaired;
}

export function extractMiraeSifFaqMarkdown(html: string): string {
  const flightText = decodeFlightPayloads(html);
  const references = extractTextReferences(flightText);
  const faqJson = extractJsonArray(flightText, '"faqs":');
  if (!faqJson) return "";

  let faqs: MiraeFaq[];
  try {
    faqs = JSON.parse(faqJson) as MiraeFaq[];
  } catch {
    return "";
  }

  return repairSplitFaqFields(faqs)
    .map((faq) => {
      const referenceId = faq.answer?.trim().match(/^\$(\w+)$/)?.[1];
      return {
        question: faq.question?.trim(),
        answer: referenceId ? references.get(referenceId)?.trim() : faq.answer?.trim(),
      };
    })
    .filter((faq) => Boolean(faq.question && faq.answer))
    .map((faq) => `### ${faq.question}\n\n${formatAnswer(faq.answer!)}`)
    .join("\n\n");
}

function faqHeadingKey(section: string): string | null {
  const heading = section.match(/^###\s+(.+)$/m)?.[1];
  return heading ? heading.trim().toLowerCase() : null;
}

export function mergeMiraeSifFaqMarkdown(
  renderedMarkdown: string,
  extractedFaqMarkdown: string
): string {
  if (!extractedFaqMarkdown) return renderedMarkdown;

  const faqStart = renderedMarkdown.indexOf("Got Questions?");
  if (faqStart < 0) {
    return `${renderedMarkdown.trim()}\n\n## Got Questions? We've Got Answers!\n\n${extractedFaqMarkdown}`;
  }

  const productMarkdown = renderedMarkdown.slice(0, faqStart).trim();
  const renderedFaqMarkdown = stripLeakedFlightFrame(
    renderedMarkdown
      .slice(faqStart)
      .replace(/^Got Questions\?\s+We've Got Answers!\s+/i, "")
  );
  const renderedKeys = new Set(
    [...renderedFaqMarkdown.matchAll(/^###\s+(.+)$/gm)]
      .map((match) => match[1]?.trim().toLowerCase())
      .filter((heading): heading is string => Boolean(heading))
  );
  const missingSections = extractedFaqMarkdown
    .split(/(?=^###\s+)/gm)
    .filter((section) => {
      const key = faqHeadingKey(section);
      return key !== null && !renderedKeys.has(key);
    });
  const faqSections = [renderedFaqMarkdown, ...missingSections].filter(Boolean);

  return `${productMarkdown}\n\n## Got Questions? We've Got Answers!\n\n${faqSections.join("\n\n")}`;
}
