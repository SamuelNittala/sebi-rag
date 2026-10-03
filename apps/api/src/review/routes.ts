import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { csrf } from "hono/csrf";

import {
  approveReviewRun,
  decideChunkFlag,
  getReviewRunDetail,
  getReviewRunPage,
  getReviewRunPageSummary,
  listReviewRuns,
  rejectReviewRun,
} from "@mf-rag/db/review-queries";
import type { Database } from "@mf-rag/db/client";
import type { RetrievalSearch } from "../retrieval/mcp-retrieval-search.ts";
import { editReviewCandidate } from "./candidate-editor.ts";
import { editReviewCandidateMetadata } from "./metadata-editor.ts";
import { ReviewAssets } from "./page-view/assets.ts";
import { buildPageViewModel, initialPage, pageViewHref } from "./page-view/page-view-model.ts";
import {
  ReviewSourceError,
  type DoclingSourceLineage,
  type LoadedDoclingArtifact,
  type ReviewSourceArtifacts,
} from "./page-view/source-artifacts.ts";
import {
  renderCandidateEditor,
  renderDocumentPageView,
  renderDocumentReview,
  renderPageViewUnavailable,
  renderRetrievalSearch,
  renderReviewDashboard,
} from "./views.ts";

export interface ReviewAuthConfig {
  username: string;
  password: string;
}

function requiredFormString(
  body: Record<string, string | File>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_PATTERN = /^\d{1,6}$/;

/** One assets instance per process: the client bundle is built once. */
let sharedAssets: ReviewAssets | undefined;

/** ASCII-only `Content-Disposition` filename from the run's source name. */
export function sanitizePdfFilename(sourceName: string): string {
  const base = sourceName.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 150);
  if (!cleaned.replace(/[_ .-]/g, "")) return "source.pdf";
  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

type PageViewSource = Pick<ReviewSourceArtifacts, "resolve" | "loadDoclingArtifact" | "loadRawPdf">;

export function createReviewApp(
  db: Database,
  auth: ReviewAuthConfig,
  retrievalSearch?: RetrievalSearch,
  /** Page view source; without it the page view answers 503 (ARTIFACT_STORE not configured). */
  sourceArtifacts?: PageViewSource,
): Hono {
  const app = new Hono();
  const assets = sharedAssets ??= new ReviewAssets();
  app.use("*", basicAuth({ username: auth.username, password: auth.password, realm: "Chunk Review" }));
  app.use("*", csrf());

  app.get("/assets/pdfjs/:version/:file", (c) =>
    assets.pdfjsResponse(c.req.param("version"), c.req.param("file")) ?? c.text("Not found.", 404));

  app.get("/assets/page-view.js", (c) => assets.clientResponse(c.req.query("v")));

  /**
   * Shared prologue of the page view routes: the Docling lineage and loaded
   * parse artifact, or the response to send instead (404 / panel 200 / 502 / 503).
   */
  async function loadPageSource(runId: string): Promise<
    | { lineage: DoclingSourceLineage; loaded: LoadedDoclingArtifact }
    | { response: { status: 200 | 404 | 502 | 503; html: string } }
  > {
    if (!UUID_PATTERN.test(runId)) return { response: { status: 404, html: "Review run not found." } };
    if (!sourceArtifacts) {
      return { response: { status: 503, html: renderPageViewUnavailable({ runId, reason: { kind: "disabled" } }) } };
    }
    const resolution = await sourceArtifacts.resolve(runId);
    switch (resolution.kind) {
      case "not_found":
        return { response: { status: 404, html: "Review run not found." } };
      case "no_lineage":
      case "not_docling":
        return { response: { status: 200, html: renderPageViewUnavailable({ runId, reason: resolution }) } };
      case "error":
        return { response: { status: 502, html: renderPageViewUnavailable({ runId, reason: resolution }) } };
      case "docling":
        break;
    }
    try {
      return { lineage: resolution, loaded: await sourceArtifacts.loadDoclingArtifact(resolution) };
    } catch (error) {
      if (!(error instanceof ReviewSourceError)) throw error;
      console.error(`Review page view: run ${runId}: ${error.code}`, error.cause);
      return {
        response: { status: 502, html: renderPageViewUnavailable({ runId, reason: { kind: "error", code: error.code } }) },
      };
    }
  }

  app.get("/documents/:runId/pages", async (c) => {
    const runId = c.req.param("runId");
    const picked = c.req.query("page");
    if (picked !== undefined) {
      if (!PAGE_PATTERN.test(picked)) return c.text("Page must be a positive integer.", 400);
      return c.redirect(pageViewHref(runId, Number(picked)), 303);
    }
    const source = await loadPageSource(runId);
    if ("response" in source) return c.html(source.response.html, source.response.status);
    const summary = await getReviewRunPageSummary(db, runId);
    return c.redirect(pageViewHref(runId, initialPage(summary, source.loaded.pageCount)), 303);
  });

  app.get("/documents/:runId/pages/:page", async (c) => {
    const runId = c.req.param("runId");
    const pageParam = c.req.param("page");
    if (!PAGE_PATTERN.test(pageParam)) return c.text("Page must be a positive integer.", 400);
    const source = await loadPageSource(runId);
    if ("response" in source) return c.html(source.response.html, source.response.status);
    const { lineage, loaded } = source;
    const page = Number(pageParam);
    if (page < 1 || page > loaded.pageCount) return c.text(`Page ${page} is outside 1..${loaded.pageCount}.`, 404);
    const [pageRows, summary, assetUrls] = await Promise.all([
      getReviewRunPage(db, runId, page),
      getReviewRunPageSummary(db, runId),
      assets.urls(),
    ]);
    if (!pageRows) return c.text("Review run not found.", 404);
    const model = buildPageViewModel({
      run: {
        id: pageRows.run.id,
        sourceName: pageRows.run.sourceName,
        parserVersion: pageRows.run.parserVersion,
        status: pageRows.run.status,
      },
      page,
      pageCount: loaded.pageCount,
      rawPdfSha256: lineage.rawArtifact.sha256,
      summary,
      candidates: pageRows.candidates,
      flags: pageRows.flags,
      editCounts: pageRows.editCounts,
      wireChunks: loaded.chunksOnPage(page),
    });
    return c.html(renderDocumentPageView(model, assetUrls));
  });

  app.get("/documents/:runId/source.pdf", async (c) => {
    const runId = c.req.param("runId");
    if (!UUID_PATTERN.test(runId)) return c.text("Review run not found.", 404);
    if (!sourceArtifacts) return c.text("Page view is disabled: ARTIFACT_STORE is not configured.", 503);
    const resolution = await sourceArtifacts.resolve(runId);
    if (resolution.kind === "error") return c.text(`Source PDF unavailable: ${resolution.code}.`, 502);
    if (resolution.kind !== "docling") {
      return c.text("Source PDF is only served for Docling-parsed pipeline runs.", 404);
    }
    const etag = `"${resolution.rawArtifact.sha256}"`;
    const cacheHeaders = {
      etag,
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    };
    const ifNoneMatch = c.req.header("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").map((tag) => tag.trim()).includes(etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    let bytes: Uint8Array;
    try {
      bytes = await sourceArtifacts.loadRawPdf(resolution);
    } catch (error) {
      if (!(error instanceof ReviewSourceError)) throw error;
      console.error(`Review page view: run ${runId} source PDF: ${error.code}`, error.cause);
      return c.text(`Source PDF unavailable: ${error.code}.`, 502);
    }
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      headers: {
        ...cacheHeaders,
        "content-type": "application/pdf",
        "content-length": String(bytes.byteLength),
        "content-disposition": `inline; filename="${sanitizePdfFilename(resolution.sourceName)}"`,
      },
    });
  });

  app.get("/", async (c) => {
    const runs = await listReviewRuns(db);
    return c.html(renderReviewDashboard(runs));
  });

  app.get("/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (!query) return c.html(renderRetrievalSearch({ query: "" }));
    if (query.length > 500) {
      return c.html(renderRetrievalSearch({
        query,
        error: "Queries must be 500 characters or fewer.",
      }), 400);
    }
    if (!retrievalSearch) {
      return c.html(renderRetrievalSearch({
        query,
        error: "Retrieval search is not configured on this server.",
      }), 503);
    }
    try {
      const result = await retrievalSearch.search(query);
      return c.html(renderRetrievalSearch({ query, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Retrieval failed.";
      return c.html(renderRetrievalSearch({ query, error: message }), 502);
    }
  });

  app.get("/documents/:runId", async (c) => {
    const detail = await getReviewRunDetail(db, c.req.param("runId"));
    if (!detail) return c.text("Review run not found.", 404);
    return c.html(renderDocumentReview(detail));
  });

  app.get("/documents/:runId/chunks", async (c) => {
    const detail = await getReviewRunDetail(db, c.req.param("runId"));
    if (!detail) return c.text("Review run not found.", 404);
    return c.html(renderCandidateEditor(detail));
  });

  app.post("/candidates/:candidateId/edit", async (c) => {
    try {
      const body = await c.req.parseBody();
      const result = await editReviewCandidate(db, {
        candidateId: c.req.param("candidateId"),
        expectedContentHash: requiredFormString(body, "expectedContentHash"),
        text: requiredFormString(body, "text"),
        editor: auth.username,
        note: requiredFormString(body, "note"),
      });
      return c.redirect(
        `/review/documents/${result.ingestionRunId}/chunks#${c.req.param("candidateId")}`,
        303,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to edit candidate.";
      return c.text(message, message.includes("changed after") ? 409 : 400);
    }
  });

  app.post("/candidates/:candidateId/metadata", async (c) => {
    try {
      const body = await c.req.parseBody();
      const result = await editReviewCandidateMetadata(db, {
        candidateId: c.req.param("candidateId"),
        expectedContentHash: requiredFormString(body, "expectedContentHash"),
        documentScope: requiredFormString(body, "documentScope"),
        strategyId: typeof body.strategyId === "string" ? body.strategyId : "",
        sectionType: requiredFormString(body, "sectionType"),
        factType: typeof body.factType === "string" ? body.factType : "",
        editor: auth.username,
        note: requiredFormString(body, "note"),
      });
      return c.redirect(
        `/review/documents/${result.ingestionRunId}/chunks#${c.req.param("candidateId")}`,
        303,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to edit metadata.";
      return c.text(message, message.includes("changed after") ? 409 : 400);
    }
  });

  app.post("/flags/:flagId", async (c) => {
    try {
      const body = await c.req.parseBody();
      const decision = requiredFormString(body, "decision");
      if (decision !== "accepted" && decision !== "resolved") {
        return c.text("Invalid flag decision.", 400);
      }
      const updated = await decideChunkFlag(db, c.req.param("flagId"), {
        status: decision,
        reviewer: auth.username,
        note: requiredFormString(body, "note"),
      });
      return c.redirect(`/review/documents/${updated.ingestionRunId}`, 303);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Unable to review flag.", 400);
    }
  });

  app.post("/documents/:runId/decision", async (c) => {
    try {
      const body = await c.req.parseBody();
      const decision = requiredFormString(body, "decision");
      const note = requiredFormString(body, "note");
      const runId = c.req.param("runId");
      if (decision === "reject") {
        await rejectReviewRun(db, runId, auth.username, note);
        return c.redirect(`/review/documents/${runId}`, 303);
      }
      if (decision !== "approve") return c.text("Invalid document decision.", 400);
      const result = await approveReviewRun(db, runId, auth.username, note);
      if (!result.approved) return c.text(result.reasons.join(" "), 409);
      return c.redirect(`/review/documents/${runId}`, 303);
    } catch (error) {
      return c.text(error instanceof Error ? error.message : "Unable to review document.", 400);
    }
  });

  return app;
}
