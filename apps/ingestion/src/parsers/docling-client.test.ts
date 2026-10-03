import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { DOCLING_PARSE_MEDIA_TYPE } from "./docling-contract.ts";
import { parseWithDocling } from "./docling-client.ts";
import { minimalDoclingResponse, TEST_DOCLING_PARSER_VERSION } from "./docling-test-fixture.ts";

const pdf = new TextEncoder().encode("%PDF-1.7\ndocling client fixture");
const pdfSha256 = createHash("sha256").update(pdf).digest("hex");
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return server.url.href;
}

function validBody(overrides: (body: any) => void = () => {}): any {
  const body: any = structuredClone(minimalDoclingResponse({ sha256: pdfSha256, byteSize: pdf.byteLength }));
  overrides(body);
  return body;
}

function options(baseUrl: string, extra: Partial<Parameters<typeof parseWithDocling>[1]> = {}) {
  return { baseUrl, expectedParserVersion: TEST_DOCLING_PARSER_VERSION, maxResponseBytes: 1_000_000, ...extra };
}

describe("parseWithDocling", () => {
  test("posts PDF bytes with their checksum and returns the validated response", async () => {
    const seen: { path: string; contentType: string | null; sha: string | null; accept: string | null; body: Uint8Array }[] = [];
    const baseUrl = serve(async (request) => {
      seen.push({
        path: `${request.method} ${new URL(request.url).pathname}`,
        contentType: request.headers.get("content-type"),
        sha: request.headers.get("x-content-sha256"),
        accept: request.headers.get("accept"),
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return Response.json(validBody());
    });

    const response = await parseWithDocling(pdf, options(baseUrl));

    expect(response.producer.parserVersion).toBe(TEST_DOCLING_PARSER_VERSION);
    expect(response.chunks).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: "POST /v1/parse",
      contentType: "application/pdf",
      sha: pdfSha256,
      accept: DOCLING_PARSE_MEDIA_TYPE,
    });
    expect(seen[0]!.body).toEqual(pdf);
  });

  test("disables Bun's 300 s fetch timeout so long conversions are bounded only by the caller's deadline", async () => {
    const baseUrl = serve(() => Response.json(validBody(), { headers: { "content-type": DOCLING_PARSE_MEDIA_TYPE } }));
    const realFetch = globalThis.fetch;
    const inits: (RequestInit & { timeout?: unknown })[] = [];
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      inits.push(init ?? {});
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await parseWithDocling(pdf, options(baseUrl));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(inits).toHaveLength(1);
    expect(inits[0]!.timeout).toBe(false);
  });

  test("maps a 422 service code to a deterministic error with the same code", async () => {
    const baseUrl = serve(() => Response.json({ code: "PDF_PAGE_LIMIT_EXCEEDED" }, { status: 422 }));

    await expect(parseWithDocling(pdf, options(baseUrl)))
      .rejects.toMatchObject({ code: "PDF_PAGE_LIMIT_EXCEEDED", classification: "deterministic" });
  });

  test("does not trust malformed 422 codes", async () => {
    const baseUrl = serve(() => Response.json({ code: "bad code /etc/passwd" }, { status: 422 }));

    const error = await parseWithDocling(pdf, options(baseUrl)).catch((caught) => caught);
    expect(error).toMatchObject({ code: "DOCLING_UNPROCESSABLE", classification: "deterministic" });
    expect(error.message).not.toContain("/etc/passwd");
  });

  test.each([
    [400, "DOCLING_CHECKSUM_REJECTED"],
    [413, "DOCLING_UPLOAD_TOO_LARGE"],
    [415, "DOCLING_UNSUPPORTED_MEDIA_TYPE"],
  ])("maps HTTP %d to deterministic %s", async (status, code) => {
    const baseUrl = serve(() => Response.json({ code: "IGNORED" }, { status }));

    await expect(parseWithDocling(pdf, options(baseUrl)))
      .rejects.toMatchObject({ code, classification: "deterministic" });
  });

  test.each([500, 502, 503])("maps HTTP %d to a transient error", async (status) => {
    const baseUrl = serve(() => new Response("Traceback: /app/secret.py", { status }));

    const error = await parseWithDocling(pdf, options(baseUrl)).catch((caught) => caught);
    expect(error).toMatchObject({ code: "DOCLING_SERVICE_ERROR", classification: "transient" });
    expect(error.message).not.toContain("secret");
  });

  test("maps connection refused to a transient error", async () => {
    const baseUrl = serve(() => new Response("unused"));
    servers.splice(0).forEach((server) => server.stop(true));

    await expect(parseWithDocling(pdf, options(baseUrl)))
      .rejects.toMatchObject({ code: "DOCLING_SERVICE_UNAVAILABLE", classification: "transient" });
  });

  test("propagates caller aborts and deadlines instead of reclassifying them", async () => {
    const baseUrl = serve(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    setTimeout(() => controller.abort(reason), 10);

    await expect(parseWithDocling(pdf, options(baseUrl, { signal: controller.signal }))).rejects.toBe(reason);

    const deadline = AbortSignal.timeout(10);
    const error = await parseWithDocling(pdf, options(baseUrl, { signal: deadline })).catch((caught) => caught);
    expect(deadline.aborted).toBe(true);
    expect(error).toBe(deadline.reason);
  });

  test("rejects responses over the byte cap, declared or streamed", async () => {
    const body = JSON.stringify(validBody());
    const declared = serve(() => new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(parseWithDocling(pdf, options(declared, { maxResponseBytes: 100 })))
      .rejects.toMatchObject({ code: "DOCLING_RESPONSE_TOO_LARGE", classification: "deterministic" });

    const streamed = serve(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.enqueue(new TextEncoder().encode(" ".repeat(200)));
        controller.close();
      },
    })));
    await expect(parseWithDocling(pdf, options(streamed, { maxResponseBytes: body.length + 10 })))
      .rejects.toMatchObject({ code: "DOCLING_RESPONSE_TOO_LARGE", classification: "deterministic" });
  });

  test("rejects non-JSON and contract-violating 200 responses deterministically", async () => {
    const notJson = serve(() => new Response("<html>"));
    await expect(parseWithDocling(pdf, options(notJson)))
      .rejects.toMatchObject({ code: "INVALID_DOCLING_RESPONSE", classification: "deterministic" });

    const invalid = serve(() => Response.json(validBody((body) => { body.chunks = []; })));
    await expect(parseWithDocling(pdf, options(invalid)))
      .rejects.toMatchObject({ code: "INVALID_DOCLING_RESPONSE", classification: "deterministic" });
  });

  test("treats a producer parser version change as transient DOCLING_VERSION_CHANGED", async () => {
    const baseUrl = serve(() => Response.json(validBody()));

    await expect(parseWithDocling(pdf, options(baseUrl, {
      expectedParserVersion: "docling-2.133.0+norm-1+opts-3f9a1c2b7d10",
    }))).rejects.toMatchObject({ code: "DOCLING_VERSION_CHANGED", classification: "transient" });
  });

  test.each([
    ["sha256", (body: any) => { body.source.sha256 = "b".repeat(64); }],
    ["byteSize", (body: any) => { body.source.byteSize += 1; }],
  ])("rejects a response whose source %s differs from the request", async (_field, mutate) => {
    const baseUrl = serve(() => Response.json(validBody(mutate)));

    await expect(parseWithDocling(pdf, options(baseUrl)))
      .rejects.toMatchObject({ code: "DOCLING_SOURCE_MISMATCH", classification: "deterministic" });
  });

  test("does not follow redirects away from the configured service", async () => {
    const target = serve(() => Response.json(validBody()));
    const baseUrl = serve(() => Response.redirect(`${target}v1/parse`, 307));

    await expect(parseWithDocling(pdf, options(baseUrl))).rejects.toMatchObject({ classification: "transient" });
  });
});
