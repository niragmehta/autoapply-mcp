import { toErrorMessage } from "../util/errors.js";
import { logger } from "../util/logger.js";

/** Shared shapes for MCP tool responses. */

export type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function ok(data: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function okText(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

export function fail(error: unknown): ToolResponse {
  const message = toErrorMessage(error);
  logger.error("tool failed", { message });
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a handler so an unexpected throw becomes a structured tool error. */
export function handler<Args>(fn: (args: Args) => Promise<ToolResponse> | ToolResponse) {
  return async (args: Args): Promise<ToolResponse> => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  };
}
