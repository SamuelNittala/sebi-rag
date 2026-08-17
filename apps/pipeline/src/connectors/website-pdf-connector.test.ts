import { afterEach, describe, expect, test } from "bun:test";

import {
  SourceConnectorError,
  WebsitePdfConnector,
  normalizeDocumentUrl,
} from "./website-pdf-connector.ts";
import { createLogicalDocumentKey, type SourceDiscoveryConfig } from "@mf-rag/types";

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

  test("discovers every PDF in a paginated Mirae MF download catalogue", async () => {
    const requests: unknown[] = [];
    const connector = new WebsitePdfConnector({
      allowedHosts: ["catalog.example"],
      allowedPathPrefixes: ["/AjaxService/GetDownloadsData", "/docs/"],
      maxBytes: 1024 * 1024,
      timeoutMs: 500,
      maxRedirects: 1,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async (input, init) => {
        expect(init?.method).toBe("POST");
        requests.push(JSON.parse(String(init?.body)));
        const page = (requests.at(-1) as { request: { pgno: number } }).request.pgno;
        return Response.json({
          ReturnCode: "0",
          DataCount: 3,
          Data: page === 1
            ? [
                { Id: "doc-a", URL: "/docs/a.pdf" },
                { Id: "sheet", URL: "/docs/ignored.xls" },
              ]
            : [{ Id: "doc-b", URL: "/docs/b.pdf?sfvrsn=2" }],
        });
      },
    });

    await expect(connector.discover({
      strategy: "mirae_mf_download_catalog",
      catalogUrl: "https://catalog.example/AjaxService/GetDownloadsData",
      moduleName: "Factsheet",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      pageSize: 2,
      maxPages: 3,
      maxDocuments: 5,
      minimumDocuments: 2,
    })).resolves.toEqual([
      { logicalDocumentKey: createLogicalDocumentKey("catalog:doc-a"), url: "https://catalog.example/docs/a.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:doc-b"), url: "https://catalog.example/docs/b.pdf?sfvrsn=2" },
    ]);
    expect(requests).toEqual([
      { request: { modulename: "Factsheet", title: "", fromdate: "2026-01-01", todate: "2026-12-31", pgno: 1, pgsize: 2 } },
      { request: { modulename: "Factsheet", title: "", fromdate: "2026-01-01", todate: "2026-12-31", pgno: 2, pgsize: 2 } },
    ]);
  });

  test("fails closed when the Mirae MF catalogue shrinks below its baseline", async () => {
    const connector = new WebsitePdfConnector({
      allowedHosts: ["catalog.example"],
      allowedPathPrefixes: ["/"],
      maxBytes: 1024,
      timeoutMs: 500,
      maxRedirects: 1,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async () => Response.json({ ReturnCode: "0", DataCount: 1, Data: [
        { Id: "doc-a", URL: "/docs/a.pdf" },
      ] }),
    });
    await expect(connector.discover({
      strategy: "mirae_mf_download_catalog",
      catalogUrl: "https://catalog.example/AjaxService/GetDownloadsData",
      moduleName: "Addendum",
      pageSize: 100,
      maxPages: 2,
      maxDocuments: 10,
      minimumDocuments: 2,
    })).rejects.toMatchObject({ code: "CATALOG_DOCUMENT_MINIMUM", classification: "deterministic" });
  });

  test("watches every Mirae SIF catalogue section, subsection, and page", async () => {
    const requestedEndpoints: string[] = [];
    const connector = new WebsitePdfConnector({
      allowedHosts: ["catalog.example", "cdn.example"],
      allowedPathPrefixes: ["/"],
      maxBytes: 1024 * 1024,
      timeoutMs: 500,
      maxRedirects: 2,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/forms-downloads/forms") {
          return response(REPRESENTATIVE_CATALOG_PAGE);
        }
        if (url.pathname !== "/api/sif-dynamic-get") return new Response("not found", { status: 404 });

        const endpoint = url.searchParams.get("endpoint") ?? "";
        requestedEndpoints.push(endpoint);
        const endpointUrl = new URL(endpoint, "https://catalog.example/");
        const page = Number(endpointUrl.searchParams.get("pageNo") ?? endpointUrl.searchParams.get("page") ?? "1");
        const main = endpointUrl.searchParams.get("mainLink");
        const side = endpointUrl.searchParams.get("sideLink");

        if (main === "forms" && side === "isid") {
          return Response.json({ children: [{
            title: "ISID", totalPages: 2, forms: page === 1
              ? [{ id: 101, label: "Current ISID", link: "https://cdn.example/docs/isid.pdf", date: "2026-06-10" }]
              : [
                  { id: 102, label: "Prior ISID", link: "https://cdn.example/docs/isid-prior.pdf", date: "2026-05-01" },
                  { id: 999, label: "Unsupported sheet", link: "https://cdn.example/docs/data.xlsx", date: "2026-05-01" },
                ],
          }] });
        }
        if (main === "product-literature" && side === "factsheet") {
          return Response.json([
            { children: [{ title: "Factsheet", totalPages: 1, forms: [
              { id: 201, label: "Factsheet", link: "https://cdn.example/docs/factsheet.pdf", date: "2026-07-01" },
            ] }] },
            { children: [{ title: "Presentation", totalPages: 1, forms: [
              { id: 202, label: "Presentation", link: "https://cdn.example/docs/presentation.pdf", date: "2026-07-02" },
            ] }] },
          ]);
        }
        if (main === "regulatory" && side === "policies") {
          return Response.json({ children: [{ title: "Policies", totalPages: 1, forms: [
            { id: 301, label: "Policy", link: "https://cdn.example/docs/policy.pdf", date: "2026-04-01" },
          ] }] });
        }
        if (endpointUrl.pathname === "/ter") {
          return Response.json({ title: "Total Expense Ratio", totalPages: 1, forms: [
            { id: 401, label: "TER", link: "https://cdn.example/docs/ter.pdf", date: "2026-07-31" },
          ] });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const discovered = await connector.discover({
      strategy: "mirae_sif_download_catalog",
      catalogUrl: "https://catalog.example/forms-downloads/forms",
      sections: "all",
      additionalTargets: [{ section: "regulatory", subsection: "total-expense-ratio", endpoint: "ter" }],
      pageSize: 2,
      maxPages: 10,
      maxDocuments: 20,
      minimumDocuments: 1,
    });

    expect(discovered).toEqual([
      { logicalDocumentKey: createLogicalDocumentKey("catalog:101"), url: "https://cdn.example/docs/isid.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:102"), url: "https://cdn.example/docs/isid-prior.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:201"), url: "https://cdn.example/docs/factsheet.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:202"), url: "https://cdn.example/docs/presentation.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:301"), url: "https://cdn.example/docs/policy.pdf" },
      { logicalDocumentKey: createLogicalDocumentKey("catalog:401"), url: "https://cdn.example/docs/ter.pdf" },
    ]);
    expect(requestedEndpoints).toEqual(expect.arrayContaining([
      "download-forms-sub?mainLink=forms&sideLink=isid&pageNo=1&NoOfRows=2",
      "download-forms-sub?mainLink=forms&sideLink=isid&pageNo=2&NoOfRows=2",
      "download-forms-sub?mainLink=product-literature&sideLink=factsheet&pageNo=1&NoOfRows=2",
      "download-forms-sub?mainLink=regulatory&sideLink=policies&pageNo=1&NoOfRows=2",
      "ter?page=1&rows=2",
    ]));
  });

  test("fails closed when the Mirae SIF catalogue cannot provide a complete inventory", async () => {
    const connector = new WebsitePdfConnector({
      allowedHosts: ["catalog.example"],
      allowedPathPrefixes: ["/"],
      maxBytes: 1024,
      timeoutMs: 500,
      maxRedirects: 1,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async () => response("<html>catalog structure changed</html>"),
    });

    await expect(connector.discover({
      strategy: "mirae_sif_download_catalog",
      catalogUrl: "https://catalog.example/forms-downloads/forms",
      sections: "all",
      additionalTargets: [],
      pageSize: 100,
      maxPages: 500,
      maxDocuments: 5_000,
      minimumDocuments: 1,
    })).rejects.toMatchObject({
      code: "CATALOG_SECTIONS_MISSING",
      classification: "deterministic",
    });
  });

  test("limits the Mirae SIF watcher to catalogue, proxy API, and upload paths", async () => {
    const connector = new WebsitePdfConnector({
      allowedHosts: ["catalog.example", "cdn.example"],
      allowedPathPrefixes: [
        "/forms-downloads/forms",
        "/api/sif-dynamic-get",
        "/wp-content/uploads/",
      ],
      maxBytes: 1024 * 1024,
      timeoutMs: 500,
      maxRedirects: 1,
      resolveHost: async () => ["8.8.8.8"],
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/forms-downloads/forms") {
          return response(catalogPage([{
            title: "Forms",
            slug: "forms",
            sideLinks: [{ title: "ISID", slug: "isid" }],
          }]));
        }
        if (url.pathname === "/api/sif-dynamic-get") {
          return Response.json({ children: [{
            totalPages: 1,
            forms: [{ id: 910, link: "https://cdn.example/wp-content/uploads/isid.pdf" }],
          }] });
        }
        if (url.pathname === "/wp-content/uploads/isid.pdf") {
          return response("%PDF-watcher", "application/pdf");
        }
        return new Response("not found", { status: 404 });
      },
    });

    const discovered = await connector.discover(catalogDiscovery());
    expect(discovered).toEqual([{
      logicalDocumentKey: createLogicalDocumentKey("catalog:910"),
      url: "https://cdn.example/wp-content/uploads/isid.pdf",
    }]);
    await expect(connector.fetch(discovered[0]!.url)).resolves.toMatchObject({ kind: "fetched" });
    await expect(connector.fetch("https://cdn.example/unrelated/document.pdf")).rejects.toMatchObject({
      code: "URL_PATH_NOT_ALLOWED",
      classification: "deterministic",
    });
  });

  test("enforces catalogue page, document, and reviewed-minimum safety limits", async () => {
    const section = [{ title: "Forms", slug: "forms", sideLinks: [{ title: "ISID", slug: "isid" }] }];
    const pageLimited = catalogFixtureConnector(section, () => ({ children: [{
      totalPages: 2,
      forms: [{ id: 1, link: "https://cdn.example/docs/one.pdf" }],
    }] }));
    await expect(pageLimited.discover(catalogDiscovery({ maxPages: 1 }))).rejects.toMatchObject({
      code: "CATALOG_PAGE_LIMIT",
      classification: "deterministic",
    });

    const documentLimited = catalogFixtureConnector(section, () => ({ children: [{
      totalPages: 1,
      forms: [
        { id: 1, link: "https://cdn.example/docs/one.pdf" },
        { id: 2, link: "https://cdn.example/docs/two.pdf" },
      ],
    }] }));
    await expect(documentLimited.discover(catalogDiscovery({ maxDocuments: 1 }))).rejects.toMatchObject({
      code: "CATALOG_DOCUMENT_LIMIT",
      classification: "deterministic",
    });

    const belowMinimum = catalogFixtureConnector(section, () => ({ children: [{
      totalPages: 1,
      forms: [],
    }] }));
    await expect(belowMinimum.discover(catalogDiscovery({ minimumDocuments: 1 }))).rejects.toMatchObject({
      code: "CATALOG_DOCUMENT_MINIMUM",
      classification: "deterministic",
    });
  });

  test("keeps provider identity stable across navigation moves and rejects ID reuse", async () => {
    const sections = [{ title: "Forms", slug: "forms", sideLinks: [
      { title: "Current", slug: "current" },
      { title: "Archive", slug: "archive" },
    ] }];
    const stable = catalogFixtureConnector(sections, () => ({ children: [{
      totalPages: 1,
      forms: [{ id: 777, link: "https://cdn.example/docs/stable.pdf" }],
    }] }));
    await expect(stable.discover(catalogDiscovery())).resolves.toEqual([{
      logicalDocumentKey: createLogicalDocumentKey("catalog:777"),
      url: "https://cdn.example/docs/stable.pdf",
    }]);

    const conflicting = catalogFixtureConnector(sections, (endpointUrl) => ({ children: [{
      totalPages: 1,
      forms: [{
        id: 777,
        link: endpointUrl.searchParams.get("sideLink") === "current"
          ? "https://cdn.example/docs/current.pdf"
          : "https://cdn.example/docs/archive.pdf",
      }],
    }] }));
    await expect(conflicting.discover(catalogDiscovery())).rejects.toMatchObject({
      code: "CATALOG_ID_CONFLICT",
      classification: "deterministic",
    });
  });

  test("queries manifest-owned additional targets only under advertised parent sections", async () => {
    const sections = [{ title: "Regulatory", slug: "regulatory", sideLinks: [] }];
    const endpoints: string[] = [];
    const connector = catalogFixtureConnector(sections, (endpointUrl) => {
      endpoints.push(`${endpointUrl.pathname}${endpointUrl.search}`);
      return { totalPages: 1, forms: [{ id: 2, link: "https://cdn.example/docs/ter.pdf" }] };
    });
    const discovered = await connector.discover(catalogDiscovery({
      additionalTargets: [{ section: "regulatory", subsection: "total-expense-ratio", endpoint: "ter" }],
    }));
    expect(discovered.map(({ logicalDocumentKey }) => String(logicalDocumentKey))).toEqual(["catalog:2"]);
    expect(endpoints).toContain("/ter?page=1&rows=100");

    let apiRequests = 0;
    const missingParent = catalogFixtureConnector(
      [{ title: "Forms", slug: "forms", sideLinks: [{ title: "ISID", slug: "isid" }] }],
      () => { apiRequests += 1; return { children: [] }; },
    );
    await expect(missingParent.discover(catalogDiscovery({
      additionalTargets: [{ section: "regulatory", subsection: "total-expense-ratio", endpoint: "ter" }],
    }))).rejects.toMatchObject({
      code: "CATALOG_ADDITIONAL_TARGET_PARENT_MISSING",
      classification: "deterministic",
    });
    expect(apiRequests).toBe(0);
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

  test("bounds a never-settling DNS resolver by timeout and caller cancellation", async () => {
    const connector = (timeoutMs: number) => new WebsitePdfConnector({
      allowedHosts: ["fixture.example"],
      allowedPathPrefixes: ["/docs"],
      maxBytes: 1024,
      timeoutMs,
      maxRedirects: 1,
      resolveHost: () => new Promise<readonly string[]>(() => {}),
      fetch: async () => response("%PDF-never", "application/pdf"),
    });
    const failIfStillPending = async () => {
      await Bun.sleep(200);
      throw new Error("DNS resolution was not bounded by the request abort signal.");
    };

    await expect(Promise.race([
      connector(20).fetch("https://fixture.example/docs/a.pdf"),
      failIfStillPending(),
    ])).rejects.toMatchObject({ code: "FETCH_TIMEOUT", classification: "transient" });

    const controller = new AbortController();
    const cancelled = connector(500).fetch(
      "https://fixture.example/docs/a.pdf",
      {},
      controller.signal,
    );
    controller.abort();
    await expect(Promise.race([cancelled, failIfStillPending()])).rejects.toMatchObject({
      code: "FETCH_CANCELLED",
      classification: "transient",
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
function catalogPage(mainLinks: unknown): string {
  return `<script type="application/json">{"mainLinksData":${JSON.stringify({ mainLinks })}}</script>`;
}
const REPRESENTATIVE_CATALOG_PAGE = String.raw`<script>self.__next_f.push([1,"initialData\":{\"mainLinksData\":{\"mainLinks\":[{\"title\":\"Forms\",\"slug\":\"forms\",\"sideLinks\":[{\"title\":\"ISID\",\"slug\":\"isid\"}]},{\"title\":\"Product Literature\",\"slug\":\"product-literature\",\"sideLinks\":[{\"title\":\"Factsheet\",\"slug\":\"factsheet\"}]},{\"title\":\"Regulatory\",\"slug\":\"regulatory\",\"sideLinks\":[{\"title\":\"Policies\",\"slug\":\"policies\"}]}]},\"initialSlug\":[\"forms\"]}"])</script>`;

function catalogDiscovery(
  overrides: Partial<Extract<SourceDiscoveryConfig, { strategy: "mirae_sif_download_catalog" }>> = {},
): Extract<SourceDiscoveryConfig, { strategy: "mirae_sif_download_catalog" }> {
  return {
    strategy: "mirae_sif_download_catalog",
    catalogUrl: "https://catalog.example/forms-downloads/forms",
    sections: "all",
    additionalTargets: [],
    pageSize: 100,
    maxPages: 20,
    maxDocuments: 100,
    minimumDocuments: 1,
    ...overrides,
  };
}

function catalogFixtureConnector(
  mainLinks: unknown,
  payload: (endpointUrl: URL) => unknown,
): WebsitePdfConnector {
  return new WebsitePdfConnector({
    allowedHosts: ["catalog.example", "cdn.example"],
    allowedPathPrefixes: ["/"],
    maxBytes: 1024 * 1024,
    timeoutMs: 500,
    maxRedirects: 2,
    resolveHost: async () => ["8.8.8.8"],
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/forms-downloads/forms") return response(catalogPage(mainLinks));
      if (url.pathname !== "/api/sif-dynamic-get") return new Response("not found", { status: 404 });
      const endpoint = new URL(url.searchParams.get("endpoint") ?? "", "https://catalog.example/");
      return Response.json(payload(endpoint));
    },
  });
}
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
