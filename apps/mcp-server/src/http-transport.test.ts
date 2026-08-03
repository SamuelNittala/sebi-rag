import { describe, expect, test } from "bun:test";

import { createMcpHttpHandler } from "./http-transport.ts";

const callTool = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "test_tool", arguments: {} },
};

function request(headers: HeadersInit) {
  return new Request("http://mcp.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(callTool),
  });
}

describe("HTTP MCP authorization boundary", () => {
  test("rejects missing credentials before dispatch", async () => {
    let dispatches = 0;
    const handler = createMcpHttpHandler({
      authorizer: { authorize: async () => ({ decision: "authorized", keyId: "key" }) },
      allowedOrigins: new Set(),
      tools: [],
      handleToolCall: async () => { dispatches += 1; return { content: [] }; },
    });

    expect((await handler(request({ "X-AMC-Scope": "tenant-a" }))).status).toBe(401);
    expect(dispatches).toBe(0);
  });

  test("rejects an unauthorized scope before dispatch", async () => {
    let dispatches = 0;
    const handler = createMcpHttpHandler({
      authorizer: { authorize: async () => ({ decision: "unauthorized_scope" }) },
      allowedOrigins: new Set(),
      tools: [],
      handleToolCall: async () => { dispatches += 1; return { content: [] }; },
    });

    expect((await handler(request({ Authorization: "Bearer secret", "X-AMC-Scope": "tenant-b" }))).status).toBe(403);
    expect(dispatches).toBe(0);
  });

  test("dispatches an authorized CallTool request with its immutable tenant context", async () => {
    let dispatchedTenant = "";
    const handler = createMcpHttpHandler({
      authorizer: {
        authorize: async (credential, tenantId) =>
          credential === "secret" && tenantId === "tenant-a"
            ? { decision: "authorized", keyId: "key-a" }
            : { decision: "unauthorized_scope" },
      },
      allowedOrigins: new Set(),
      tools: [],
      handleToolCall: async (context) => {
        dispatchedTenant = context.tenantId;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });

    expect((await handler(request({ Authorization: "Bearer secret", "X-AMC-Scope": "tenant-a" }))).status).toBe(200);
    expect(dispatchedTenant).toBe("tenant-a");
  });
});
