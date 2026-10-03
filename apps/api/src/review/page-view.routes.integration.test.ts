import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/bun-sql";
import { eq, inArray } from "drizzle-orm";
import {
  createAccessScopeKey,
  createExternalAccessCode,
  createLogicalDocumentKey,
  createSourceKey,
  type ArtifactDescriptor,
  type DesiredSourceRegistry,
} from "@mf-rag/types";
import type { Database } from "@mf-rag/db/client";
import { stageInspectionReview, type StageInspectionReviewInput } from "@mf-rag/db/review-queries";

import * as schema from "../../../../packages/db/src/schema.ts";
import { mapDoclingChunks } from "../../../ingestion/src/chunkers/docling-chunk-mapper.ts";
import { parsedPdfMediaType } from "../../../ingestion/src/stages/parse-pdf-stage.ts";
import { encodeArtifactOutputRef } from "../../../pipeline/src/stages/parse-document.ts";
import { PDFJS_VERSION } from "./page-view/assets.ts";
import { ReviewSourceArtifacts } from "./page-view/source-artifacts.ts";
import {
  createStoredDoclingFixture,
  removeFixtureRoot,
  type StoredDoclingFixture,
} from "./page-view/test-fixtures.ts";
import { createReviewApp } from "./routes.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = testDatabaseUrl ? describe : describe.skip;

const GOLDEN = "mirae-flexi-cap-p34-35";

integrationDescribe("review page view routes", () => {
  const client = new SQL(testDatabaseUrl!);
  const db = drizzle({ client, schema }) as unknown as Database;
  const authorization = `Basic ${btoa("reviewer:secret")}`;
  const suffix = crypto.randomUUID().slice(0, 8);
  const externalCode = `6${Date.now()}`;
  const ids = {
    revision: "", scope: "", source: "", sourceDocument: "", legacyDocument: "", artifact: "", version: "",
    pipelineRuns: [] as string[],
  };
  const runs = { docling: "", legacy: "", unpdf: "", corrupt: "", missingParse: "" };
  let fixture: StoredDoclingFixture;
  let sourceArtifacts: ReviewSourceArtifacts;
  let app: ReturnType<typeof createReviewApp>;
  let appWithoutStore: ReturnType<typeof createReviewApp>;
  /** Candidate chunk index carrying the only open finding (on page 2). */
  let flaggedChunkIndex = -1;

  const get = (path: string, init: { app?: typeof app; headers?: Record<string, string> } = {}) =>
    (init.app ?? app).request(path, { headers: { authorization, ...init.headers } });

  async function insertPipelineRun(implementationVersion: string): Promise<string> {
    const [run] = await db.insert(schema.pipelineRuns).values({
      documentVersionId: ids.version,
      accessScopeId: ids.scope,
      sourceId: ids.source,
      implementationVersion,
      configRevisionId: ids.revision,
      initialStage: "PARSE",
      initialStageImplementationVersion: "parse-test",
      initialInputChecksum: fixture.rawArtifact.sha256,
      initialMaxAttempts: 3,
    }).returning();
    ids.pipelineRuns.push(run!.id);
    return run!.id;
  }

  async function insertParseAttempt(pipelineRunId: string, descriptor: ArtifactDescriptor | null): Promise<void> {
    await db.insert(schema.stageAttempts).values({
      pipelineRunId,
      documentVersionId: ids.version,
      accessScopeId: ids.scope,
      sourceId: ids.source,
      stage: "PARSE",
      // Distinct per pipeline run: one success per (version, stage, implementation, input) is allowed.
      implementationVersion: `parse-test-${pipelineRunId}`,
      inputChecksum: fixture.rawArtifact.sha256,
      outputRef: descriptor ? encodeArtifactOutputRef(descriptor) : null,
      outputChecksum: descriptor?.sha256 ?? null,
      status: descriptor ? "succeeded" : "failed",
      completedAt: new Date(),
    });
  }

  function scheduledReview(
    pipelineRunId: string,
    parserVersion: string,
    findings: StageInspectionReviewInput["report"]["findings"] = [],
  ): StageInspectionReviewInput {
    const candidates = mapDoclingChunks(fixture.parsed).chunkResult.chunks.map((chunk) => ({
      id: crypto.randomUUID(),
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      pageNumbers: chunk.pageNumbers,
      tokenCount: chunk.tokenCount,
      hasTable: chunk.hasTable,
      sectionHeader: chunk.sectionHeader,
      metadata: { documentScope: "strategy" as const, ...chunk.metadata },
      contentHash: createHash("sha256").update(`${pipelineRunId}-${chunk.text}`).digest("hex"),
    }));
    const resolvedFindings = findings.map((finding) => ({
      ...finding,
      candidateId: candidates.find((candidate) => candidate.chunkIndex === finding.chunkIndex)!.id,
    }));
    return {
      sourceType: "pdf",
      sourceDocumentId: ids.sourceDocument,
      documentVersionId: ids.version,
      pipelineRunId,
      configRevisionId: ids.revision,
      sourceName: `${GOLDEN}.pdf`,
      sourceLocation: `https://example.com/factsheets/${GOLDEN}.pdf`,
      fileHash: fixture.rawArtifact.sha256,
      parserVersion,
      chunkerVersion: "docling-hybrid-v1",
      ownership: {
        visibilityScope: "TENANT",
        tenantId: externalCode,
        ownershipManifestId: `source-registry:${ids.revision}`,
        ownershipManifestVersion: 1,
      },
      report: {
        inspectorVersion: "1.0.0",
        candidateChunkCount: candidates.length,
        inspectedChunkCount: candidates.length,
        criticalCount: resolvedFindings.filter((finding) => finding.severity === "critical").length,
        warningCount: resolvedFindings.filter((finding) => finding.severity === "warning").length,
        blockingCount: resolvedFindings.filter((finding) => finding.blocksApproval).length,
        findings: resolvedFindings,
      },
      candidates,
    };
  }

  beforeAll(async () => {
    const accessScopeKey = createAccessScopeKey(`pv-${suffix}`);
    const sourceKey = createSourceKey(`pv-site-${suffix}`);
    const desiredState: DesiredSourceRegistry = {
      version: 1,
      accessScopes: [{
        apiVersion: "mf-rag/v1",
        accessScopeKey,
        externalCode: createExternalAccessCode(externalCode),
        classification: { knowledgeDomain: "mutual_fund", sourceCollection: "mirae_mf", amcSlug: "mirae-asset" },
        sources: [{
          sourceKey,
          connector: "website_pdf",
          enabled: false,
          discovery: { strategy: "explicit_urls", urls: [] },
          schedule: { enabled: false, cron: "0 3 * * *", timezone: "Asia/Kolkata" },
          fetch: { allowedHosts: ["example.com"], allowedPathPrefixes: ["/"], maxBytes: 1024, timeoutMs: 1000, maxRedirects: 1 },
          review: { policy: "risk_based" },
        }],
      }],
    };
    const [revision] = await db.insert(schema.sourceRegistryRevisions).values({
      checksum: createHash("sha256").update(`pv-${suffix}`).digest("hex"),
      desiredState,
    }).returning();
    ids.revision = revision!.id;
    const [scope] = await db.insert(schema.accessScopes).values({
      accessScopeKey,
      externalCode,
      tenantId: externalCode,
      knowledgeDomain: "mutual_fund",
      sourceCollection: "mirae_mf",
      amcSlug: "mirae-asset",
      enabled: false,
      configRevisionId: ids.revision,
    }).returning();
    ids.scope = scope!.id;
    const [source] = await db.insert(schema.sources).values({
      accessScopeId: ids.scope,
      sourceKey,
      connector: "website_pdf",
      discoveryConfig: desiredState.accessScopes[0]!.sources[0]!.discovery,
      fetchConfig: desiredState.accessScopes[0]!.sources[0]!.fetch,
      reviewConfig: desiredState.accessScopes[0]!.sources[0]!.review,
      enabled: false,
      configRevisionId: ids.revision,
    }).returning();
    ids.source = source!.id;
    const [document] = await db.insert(schema.sourceDocuments).values({
      accessScopeId: ids.scope,
      sourceId: ids.source,
      logicalDocumentKey: createLogicalDocumentKey(`pv-document-${suffix}`),
      canonicalUrl: `https://example.com/factsheets/${GOLDEN}-${suffix}.pdf`,
    }).returning();
    ids.sourceDocument = document!.id;

    // Real stored artifacts: the golden PDF as raw artifact and the DoclingParseStage output for it.
    ids.version = crypto.randomUUID();
    fixture = await createStoredDoclingFixture(GOLDEN, { documentVersionId: ids.version });
    const [artifact] = await db.insert(schema.artifacts).values({
      artifactKey: fixture.rawArtifact.key,
      uri: fixture.rawArtifact.uri,
      sha256: fixture.rawArtifact.sha256,
      byteSize: fixture.rawArtifact.byteSize,
      mediaType: fixture.rawArtifact.mediaType,
      producerVersion: fixture.rawArtifact.producerVersion,
      verifiedAt: new Date(),
    }).returning();
    ids.artifact = artifact!.id;
    await db.insert(schema.documentVersions).values({
      id: ids.version,
      sourceDocumentId: ids.sourceDocument,
      accessScopeId: ids.scope,
      sourceId: ids.source,
      sequence: 1,
      contentSha256: fixture.rawArtifact.sha256,
      rawArtifactId: ids.artifact,
      configRevisionId: ids.revision,
      readyAt: new Date(),
    });

    const parserVersion = `${fixture.parsed.parser.parserVersion}+${fixture.parsed.parser.tableExtractorVersion}`;
    const doclingPipeline = await insertPipelineRun(`pv-docling-${suffix}`);
    await insertParseAttempt(doclingPipeline, fixture.parseArtifact);
    const pageTwoChunk = fixture.parsed.chunks.find((chunk) => chunk.pages[0] === 2)!;
    flaggedChunkIndex = pageTwoChunk.chunkIndex;
    runs.docling = (await stageInspectionReview(db, scheduledReview(doclingPipeline, parserVersion, [{
      candidateId: null,
      chunkIndex: flaggedChunkIndex,
      ruleCode: "TABLE_ROW_SPLIT",
      severity: "critical",
      blocksApproval: true,
      message: "Row <split> across chunks.",
      evidence: {},
    }]))).id;

    const unpdfPipeline = await insertPipelineRun(`pv-unpdf-${suffix}`);
    await insertParseAttempt(unpdfPipeline, {
      ...fixture.parseArtifact,
      key: `parsed/unpdf-${suffix}`,
      uri: `file:///nowhere/unpdf-${suffix}`,
      mediaType: parsedPdfMediaType(),
    });
    runs.unpdf = (await stageInspectionReview(db, scheduledReview(unpdfPipeline, "unpdf-1.0.0+pdfplumber-1"))).id;

    // Points at the real parse artifact key with a checksum that cannot match: the store read fails.
    const corruptPipeline = await insertPipelineRun(`pv-corrupt-${suffix}`);
    await insertParseAttempt(corruptPipeline, { ...fixture.parseArtifact, sha256: "0".repeat(64) });
    runs.corrupt = (await stageInspectionReview(db, scheduledReview(corruptPipeline, parserVersion))).id;

    const failedPipeline = await insertPipelineRun(`pv-failed-${suffix}`);
    await insertParseAttempt(failedPipeline, null);
    runs.missingParse = (await stageInspectionReview(db, scheduledReview(failedPipeline, parserVersion))).id;

    const legacyOwnership = {
      visibilityScope: "GLOBAL" as const,
      tenantId: null,
      ownershipManifestId: "page-view-route-test",
      ownershipManifestVersion: 1,
    };
    const legacyFileHash = createHash("sha256").update(`legacy-${suffix}`).digest("hex");
    const [legacyDocument] = await db.insert(schema.documents).values({
      filename: `legacy-${suffix}.pdf`,
      filepath: `/tmp/legacy-${suffix}.pdf`,
      fileHash: legacyFileHash,
      status: "processing",
      ...legacyOwnership,
    }).returning();
    ids.legacyDocument = legacyDocument!.id;
    runs.legacy = (await stageInspectionReview(db, {
      sourceType: "pdf",
      sourceDocumentId: ids.legacyDocument,
      sourceName: `legacy-${suffix}.pdf`,
      fileHash: legacyFileHash,
      parserVersion: "unpdf-v1",
      chunkerVersion: "semantic-v1",
      ownership: legacyOwnership,
      report: {
        inspectorVersion: "1.0.0", candidateChunkCount: 1, inspectedChunkCount: 1,
        criticalCount: 0, warningCount: 0, blockingCount: 0, findings: [],
      },
      candidates: [{
        id: crypto.randomUUID(), chunkIndex: 0, text: "Legacy text", pageNumbers: [1], tokenCount: 2,
        hasTable: false, sectionHeader: null, metadata: { documentScope: "amc" }, contentHash: "e".repeat(64),
      }],
    })).id;

    sourceArtifacts = new ReviewSourceArtifacts(db, fixture.store);
    app = createReviewApp(db, { username: "reviewer", password: "secret" }, undefined, sourceArtifacts);
    appWithoutStore = createReviewApp(db, { username: "reviewer", password: "secret" });
  });

  afterAll(async () => {
    const runIds = Object.values(runs).filter(Boolean);
    if (runIds.length) {
      await db.delete(schema.reviewEvents).where(inArray(schema.reviewEvents.ingestionRunId, runIds));
      await db.delete(schema.ingestionRuns).where(inArray(schema.ingestionRuns.id, runIds));
    }
    if (ids.pipelineRuns.length) {
      await db.delete(schema.stageAttempts).where(inArray(schema.stageAttempts.pipelineRunId, ids.pipelineRuns));
      await db.delete(schema.pipelineRuns).where(inArray(schema.pipelineRuns.id, ids.pipelineRuns));
    }
    if (ids.version) await db.delete(schema.documentVersions).where(eq(schema.documentVersions.id, ids.version));
    if (ids.artifact) await db.delete(schema.artifacts).where(eq(schema.artifacts.id, ids.artifact));
    if (ids.legacyDocument) await db.delete(schema.documents).where(eq(schema.documents.id, ids.legacyDocument));
    if (ids.sourceDocument) await db.delete(schema.sourceDocuments).where(eq(schema.sourceDocuments.id, ids.sourceDocument));
    if (ids.source) await db.delete(schema.sources).where(eq(schema.sources.id, ids.source));
    if (ids.scope) await db.delete(schema.accessScopes).where(eq(schema.accessScopes.id, ids.scope));
    if (ids.revision) await db.delete(schema.sourceRegistryRevisions).where(eq(schema.sourceRegistryRevisions.id, ids.revision));
    if (fixture) await removeFixtureRoot(fixture.root);
    await client.close();
  });

  describe("ReviewSourceArtifacts.resolve against the database", () => {
    test("resolves a Docling pipeline run to its raw PDF and parse artifact", async () => {
      const resolution = await sourceArtifacts.resolve(runs.docling);

      expect(resolution).toMatchObject({
        kind: "docling",
        runId: runs.docling,
        documentVersionId: ids.version,
        sourceName: `${GOLDEN}.pdf`,
        rawArtifact: fixture.rawArtifact,
        parseArtifact: fixture.parseArtifact,
      });
      if (resolution.kind !== "docling") throw new Error("expected docling");
      const loaded = await sourceArtifacts.loadDoclingArtifact(resolution);
      expect(loaded.pageCount).toBe(fixture.parsed.diagnostics.pageCount);
      expect(await sourceArtifacts.loadRawPdf(resolution)).toEqual(fixture.pdfBytes);
    });

    test("classifies legacy, unpdf, failed-parse and unknown runs", async () => {
      expect(await sourceArtifacts.resolve(runs.legacy)).toEqual({ kind: "no_lineage", reason: "legacy_run", parserVersion: "unpdf-v1" });
      expect(await sourceArtifacts.resolve(runs.unpdf)).toMatchObject({ kind: "not_docling", mediaType: parsedPdfMediaType() });
      expect(await sourceArtifacts.resolve(runs.missingParse)).toMatchObject({ kind: "no_lineage", reason: "parse_output_missing" });
      expect(await sourceArtifacts.resolve(crypto.randomUUID())).toEqual({ kind: "not_found" });
    });
  });

  test("every page view route requires authentication", async () => {
    for (const path of [
      `/documents/${runs.docling}/pages`,
      `/documents/${runs.docling}/pages/1`,
      `/documents/${runs.docling}/source.pdf`,
      "/assets/page-view.js",
      `/assets/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`,
      `/assets/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`,
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(401);
    }
  });

  test("renders a Docling page with its candidates, boxes and versioned PDF URL", async () => {
    const response = await get(`/documents/${runs.docling}/pages/1`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const pageOneChunks = fixture.parsed.chunks.filter((chunk) => chunk.pages.includes(1));
    expect(pageOneChunks.length).toBeGreaterThan(0);
    for (const chunk of pageOneChunks) expect(html).toContain(`id="chunk-${chunk.chunkIndex}"`);
    expect(html).toContain(`source.pdf?v=${fixture.rawArtifact.sha256}`);
    expect(html).toContain(`/review/assets/pdfjs/${PDFJS_VERSION}/pdf.min.mjs`);
    const data = JSON.parse(html.match(/<script type="application\/json" id="page-view-data">([^<]*)<\/script>/)![1]!);
    expect(data.page).toBe(1);
    expect(data.boxes.length).toBe(pageOneChunks.reduce(
      (sum, chunk) => sum + chunk.bboxes.filter((bbox) => bbox.page === 1).length, 0,
    ));
    expect(data.boxes.every((box: { matched: boolean }) => box.matched)).toBe(true);
  });

  test("shows the open finding on its page and links it to the document review anchor", async () => {
    const html = await (await get(`/documents/${runs.docling}/pages/2`)).text();

    expect(html).toContain("TABLE_ROW_SPLIT");
    expect(html).toContain("Row &lt;split&gt; across chunks.");
    expect(html).toMatch(new RegExp(`href="/review/documents/${runs.docling}#flag-[0-9a-f-]{36}"`));
  });

  test("rejects malformed pages and 404s pages outside the document and unknown runs", async () => {
    expect((await get(`/documents/${runs.docling}/pages/abc`)).status).toBe(400);
    expect((await get(`/documents/${runs.docling}/pages/1.5`)).status).toBe(400);
    expect((await get(`/documents/${runs.docling}/pages/0`)).status).toBe(404);
    expect((await get(`/documents/${runs.docling}/pages/${fixture.parsed.diagnostics.pageCount + 1}`)).status).toBe(404);
    expect((await get(`/documents/${runs.docling}/pages/999`)).status).toBe(404);
    expect((await get(`/documents/${crypto.randomUUID()}/pages/1`)).status).toBe(404);
    expect((await get("/documents/not-a-uuid/pages/1")).status).toBe(404);
    expect((await get(`/documents/${crypto.randomUUID()}/source.pdf`)).status).toBe(404);
  });

  test("the pages index redirects to the first page with open findings or to the picked page", async () => {
    const first = await get(`/documents/${runs.docling}/pages`);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`/review/documents/${runs.docling}/pages/2`);

    const picked = await get(`/documents/${runs.docling}/pages?page=1`);
    expect(picked.status).toBe(303);
    expect(picked.headers.get("location")).toBe(`/review/documents/${runs.docling}/pages/1`);

    expect((await get(`/documents/${runs.docling}/pages?page=x`)).status).toBe(400);
  });

  test("explains non-Docling runs with a 200 panel", async () => {
    const legacy = await get(`/documents/${runs.legacy}/pages/1`);
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain("has no pipeline lineage");

    const unpdf = await get(`/documents/${runs.unpdf}/pages/1`);
    expect(unpdf.status).toBe(200);
    expect(await unpdf.text()).toContain("was parsed by <code>unpdf-1.0.0+pdfplumber-1</code>");

    const missing = await get(`/documents/${runs.missingParse}/pages`);
    expect(missing.status).toBe(200);
    expect(await missing.text()).toContain("no successful PARSE output");

    expect((await get(`/documents/${runs.legacy}/source.pdf`)).status).toBe(404);
  });

  test("returns a 502 panel with the error code, never store internals, for an unreadable artifact", async () => {
    const response = await get(`/documents/${runs.corrupt}/pages/1`);
    const html = await response.text();

    expect(response.status).toBe(502);
    expect(html).toContain("ARTIFACT_READ_FAILED");
    expect(html).not.toContain(fixture.root);
    expect(html).not.toContain("file://");
  });

  test("returns a 502 panel when the stored parse artifact is not a valid Docling artifact", async () => {
    const bytes = new TextEncoder().encode("{\"not\":\"docling\"}");
    const invalid = await fixture.store.put({
      namespace: `parsed/invalid-${suffix}`,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
      mediaType: fixture.parseArtifact.mediaType,
      producerVersion: fixture.parseArtifact.producerVersion,
    });
    const pipelineRunId = await insertPipelineRun(`pv-invalid-${suffix}`);
    await insertParseAttempt(pipelineRunId, invalid);
    const runId = (await stageInspectionReview(db, scheduledReview(pipelineRunId, "docling-x+none"))).id;
    try {
      const response = await get(`/documents/${runId}/pages/1`);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("INVALID_PARSED_ARTIFACT");
    } finally {
      await db.delete(schema.ingestionRuns).where(eq(schema.ingestionRuns.id, runId));
    }
  });

  test("returns a 503 panel when no artifact store is configured", async () => {
    const response = await get(`/documents/${runs.docling}/pages/1`, { app: appWithoutStore });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("ARTIFACT_STORE is not configured");
    expect((await get(`/documents/${runs.docling}/source.pdf`, { app: appWithoutStore })).status).toBe(503);
  });

  test("streams the raw PDF with caching headers and answers a matching ETag with 304", async () => {
    const response = await get(`/documents/${runs.docling}/source.pdf?v=${fixture.rawArtifact.sha256}`);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(fixture.pdfBytes))).toBe(true);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(fixture.pdfBytes.byteLength));
    expect(response.headers.get("etag")).toBe(`"${fixture.rawArtifact.sha256}"`);
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(`inline; filename="${GOLDEN}.pdf"`);
    expect(response.headers.get("accept-ranges")).toBeNull();

    const cached = await get(`/documents/${runs.docling}/source.pdf`, {
      headers: { "if-none-match": `"${fixture.rawArtifact.sha256}"` },
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(`"${fixture.rawArtifact.sha256}"`);
    expect(await cached.text()).toBe("");
  });

  test("serves the assets behind authentication", async () => {
    const pdfjs = await get(`/assets/pdfjs/${PDFJS_VERSION}/pdf.worker.min.mjs`);
    expect(pdfjs.status).toBe(200);
    expect(pdfjs.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get(`/assets/pdfjs/${PDFJS_VERSION}/pdf.mjs`)).status).toBe(404);
    expect((await get("/assets/pdfjs/0.0.1/pdf.min.mjs")).status).toBe(404);

    const client = await get("/assets/page-view.js");
    expect(client.status).toBe(200);
    expect(client.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  test("links Docling runs to the page view from the dashboard, document review and candidate editor", async () => {
    const dashboard = await (await get("/")).text();
    expect(dashboard).toContain(`href="/review/documents/${runs.docling}/pages"`);
    expect(dashboard).not.toContain(`href="/review/documents/${runs.legacy}/pages"`);

    const review = await (await get(`/documents/${runs.docling}`)).text();
    expect(review).toContain(`href="/review/documents/${runs.docling}/pages"`);
    expect(review).toMatch(/id="flag-[0-9a-f-]{36}"/);
    expect(review).toContain(`/pages/2#chunk-${flaggedChunkIndex}`);

    const editor = await (await get(`/documents/${runs.docling}/chunks`)).text();
    expect(editor).toContain(`/pages/1#chunk-0`);
  });
});
