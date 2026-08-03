import type { CredentialAuthorizer } from "./request-context.ts";
import { createTrustedRequestContext } from "./request-context.ts";
import type { ToolCallHandler, ToolCallRequest } from "./tool-call.ts";

export function createTrustedToolCallHandler(
  environment: Record<string, string | undefined>,
  authorizer: CredentialAuthorizer,
  handleToolCall: ToolCallHandler,
) {
  return async (request: ToolCallRequest) => handleToolCall(
    await createTrustedRequestContext(environment, authorizer),
    request,
  );
}
