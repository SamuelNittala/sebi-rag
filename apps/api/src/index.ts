// API server entry point - to be implemented in Phase 2.6

import { Hono } from "hono";

const app = new Hono();

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
