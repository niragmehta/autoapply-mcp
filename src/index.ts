#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import { logger } from "./util/logger.js";
import { toErrorMessage } from "./util/errors.js";

/**
 * stdio entry point. stdout carries the JSON-RPC stream, so all diagnostics go
 * to stderr.
 */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server started", { name: SERVER_NAME, version: SERVER_VERSION });
}

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { reason: toErrorMessage(reason) });
});

main().catch((error) => {
  logger.error("fatal startup error", { error: toErrorMessage(error) });
  process.exitCode = 1;
});
