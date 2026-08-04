import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { ArtifactDescriptor } from "@mf-rag/types";

import type { ArtifactStore, PutArtifactInput } from "../artifacts/artifact-store.ts";
import { WebsitePdfConnector } from "../connectors/website-pdf-connector.ts";
import { DiscoverSourceStage, type DiscoverySourceRepository } from "./discover-source.ts";
import { FetchDocumentStage, type SourceDocumentState } from "./fetch-document.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => servers.splice(0).forEach((server) => server.stop(true)));

describe("DISCOVER/FETCH source execution", () => {
  test("observes unchanged documents and enqueues PARSE only after a verified changed version", async () => {
    const a = pdf("a");
    const b = pdf("same-b");
    const c = pdf("changed-c");
    const server = fixtureServer((url, request) => {
      if (url.pathname === "/a.pdf" && request.headers.get("if-none-match") === '"a-v1"') {
        return new Response(null, { status: 304, headers: { etag: '"a-v1"' } });
      }
      if (url.pathname === "/a.pdf") return pdfResponse(a, '"a-v1"');
      if (url.pathname === "/b.pdf") return pdfResponse(b, '"b-v2"');
      if (url.pathname === "/alias-c.pdf") return Response.redirect(`${origin(server)}/c.pdf`, 302);
      if (url.pathname === "/c.pdf") return pdfResponse(c, '"c-v1"');
      return new Response("missing", { status: 404 });
    });
    const fake = fakeRepository(new Map([
      ["a", state("doc-a", a, '"a-v1"', `${origin(server)}/a.pdf`)],
      ["b", state("doc-b", b, '"b-v1"', `${origin(server)}/b.pdf`)],
    ]));
    const artifactStore = fakeArtifactStore(fake.events);
    const connector = connectorFor(server);
    fake.setDiscovery({ strategy: "explicit_urls", urls: [
      { key: "a" as never, url: `${origin(server)}/a.pdf` },
      { key: "b" as never, url: `${origin(server)}/b.pdf` },
      { key: "c" as never, url: `${origin(server)}/alias-c.pdf` },
    ] });
    const fetchStage = new FetchDocumentStage({
      repository: fake.repository, artifactStore,
      pipelineIdentity: { pipelineImplementationVersion: "pipeline-v1", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
      artifactProducerVersion: "fetch-v1",
    });
    const stage = new DiscoverSourceStage({ repository: fake.repository, connectorFactory: () => connector, fetchStage });

    const result = await stage.execute({
      discoveryRunId: "run-1", sourceId: "source-1", configRevisionId: "revision-1",
      owner: "worker-a", leaseEpoch: 1,
    });

    expect(result).toEqual({ discovered: 3, changed: 1, unchanged: 2 });
    expect(fake.observationBatches).toHaveLength(1);
    expect(fake.observationBatches[0]).toHaveLength(3);
    expect(fake.versions).toHaveLength(1);
    expect(fake.enqueued).toHaveLength(3);
    expect(fake.aliases.map((entry) => entry.url)).toContain(`${origin(server)}/alias-c.pdf`);
    expect(fake.aliases.map((entry) => entry.url)).toContain(`${origin(server)}/c.pdf`);
    expect(fake.events).toEqual(["enqueue", "enqueue", "artifact", "version", "enqueue", "observations"]);
  });

  test("a failed partial discovery records no presence batch and preserves retry classification", async () => {
    const server = fixtureServer((url) => url.pathname === "/good.pdf"
      ? pdfResponse(pdf("good"), '"good"')
      : new Response("<html>bad</html>", { headers: { "content-type": "text/html" } }));
    const fake = fakeRepository();
    fake.setDiscovery({ strategy: "explicit_urls", urls: [
      { key: "good" as never, url: `${origin(server)}/good.pdf` },
      { key: "bad" as never, url: `${origin(server)}/bad.pdf` },
    ] });
    const connector = connectorFor(server);
    const stage = new DiscoverSourceStage({
      repository: fake.repository,
      connectorFactory: () => connector,
      fetchStage: new FetchDocumentStage({
        repository: fake.repository, artifactStore: fakeArtifactStore(fake.events),
        pipelineIdentity: { pipelineImplementationVersion: "pipeline-v1", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
        artifactProducerVersion: "fetch-v1",
      }),
    });
    await expect(stage.execute({
      discoveryRunId: "run-failed", sourceId: "source-1", configRevisionId: "revision-1",
      owner: "worker-a", leaseEpoch: 1,
    })).rejects.toMatchObject({ code: "PAYLOAD_MEDIA_TYPE", classification: "deterministic" });
    expect(fake.observationBatches).toEqual([]);
  });

  test("canonical URL ownership conflict fails closed before version persistence", async () => {
    const server = fixtureServer(() => pdfResponse(pdf("owned"), '"v1"'));
    const fake = fakeRepository();
    fake.setDiscovery({ strategy: "explicit_urls", urls: [{ key: "owned" as never, url: `${origin(server)}/owned.pdf` }] });
    fake.conflictingUrls.add(`${origin(server)}/owned.pdf`);
    const stage = new DiscoverSourceStage({
      repository: fake.repository, connectorFactory: () => connectorFor(server),
      fetchStage: new FetchDocumentStage({
        repository: fake.repository, artifactStore: fakeArtifactStore(fake.events),
        pipelineIdentity: { pipelineImplementationVersion: "pipeline-v1", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
        artifactProducerVersion: "fetch-v1",
      }),
    });
    await expect(stage.execute({
      discoveryRunId: "run-conflict", sourceId: "source-2", configRevisionId: "revision-1",
      owner: "worker-a", leaseEpoch: 1,
    })).rejects.toThrow(/owned by another source/i);
    expect(fake.versions).toEqual([]);
    expect(fake.observationBatches).toEqual([]);
  });

  test("does not send validators from a pinned key's previous canonical URL", async () => {
    let conditionalHeader: string | null = "not-called";
    const bytes = pdf("new-location");
    const server = fixtureServer((_url, request) => {
      conditionalHeader = request.headers.get("if-none-match");
      return pdfResponse(bytes, '"new"');
    });
    const fake = fakeRepository(new Map([["pinned", state(
      "doc-pinned", pdf("old-location"), '"old"', "https://old.example/document.pdf",
    )]]));
    fake.setDiscovery({ strategy: "explicit_urls", urls: [{ key: "pinned" as never, url: `${origin(server)}/new.pdf` }] });
    const connector = connectorFor(server);
    const stage = new DiscoverSourceStage({
      repository: fake.repository, connectorFactory: () => connector,
      fetchStage: new FetchDocumentStage({
        repository: fake.repository, artifactStore: fakeArtifactStore(fake.events),
        pipelineIdentity: { pipelineImplementationVersion: "pipeline-v1", parseImplementationVersion: "parse-v1", maxAttempts: 3 },
        artifactProducerVersion: "fetch-v1",
      }),
    });
    await stage.execute({
      discoveryRunId: "run-url-change", sourceId: "source-1", configRevisionId: "revision-2",
      owner: "worker-a", leaseEpoch: 1,
    });
    expect(conditionalHeader).toBeNull();
    expect(fake.versions).toHaveLength(1);
  });
});

function fakeRepository(initial: Map<string, SourceDocumentState> = new Map()) {
  const states = initial;
  const aliases: Array<{ documentId: string; url: string }> = [];
  const versions: unknown[] = [];
  const enqueued: unknown[] = [];
  const observationBatches: unknown[][] = [];
  const events: string[] = [];
  const conflictingUrls = new Set<string>();
  let discovery: Parameters<WebsitePdfConnector["discover"]>[0] = { strategy: "explicit_urls", urls: [] };
  let nextId = 1;
  const repository: DiscoverySourceRepository = {
    loadExecutionConfig: async () => ({
      accessScopeId: "scope-910", discovery,
      fetch: { allowedHosts: ["127.0.0.1"], allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 500, maxRedirects: 2 },
    }),
    findDocumentState: async ({ logicalDocumentKey }) => states.get(String(logicalDocumentKey)) ?? null,
    findOrCreateDocument: async ({ logicalDocumentKey, canonicalUrl }) => {
      if (conflictingUrls.has(canonicalUrl)) throw new Error("Canonical URL is owned by another source.");
      const existing = states.get(String(logicalDocumentKey));
      if (existing) return existing;
      const created: SourceDocumentState = { sourceDocumentId: `doc-${nextId++}`, canonicalUrl, currentVersionId: null, currentSha256: null, etag: null, lastModified: null };
      states.set(String(logicalDocumentKey), created);
      return created;
    },
    recordAlias: async ({ sourceDocumentId, aliasUrl }) => { aliases.push({ documentId: sourceDocumentId, url: aliasUrl }); },
    recordVersionAndEnsureParse: async (input) => {
      events.push("version"); versions.push(input); events.push("enqueue"); enqueued.push(input);
      return { documentVersionId: `version-${versions.length}`, created: true };
    },
    ensureParse: async (input) => { events.push("enqueue"); enqueued.push(input); },
    recordSuccessfulObservations: async (_fence, observations) => {
      events.push("observations"); observationBatches.push([...observations]);
    },
  };
  return { repository, aliases, versions, enqueued, observationBatches, events, conflictingUrls, setDiscovery(value: typeof discovery) { discovery = value; } };
}

function state(sourceDocumentId: string, bytes: Uint8Array, etag: string, canonicalUrl = "https://canonical.invalid/doc.pdf") {
  return { sourceDocumentId, canonicalUrl, currentVersionId: `version-${sourceDocumentId}`, currentSha256: sha(bytes), etag, lastModified: null };
}
function fakeArtifactStore(events: string[]): ArtifactStore {
  return {
    put: async (input: PutArtifactInput): Promise<ArtifactDescriptor> => {
      events.push("artifact");
      return { key: `raw/${input.sha256}`, uri: `memory://${input.sha256}`, sha256: input.sha256, byteSize: input.byteSize, mediaType: input.mediaType, producerVersion: input.producerVersion };
    },
    read: async () => new Uint8Array(), verify: async (descriptor) => descriptor, listOrphans: async () => [],
  };
}
function fixtureServer(handler: (url: URL, request: Request) => Response | Promise<Response>) { const server = Bun.serve({ port: 0, fetch: (request) => handler(new URL(request.url), request) }); servers.push(server); return server; }
function connectorFor(server: ReturnType<typeof Bun.serve>) { return new WebsitePdfConnector({ allowedHosts: ["127.0.0.1"], allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 500, maxRedirects: 2, allowPrivateAddresses: true }); }
function origin(server: ReturnType<typeof Bun.serve>) { return `http://127.0.0.1:${server.port}`; }
function pdf(value: string) { return new TextEncoder().encode(`%PDF-1.7\n${value}`); }
function pdfResponse(bytes: Uint8Array, etag: string) { return new Response(bytes, { headers: { "content-type": "application/pdf", etag } }); }
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
