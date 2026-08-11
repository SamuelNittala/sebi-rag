import {
  createAuthorizedTenantAccessScope,
  createTenantId,
  type TenantAccessScope,
  type TenantId,
} from "@mf-rag/types";

export type AuthorizationDecision =
  | {
      readonly decision: "authorized";
      readonly keyId: string;
      readonly keyTier?: string;
    }
  | {
      readonly decision:
        | "invalid_credential"
        | "inactive_credential"
        | "unauthorized_scope";
    };

export interface CredentialAuthorizer {
  authorize(
    credential: string,
    tenantId: string,
  ): Promise<AuthorizationDecision>;
}

export interface RequestContext {
  readonly correlationId: string;
  readonly keyId: string;
  readonly keyTier?: string;
  readonly tenantId: TenantId;
  readonly accessScope: TenantAccessScope;
}

export function securityLogRecord(
  context: RequestContext,
  operation: string,
  decision: "allowed" | "denied",
  reason: string,
  resultCount: number,
) {
  return {
    correlationId: context.correlationId,
    keyId: context.keyId,
    tenantId: context.tenantId,
    operation,
    decision,
    reason,
    resultCount,
  } as const;
}

export class RequestContextError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403,
    public readonly reason:
      | "missing_scope"
      | "malformed_scope"
      | "authentication_failed"
      | "scope_forbidden"
      | "origin_forbidden",
  ) {
    super(
      status === 400
        ? "Invalid request context"
        : status === 401
          ? "Authentication failed"
          : "Request forbidden",
    );
    this.name = "RequestContextError";
  }
}

export interface HttpRequestContextDependencies {
  readonly authorizer: CredentialAuthorizer;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly correlationId?: () => string;
}

const BEARER_CREDENTIAL = /^Bearer ([\x21-\x2B\x2D-\x7E]{1,256})$/;

function readTenantId(value: string | null): TenantId {
  if (value === null || value.length === 0) {
    throw new RequestContextError(400, "missing_scope");
  }
  try {
    return createTenantId(value);
  } catch {
    throw new RequestContextError(400, "malformed_scope");
  }
}

function readCredential(value: string | null): string {
  const match = value?.match(BEARER_CREDENTIAL);
  if (!match?.[1]) {
    throw new RequestContextError(401, "authentication_failed");
  }
  return match[1];
}

function validateOrigin(
  origin: string | null,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (origin === null) return;
  if (allowedOrigins.has(origin)) return;
  throw new RequestContextError(403, "origin_forbidden");
}

async function authorizeContext(
  credential: string,
  tenantId: TenantId,
  authorizer: CredentialAuthorizer,
  correlationId: string,
): Promise<RequestContext> {
  const result = await authorizer.authorize(credential, tenantId);
  if (result.decision === "unauthorized_scope") {
    throw new RequestContextError(403, "scope_forbidden");
  }
  if (result.decision !== "authorized") {
    throw new RequestContextError(401, "authentication_failed");
  }
  return Object.freeze({
    correlationId,
    keyId: result.keyId,
    ...(result.keyTier && { keyTier: result.keyTier }),
    tenantId,
    accessScope: createAuthorizedTenantAccessScope(tenantId),
  });
}

export async function createHttpRequestContext(
  request: Request,
  dependencies: HttpRequestContextDependencies,
): Promise<RequestContext> {
  validateOrigin(request.headers.get("origin"), dependencies.allowedOrigins);
  const tenantId = readTenantId(request.headers.get("x-amc-scope"));
  const credential = readCredential(request.headers.get("authorization"));
  return authorizeContext(
    credential,
    tenantId,
    dependencies.authorizer,
    dependencies.correlationId?.() ?? crypto.randomUUID(),
  );
}

export async function createTrustedRequestContext(
  environment: Record<string, string | undefined>,
  authorizer: CredentialAuthorizer,
): Promise<RequestContext> {
  const tenantId = readTenantId(environment.AMC_SCOPE ?? null);
  const credential = environment.MF_RAG_API_KEY;
  if (!credential) {
    throw new RequestContextError(401, "authentication_failed");
  }
  return authorizeContext(
    credential,
    tenantId,
    authorizer,
    crypto.randomUUID(),
  );
}
