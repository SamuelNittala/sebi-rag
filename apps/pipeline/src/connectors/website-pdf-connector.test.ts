import { afterEach, describe, expect, test } from "bun:test";

import {
  SourceConnectorError,
  WebsitePdfConnector,
  normalizeDocumentUrl,
} from "./website-pdf-connector.ts";
import { createLogicalDocumentKey } from "@mf-rag/types";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)));

describe("WebsitePdfConnector", () => {
  test("discovers pinned explicit URLs and path-keyed sitemap/crawl PDFs", async () => {
    const server = fixtureServer((url) => {
      if (url.pathname === "/sitemap.xml") return response(`<urlset><url><loc>${origin(server)}/docs/a.pdf?utm=x</loc></url><url><loc>${origin(server)}/private/no.pdf</loc></url></urlset>`, "application/xml");
      if (url.pathname === "/listing") return response(`<a href="/docs/a.pdf?utm=x">A</a><a href="/next">next</a>`);
      if (url.pathname === "/next") return response(`<a href="/docs/b.pdf?version=2&utm=x">B</a>`);
      return new Response("not found", { status: 404 });
    });
    const connector = connectorFor(server);

    const explicit = await connector.discover({ strategy: "explicit_urls", urls: [
      { key: createLogicalDocumentKey("pinned-a"), url: `${origin(server)}/docs/a.pdf` },
      { key: createLogicalDocumentKey("pinned-b"), url: `${origin(server)}/docs/b.pdf` },
    ]});
    expect(explicit.map((item) => String(item.logicalDocumentKey))).toEqual(["pinned-a", "pinned-b"]);

    const sitemap = await connector.discover({
      strategy: "sitemap",
      sitemapUrls: [`${origin(server)}/sitemap.xml`],
      includePathPrefixes: ["/docs/"],
      maxDocuments: 10,
      identity: { strategy: "normalized_path", queryParameters: [] },
    });
    expect(sitemap.map((item) => String(item.logicalDocumentKey))).toEqual(["path:/docs/a.pdf"]);
    expect(sitemap[0]?.url).toBe(`${origin(server)}/docs/a.pdf`);

    const crawl = await connector.discover({
      strategy: "constrained_crawl",
      startUrls: [`${origin(server)}/listing`],
      allowedPathPrefixes: ["/listing", "/next", "/docs/"],
      maxDepth: 2,
      maxPages: 3,
      maxDocuments: 10,
      identity: { strategy: "normalized_path", queryParameters: ["version"] },
    });
    expect(crawl.map((item) => String(item.logicalDocumentKey))).toEqual([
      "path:/docs/a.pdf",
      expect.stringMatching(/^path:\/docs\/b\.pdf:q-/),
    ]);
  });

  test("normalizes URL query ordering and removes fragments", () => {
    expect(normalizeDocumentUrl("https://EXAMPLE.com:443/a.pdf?z=2&a=1#page=2"))
      .toBe("https://example.com/a.pdf?a=1&z=2");
    expect(() => normalizeDocumentUrl("https://example.com/a.pdf?X-Amz-Signature=secret"))
      .toThrow(/secret-bearing query/i);
  });

  test("uses validators, follows allowed redirects, streams and validates PDF bytes", async () => {
    const seenHeaders: Headers[] = [];
    const pdf = new TextEncoder().encode("%PDF-1.7\nfixture");
    const server = fixtureServer((url, request) => {
      if (url.pathname === "/alias.pdf") return Response.redirect(`${origin(server)}/docs/final.pdf`, 302);
      if (url.pathname === "/docs/final.pdf") {
        seenHeaders.push(request.headers);
        if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
        return new Response(pdf, { headers: { "content-type": "application/pdf; charset=binary", etag: '"v1"', "last-modified": "Tue, 04 Aug 2026 00:00:00 GMT" } });
      }
      return new Response("not found", { status: 404 });
    });
    const connector = connectorFor(server);

    const fetched = await connector.fetch(`${origin(server)}/alias.pdf`);
    expect(fetched.kind).toBe("fetched");
    if (fetched.kind !== "fetched") throw new Error("expected bytes");
    expect(new TextDecoder().decode(fetched.bytes)).toStartWith("%PDF-");
    expect(fetched.aliases).toEqual([`${origin(server)}/alias.pdf`, `${origin(server)}/docs/final.pdf`]);
    expect(fetched.etag).toBe('"v1"');

    const unchanged = await connector.fetch(`${origin(server)}/alias.pdf`, { etag: '"v1"' });
    expect(unchanged).toMatchObject({ kind: "not_modified", etag: '"v1"' });
    expect(seenHeaders.at(-1)?.get("if-none-match")).toBe('"v1"');
  });

  test.each([
    ["HTML masquerading as PDF", "/html.pdf", "PAYLOAD_MEDIA_TYPE", "deterministic"],
    ["invalid PDF signature", "/invalid.pdf", "PAYLOAD_SIGNATURE", "deterministic"],
    ["oversized streaming response", "/large.pdf", "PAYLOAD_TOO_LARGE", "deterministic"],
    ["server error", "/server.pdf", "HTTP_503", "transient"],
    ["timeout", "/slow.pdf", "FETCH_TIMEOUT", "transient"],
  ])("classifies %s", async (_name, path, code, classification) => {
    const server = fixtureServer(async (url) => {
      if (url.pathname === "/html.pdf") return response("<html>oops</html>", "text/html");
      if (url.pathname === "/invalid.pdf") return response("not-a-pdf", "application/pdf");
      if (url.pathname === "/large.pdf") return response(`%PDF-${"x".repeat(128)}`, "application/pdf");
      if (url.pathname === "/server.pdf") return new Response("later", { status: 503 });
      if (url.pathname === "/slow.pdf") { await Bun.sleep(100); return response("%PDF-late", "application/pdf"); }
      return new Response("not found", { status: 404 });
    });
    const connector = connectorFor(server, { maxBytes: 32, timeoutMs: 20 });
    await expect(connector.fetch(`${origin(server)}${path}`)).rejects.toMatchObject({ code, classification });
  });

  test("fails closed on disallowed initial paths and cross-host redirects", async () => {
    const server = fixtureServer((url) => url.pathname === "/docs/redirect.pdf"
      ? Response.redirect(`http://localhost:${server.port}/docs/final.pdf`, 302)
      : response("%PDF-ok", "application/pdf"));
    const connector = connectorFor(server);
    await expect(connector.fetch(`${origin(server)}/private/a.pdf`)).rejects.toBeInstanceOf(SourceConnectorError);
    await expect(connector.fetch(`${origin(server)}/docs/redirect.pdf`)).rejects.toMatchObject({
      code: "URL_HOST_NOT_ALLOWED",
      classification: "deterministic",
    });
  });

  test("keeps the timeout active while streaming the response body", async () => {
    const server = fixtureServer(() => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-"));
        await Bun.sleep(100);
        controller.enqueue(new TextEncoder().encode("late"));
        controller.close();
      },
    }), { headers: { "content-type": "application/pdf" } }));
    const connector = connectorFor(server, { timeoutMs: 20 });
    await expect(connector.fetch(`${origin(server)}/docs/stream.pdf`)).rejects.toMatchObject({
      code: "FETCH_TIMEOUT", classification: "transient",
    });
  });

  test("enforces segment path boundaries and blocks private DNS by default", async () => {
    const server = fixtureServer(() => response("%PDF-ok", "application/pdf"));
    const strictPath = new WebsitePdfConnector({
      allowedHosts: ["127.0.0.1"], allowedPathPrefixes: ["/docs"],
      maxBytes: 1024, timeoutMs: 500, maxRedirects: 1,
      allowPrivateAddresses: true,
    });
    await expect(strictPath.fetch(`${origin(server)}/docs-evil/a.pdf`)).rejects.toMatchObject({ code: "URL_PATH_NOT_ALLOWED" });

    const productionDefault = new WebsitePdfConnector({
      allowedHosts: ["fixture.example"], allowedPathPrefixes: ["/docs"],
      maxBytes: 1024, timeoutMs: 500, maxRedirects: 1,
      resolveHost: async () => ["127.0.0.1"],
      fetch: async () => response("%PDF-never", "application/pdf"),
    });
    try {
      await productionDefault.fetch("https://fixture.example/docs/a.pdf");
      throw new Error("expected private DNS resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceConnectorError);
      expect((error as SourceConnectorError).code).toBe("URL_PRIVATE_ADDRESS_FORBIDDEN");
      expect((error as SourceConnectorError).classification).toBe("deterministic");
    }
  });

  test("keeps crawl on its start host and rejects a cross-host redirect before leaking validators", async () => {
    const requested: Array<{ url: string; headers: Headers }> = [];
    const connector = new WebsitePdfConnector({
      allowedHosts: ["origin.example", "cdn.example"],
      allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 500, maxRedirects: 2,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async (input, init) => {
        const url = String(input);
        requested.push({ url, headers: new Headers(init?.headers) });
        if (url === "https://origin.example/listing") return response('<a href="https://cdn.example/foreign.pdf">foreign</a>');
        if (url === "https://origin.example/alias.pdf") return Response.redirect("https://cdn.example/final.pdf", 302);
        return response("%PDF-ok", "application/pdf");
      },
    });
    const discovered = await connector.discover({
      strategy: "constrained_crawl", startUrls: ["https://origin.example/listing"],
      allowedPathPrefixes: ["/"], maxDepth: 1, maxPages: 2, maxDocuments: 2,
      identity: { strategy: "normalized_path", queryParameters: [] },
    });
    expect(discovered).toEqual([]);

    await expect(connector.fetch("https://origin.example/alias.pdf", { etag: '"private-validator"' }))
      .rejects.toMatchObject({ code: "CROSS_HOST_REDIRECT", classification: "deterministic" });
    expect(requested.some((entry) => entry.url === "https://cdn.example/final.pdf")).toBe(false);
  });
});

function fixtureServer(handler: (url: URL, request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: (request) => handler(new URL(request.url), request) });
  servers.push(server);
  return server;
}

function origin(server: ReturnType<typeof Bun.serve>): string { return `http://127.0.0.1:${server.port}`; }
function response(body: string | Uint8Array, contentType = "text/html") { return new Response(body, { headers: { "content-type": contentType } }); }
function connectorFor(server: ReturnType<typeof Bun.serve>, overrides: { maxBytes?: number; timeoutMs?: number } = {}) {
  return new WebsitePdfConnector({
    allowedHosts: ["127.0.0.1"],
    allowedPathPrefixes: [
      "/docs/", "/listing", "/next", "/sitemap.xml", "/alias.pdf",
      "/html.pdf", "/invalid.pdf", "/large.pdf", "/server.pdf", "/slow.pdf",
    ],
    maxBytes: overrides.maxBytes ?? 1024,
    timeoutMs: overrides.timeoutMs ?? 500,
    maxRedirects: 2,
    allowPrivateAddresses: true,
  });
}
