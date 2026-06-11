/** Builds the MCP server and registers all tools. Kept transport-free so tests can
 *  construct it with a mocked context and inspect the registered tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerDataTools } from "./tools/data.js";
import { registerFreightTools } from "./tools/freight.js";
import { registerGovTools } from "./tools/gov.js";
import type { ToolContext } from "./tools/shared.js";
import { registerUtilTools } from "./tools/util.js";

export const SERVER_NAME = "suverse";
export const SERVER_VERSION = "0.2.0";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerFreightTools(server, ctx); // 9 paid
  registerGovTools(server, ctx); //     3 paid
  registerUtilTools(server, ctx); //    4 free
  registerDataTools(server); //         3 custody-free 402 passthrough
  return server;
}
