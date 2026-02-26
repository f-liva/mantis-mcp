import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { MantisClient } from "./mantis-client.js";
import { VectorStore } from "./vector-store.js";
import { initEmbeddings } from "./embeddings.js";
import { registerCrudTools } from "./tools/crud.js";
import { registerSearchTools } from "./tools/search.js";
import { logger } from "./logger.js";

export interface ServerDeps {
  client: MantisClient;
  store: VectorStore;
}

export async function createServer(
  config: Config
): Promise<{ server: McpServer; deps: ServerDeps }> {
  // Initialize dependencies
  const client = new MantisClient(config);
  const store = new VectorStore(config);
  await initEmbeddings(config);

  // Create MCP server
  const server = new McpServer({
    name: "mantis-mcp",
    version: "1.0.0",
  });

  // Register all tools
  registerCrudTools(server, client);
  registerSearchTools(server, client, store, config);

  logger.info("MCP server created with 11 tools registered.");

  return { server, deps: { client, store } };
}
