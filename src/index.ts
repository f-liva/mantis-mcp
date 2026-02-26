#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { createServer } from "./server.js";
import { syncIndex } from "./sync.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config);

  logger.info("Starting mantis-mcp server...");

  const { server, deps } = await createServer(config);

  // Stdio transport for MCP communication
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("mantis-mcp server connected via stdio.");

  // Optional startup sync
  if (config.SYNC_ON_STARTUP) {
    logger.info("SYNC_ON_STARTUP enabled, starting initial sync...");
    try {
      await syncIndex(deps.client, deps.store, config);
    } catch (err) {
      logger.error(
        `Startup sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down...");
    deps.store.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
