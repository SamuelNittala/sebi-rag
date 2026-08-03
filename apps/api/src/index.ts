// API server entry point - to be implemented in Phase 2.6

import { Hono } from "hono";
import { db } from "@mf-rag/db";
import { McpRetrievalSearch } from "./retrieval/mcp-retrieval-search.ts";
import { createReviewApp } from "./review/routes.ts";
import { DrizzleApiKeyScopeStore } from "./admin/api-key-scope-store.ts";
import { createAdminApp } from "./admin/routes.ts";

const app = new Hono();

const reviewUsername = process.env.REVIEW_USERNAME;
const reviewPassword = process.env.REVIEW_PASSWORD;
if (reviewUsername && reviewPassword) {
  const retrievalSearch = new McpRetrievalSearch(new URL(
    process.env.KNOWLEDGE_MCP_URL ?? "http://localhost:3001/mcp",
  ), {
    apiKey: process.env.MF_RAG_API_KEY ?? "",
    tenantId: process.env.AMC_SCOPE ?? "",
  });
  app.route("/review", createReviewApp(db, {
    username: reviewUsername,
    password: reviewPassword,
  }, retrievalSearch));
  app.route("/admin", createAdminApp(
    new DrizzleApiKeyScopeStore(db),
    { username: reviewUsername, password: reviewPassword },
  ));
} else {
  app.get("/review", (c) => c.text("Review UI is disabled until REVIEW_USERNAME and REVIEW_PASSWORD are configured.", 503));
  app.get("/admin", (c) => c.text("Admin UI is disabled until REVIEW_USERNAME and REVIEW_PASSWORD are configured.", 503));
}

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    services: {
      vector: false, // pgvector
      postgres: false,
      ollama: false,
    },
  });
});

app.get("/", (c) => {
  return c.json({
    name: "MF PDF RAG API",
    version: "0.1.0",
  });
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting API server on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
