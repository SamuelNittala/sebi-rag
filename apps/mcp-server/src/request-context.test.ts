import { describe, expect, test } from "bun:test";

import {
  RequestContextError,
  createHttpRequestContext,
  createTrustedRequestContext,
  securityLogRecord,
  type CredentialAuthorizer,
} from "./request-context.ts";

const authorized: CredentialAuthorizer = {
  async authorize(credential, tenantId) {
    if (credential !== "mf_test_secret") {
      return { decision: "invalid_credential" };
    }
    if (tenantId !== "tenant-a" && tenantId !== "tenant-b" && tenantId !== "RTA") {
      return { decision: "unauthorized_scope" };
    }
    return { decision: "authorized", keyId: "key-internal-id" };
  },
};

type TestHeaders = Headers | Array<[string, string]> | Record<string, string>;

function request(headers: TestHeaders = {}): Request {
  const entries = headers instanceof Headers
    ? Array.from(headers.entries())
    : Array.isArray(headers)
      ? headers
      : Object.entries(headers);
  const values = new Map(
    entries.map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  return {
    headers: {
      get(name: string) {
        return values.get(name.toLowerCase()) ?? null;
      },
    },
  } as unknown as Request;
}

async function expectContextError(
  promise: Promise<unknown>,
  status: number,
  reason: string,
) {
  try {
    await promise;
    throw new Error("Expected request context creation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RequestContextError);
    expect((error as RequestContextError).status).toBe(status);
    expect((error as RequestContextError).reason).toBe(reason);
    expect((error as Error).message).not.toContain("tenant-a");
    expect((error as Error).message).not.toContain("mf_test_secret");
  }
}

describe("createHttpRequestContext", () => {
  test("authorizes exactly one canonical scope and returns immutable context", async () => {
    const context = await createHttpRequestContext(
      request({
        Authorization: "Bearer mf_test_secret",
        "X-AMC-Scope": "tenant-a",
      }),
      { authorizer: authorized, allowedOrigins: new Set() },
    );

    expect(context).toEqual({
      correlationId: expect.any(String),
      keyId: "key-internal-id",
      tenantId: "tenant-a",
      accessScope: {
        kind: "tenant",
        tenantId: "tenant-a",
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  test("creates the configured AMC tenant set only after RTA authorization", async () => {
    const context = await createHttpRequestContext(
      request({
        Authorization: "Bearer mf_test_secret",
        "X-AMC-Scope": "RTA",
      }),
      { authorizer: authorized, allowedOrigins: new Set() },
    );

    expect(context.tenantId).toBe("RTA");
    expect({
      ...context.accessScope,
      tenantId: String(context.accessScope.tenantId),
      tenantIds: context.accessScope.kind === "tenant-set"
        ? context.accessScope.tenantIds.map(String)
        : undefined,
    }).toEqual({
      kind: "tenant-set",
      tenantId: "RTA",
      tenantIds: ["101", "128", "183", "185", "RMF"],
    });
  });

  test("does not create a context when RTA is not granted to the credential", async () => {
    const tenantOnlyAuthorizer: CredentialAuthorizer = {
      async authorize(_credential, tenantId) {
        if (tenantId === "RTA") {
          return { decision: "unauthorized_scope" };
        }
        return { decision: "authorized", keyId: "tenant-only-key" };
      },
    };

    await expectContextError(
      createHttpRequestContext(
        request({
          Authorization: "Bearer mf_test_secret",
          "X-AMC-Scope": "RTA",
        }),
        { authorizer: tenantOnlyAuthorizer, allowedOrigins: new Set() },
      ),
      403,
      "scope_forbidden",
    );
  });

  test("keeps near-miss rta as an exact tenant after authorization", async () => {
    const lowercaseRtaAuthorizer: CredentialAuthorizer = {
      async authorize(_credential, tenantId) {
        return tenantId === "rta"
          ? { decision: "authorized", keyId: "lowercase-rta-key" }
          : { decision: "unauthorized_scope" };
      },
    };
    const context = await createHttpRequestContext(
      request({
        Authorization: "Bearer mf_test_secret",
        "X-AMC-Scope": "rta",
      }),
      { authorizer: lowercaseRtaAuthorizer, allowedOrigins: new Set() },
    );

    expect(context.accessScope.kind).toBe("tenant");
    expect(context.accessScope.tenantId).toBe("rta");
  });

  test.each([
    [undefined, "missing_scope"],
    ["", "missing_scope"],
    ["tenant-a,tenant-b", "malformed_scope"],
    [" tenant-a", "malformed_scope"],
    ["tenant-a ", "malformed_scope"],
    ["*", "malformed_scope"],
    ["a".repeat(101), "malformed_scope"],
    ["tenant/a", "malformed_scope"],
  ])("rejects malformed scope %p before authorization", async (scope, reason) => {
    let calls = 0;
    const authorizer: CredentialAuthorizer = {
      async authorize() {
        calls += 1;
        return { decision: "authorized", keyId: "unused" };
      },
    };
    const headers: Record<string, string> = {
      Authorization: "Bearer mf_test_secret",
    };
    if (scope !== undefined) headers["X-AMC-Scope"] = scope;

    await expectContextError(
      createHttpRequestContext(request(headers), {
        authorizer,
        allowedOrigins: new Set(),
      }),
      400,
      reason,
    );
    expect(calls).toBe(0);
  });

  test.each([
    [undefined],
    [""],
    ["Basic abc"],
    ["Bearer "],
    ["Bearer one,two"],
    ["Bearer one two"],
  ])("rejects missing or malformed bearer %p as generic authentication failure", async (authorization) => {
    const headers = new Headers({ "X-AMC-Scope": "tenant-a" });
    if (authorization !== undefined) headers.set("Authorization", authorization);

    await expectContextError(
      createHttpRequestContext(request(headers), {
        authorizer: authorized,
        allowedOrigins: new Set(),
      }),
      401,
      "authentication_failed",
    );
  });

  test("returns a generic forbidden response for an ungranted canonical scope", async () => {
    await expectContextError(
      createHttpRequestContext(
        request({
          Authorization: "Bearer mf_test_secret",
          "X-AMC-Scope": "tenant-c",
        }),
        { authorizer: authorized, allowedOrigins: new Set() },
      ),
      403,
      "scope_forbidden",
    );
  });

  test("rejects a present origin outside the allowlist before authorization", async () => {
    let calls = 0;
    const authorizer: CredentialAuthorizer = {
      async authorize() {
        calls += 1;
        return { decision: "authorized", keyId: "unused" };
      },
    };

    await expectContextError(
      createHttpRequestContext(
        request({
          Authorization: "Bearer mf_test_secret",
          "X-AMC-Scope": "tenant-a",
          Origin: "https://attacker.invalid",
        }),
        {
          authorizer,
          allowedOrigins: new Set(["https://review.example"]),
        },
      ),
      403,
      "origin_forbidden",
    );
    expect(calls).toBe(0);
  });

  test("keeps concurrent tenant contexts isolated", async () => {
    const contexts = await Promise.all(
      ["tenant-a", "tenant-b"].map((tenantId) =>
        createHttpRequestContext(
          request({
            Authorization: "Bearer mf_test_secret",
            "X-AMC-Scope": tenantId,
          }),
          { authorizer: authorized, allowedOrigins: new Set() },
        )
      ),
    );

    expect(contexts.map((context) => context.tenantId)).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
    expect(contexts[0]).not.toBe(contexts[1]);
  });
});

describe("createTrustedRequestContext", () => {
  test("fails closed unless protected credential and AMC_SCOPE are both present", async () => {
    await expectContextError(
      createTrustedRequestContext(
        { MF_RAG_API_KEY: "mf_test_secret" },
        authorized,
      ),
      400,
      "missing_scope",
    );
    await expectContextError(
      createTrustedRequestContext({ AMC_SCOPE: "tenant-a" }, authorized),
      401,
      "authentication_failed",
    );
  });
});

describe("securityLogRecord", () => {
  test("contains the audit fields without secrets or raw questions", async () => {
    const context = await createTrustedRequestContext({
      MF_RAG_API_KEY: "mf_test_secret",
      AMC_SCOPE: "tenant-a",
    }, authorized);
    const serialized = JSON.stringify(securityLogRecord(
      context,
      "query_mutual_funds",
      "allowed",
      "retrieval_complete",
      2,
    ));

    expect(JSON.parse(serialized)).toEqual({
      correlationId: expect.any(String),
      keyId: "key-internal-id",
      tenantId: "tenant-a",
      operation: "query_mutual_funds",
      decision: "allowed",
      reason: "retrieval_complete",
      resultCount: 2,
    });
    expect(serialized).not.toContain("mf_test_secret");
    expect(serialized).not.toContain("what is my raw question");
  });
});
