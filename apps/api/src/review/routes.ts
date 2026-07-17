import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { csrf } from "hono/csrf";

import {
  approveReviewRun,
  decideChunkFlag,
  getReviewRunDetail,
  listReviewRuns,
  rejectReviewRun,
} from "@mf-rag/db/review-queries";
import type { Database } from "@mf-rag/db/client";
import { editReviewCandidate } from "./candidate-editor.ts";
import { editReviewCandidateMetadata } from "./metadata-editor.ts";
import {
  renderCandidateEditor,
  renderDocumentReview,
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

export function createReviewApp(db: Database, auth: ReviewAuthConfig): Hono {
  const app = new Hono();
  app.use("*", basicAuth({ username: auth.username, password: auth.password, realm: "Chunk Review" }));
  app.use("*", csrf());

  app.get("/", async (c) => {
    const runs = await listReviewRuns(db);
    return c.html(renderReviewDashboard(runs));
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
