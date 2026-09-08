#!/usr/bin/env node

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { initLogger, logger } from "./logger.js";
import { createDeps, buildServer } from "./server.js";
import { syncIndex } from "./sync.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config);

  logger.info("Starting mantis-mcp server...");

  // Deps condivise (SQLite: un solo store), un McpServer per sessione HTTP.
  const deps = await createDeps(config);

  const PORT = Number(process.env.MANTIS_MCP_PORT ?? 9312);
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const httpServer = http.createServer(async (req, res) => {
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? transports[sid] : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => { transports[id] = transport!; },
        });
        // ponytail: cleanup solo su onclose; se le sessioni morte si accumulassero,
        // aggiungere una scadenza sull'ultimo accesso.
        transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId]; };
        await buildServer(config, deps).connect(transport);
      }
      await transport.handleRequest(req, res);
    } catch (err) {
      logger.error(`request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  // Solo loopback: nessuna autenticazione, non deve uscire dalla macchina.
  httpServer.listen(PORT, "127.0.0.1", () => {
    logger.info(`mantis-mcp in ascolto su http://127.0.0.1:${PORT}/mcp`);
  });

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
