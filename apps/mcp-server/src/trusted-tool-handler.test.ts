import { describe, expect, test } from "bun:test";

import { RequestContextError } from "./request-context.ts";
import { createTrustedToolCallHandler } from "./trusted-tool-handler.ts";

describe("trusted stdio tool handler", () => {
  test("reauthorizes every CallTool request so a revoked grant cannot dispatch", async () => {
    let authorized = true;
    let dispatches = 0;
    const handler = createTrustedToolCallHandler(
      { MF_RAG_API_KEY: "secret", AMC_SCOPE: "tenant-a" },
      {
        authorize: async () => authorized
          ? { decision: "authorized", keyId: "key-a" }
          : { decision: "unauthorized_scope" },
      },
      async () => { dispatches += 1; return { content: [] }; },
    );
    const request = { params: { name: "list_schemes" } };

    await handler(request);
    authorized = false;
    await expect(handler(request)).rejects.toBeInstanceOf(RequestContextError);
    expect(dispatches).toBe(1);
  });
});
