import { parsePDF, type PdfParseLimits } from "./pdf-parser.ts";

interface ParseRequest {
  readonly filepath: string;
  readonly limits: PdfParseLimits;
}

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  try {
    self.postMessage({ ok: true, value: await parsePDF(event.data.filepath, event.data.limits) });
  } catch (error) {
    const failure = error instanceof Error
      ? error as Error & { code?: string; classification?: string }
      : null;
    self.postMessage({
      ok: false,
      error: {
        message: failure?.message ?? String(error),
        code: failure?.code,
        classification: failure?.classification,
      },
    });
  }
};
