import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MantisClient } from "../mantis-client.js";
import type { VectorStore } from "../vector-store.js";
import type { Config } from "../config.js";
import { embed } from "../embeddings.js";
import { syncIndex, isSyncing } from "../sync.js";

export function registerSearchTools(
  server: McpServer,
  client: MantisClient,
  store: VectorStore,
  config: Config
): void {
  // ── search ─────────────────────────────────────────────────────────
  server.tool(
    "search",
    "Semantic search across all indexed MantisBT issues and notes. Returns ranked results with similarity scores. Requires a prior sync_index call to populate the index.",
    {
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe("Maximum results to return (default 10, max 50)"),
    },
    async (params) => {
      try {
        const counts = store.getCounts();
        if (counts.chunks === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "The search index is empty. Please run sync_index first to populate the index.",
              },
            ],
          };
        }

        const queryEmbedding = await embed(params.query);
        const results = store.search(queryEmbedding, params.limit ?? 10);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No results found.",
              },
            ],
          };
        }

        // Format results with similarity scores
        // sqlite-vec cosine distance: 0 = identical, 2 = opposite
        // Convert to similarity: 1 - (distance / 2)
        const formatted = results.map((r, i) => {
          const similarity = (1 - r.distance / 2) * 100;
          const meta = JSON.parse(r.metadata_json);
          return [
            `--- Result ${i + 1} (${similarity.toFixed(1)}% match) ---`,
            `Issue #${r.issue_id} | Type: ${r.chunk_type}${r.note_id ? ` | Note #${r.note_id}` : ""}`,
            `Project: ${meta.project ?? "N/A"} | Status: ${meta.status ?? "N/A"}`,
            meta.reporter ? `Reporter: ${meta.reporter}` : null,
            meta.handler ? `Handler: ${meta.handler}` : null,
            "",
            r.text,
          ]
            .filter((line) => line !== null)
            .join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text: formatted.join("\n\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── sync_index ─────────────────────────────────────────────────────
  server.tool(
    "sync_index",
    "Synchronize MantisBT issues into the local vector index. Supports incremental sync (only processes new/updated/deleted issues). First sync may take several minutes for large databases.",
    {
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional: only sync issues from this project"),
    },
    async (params) => {
      try {
        if (isSyncing()) {
          return {
            content: [
              {
                type: "text" as const,
                text: "A sync is already in progress. Please wait for it to finish.",
              },
            ],
            isError: true,
          };
        }

        const result = await syncIndex(client, store, config, {
          projectId: params.project_id,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Sync completed successfully!",
                "",
                `  Added:   ${result.added} issues`,
                `  Updated: ${result.updated} issues`,
                `  Deleted: ${result.deleted} issues`,
                `  Total:   ${result.totalIssues} issues, ${result.totalChunks} chunks`,
                `  Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
              ].join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Sync error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── sync_status ────────────────────────────────────────────────────
  server.tool(
    "sync_status",
    "Check the current status of the vector search index (last sync time, issue/chunk counts)",
    {},
    async () => {
      try {
        const counts = store.getCounts();
        const lastSync = store.getMeta("last_sync");
        const lastResult = store.getMeta("last_sync_result");

        const lines = [
          "Vector Index Status",
          "===================",
          `Issues indexed: ${counts.issues}`,
          `Chunks stored:  ${counts.chunks}`,
          `Last sync:      ${lastSync ?? "never"}`,
        ];

        if (lastResult) {
          const r = JSON.parse(lastResult);
          lines.push(
            `Last sync result: +${r.added} added, ~${r.updated} updated, -${r.deleted} deleted`
          );
        }

        lines.push(`Sync in progress: ${isSyncing() ? "yes" : "no"}`);

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n"),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error checking sync status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
