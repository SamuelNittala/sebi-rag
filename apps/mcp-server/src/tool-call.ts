import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { RequestContext } from "./request-context.ts";

export type ToolCallRequest = CallToolRequest;
export type ToolCallResult = CallToolResult;
export type ToolCallHandler = (
  context: RequestContext,
  request: ToolCallRequest,
) => Promise<ToolCallResult>;
