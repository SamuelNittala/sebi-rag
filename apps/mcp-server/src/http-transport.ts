import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  RequestContextError,
  createHttpRequestContext,
  type CredentialAuthorizer,
  type RequestContext,
} from "./request-context.ts";

type ToolCallRequest = {
  params: { name: string; arguments?: Record<string, unknown> };
};

export interface HttpMcpDependencies {
  readonly authorizer: CredentialAuthorizer;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly tools: Tool[];
  readonly handleToolCall: (context: RequestContext, request: ToolCallRequest) => Promise<unknown>;
  readonly logAuthorized?: (context: RequestContext) => void;
}

export function createMcpHttpHandler(dependencies: HttpMcpDependencies) {
  return async function handleMcpRequest(request: Request): Promise<Response> {
    const correlationId = crypto.randomUUID();
    let context: RequestContext;
    try {
      context = await createHttpRequestContext(request, {
        authorizer: dependencies.authorizer,
        allowedOrigins: dependencies.allowedOrigins,
        correlationId: () => correlationId,
      });
      dependencies.logAuthorized?.(context);
    } catch (error) {
      if (!(error instanceof RequestContextError)) throw error;
      console.error(JSON.stringify({
        correlationId,
        keyId: null,
        tenantId: null,
        operation: "mcp_request",
        decision: "denied",
        reason: error.reason,
        resultCount: 0,
      }));
      return Response.json({ error: error.message }, { status: error.status });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = new Server(
      { name: "mf-rag", version: "0.3.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dependencies.tools }));
    server.setRequestHandler(CallToolRequestSchema, (toolRequest) =>
      dependencies.handleToolCall(context, toolRequest),
    );
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await server.close();
    return response;
  };
}
