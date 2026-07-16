// API server entry point - to be implemented in Phase 2.6

import { Hono } from "hono";
import { db } from "@mf-rag/db";
import { createReviewApp } from "./review/routes.ts";

const app = new Hono();

const reviewUsername = process.env.REVIEW_USERNAME;
const reviewPassword = process.env.REVIEW_PASSWORD;
if (reviewUsername && reviewPassword) {
  app.route("/review", createReviewApp(db, {
    username: reviewUsername,
    password: reviewPassword,
  }));
} else {
  app.get("/review", (c) => c.text("Review UI is disabled until REVIEW_USERNAME and REVIEW_PASSWORD are configured.", 503));
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
