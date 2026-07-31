import type { CredentialAuthorizer, RequestContext } from "./request-context.ts";
import { createTrustedRequestContext } from "./request-context.ts";

type ToolCallRequest = {
  params: { name: string; arguments?: Record<string, unknown> };
};

export function createTrustedToolCallHandler(
  environment: Record<string, string | undefined>,
  authorizer: CredentialAuthorizer,
  handleToolCall: (context: RequestContext, request: ToolCallRequest) => Promise<unknown>,
) {
  return async (request: ToolCallRequest) => handleToolCall(
    await createTrustedRequestContext(environment, authorizer),
    request,
  );
}
