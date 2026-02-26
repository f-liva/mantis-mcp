import { MantisClient, type MantisIssue } from "./mantis-client.js";
import { VectorStore } from "./vector-store.js";
import { embedBatch } from "./embeddings.js";
import { logger } from "./logger.js";
import type { Config } from "./config.js";

let syncing = false;

export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
  totalIssues: number;
  totalChunks: number;
  durationMs: number;
}

/** Build text chunks from a full issue */
function buildChunks(
  issue: MantisIssue
): Array<{
  chunk_type: "issue" | "note";
  note_id: number | null;
  text: string;
  metadata_json: string;
}> {
  const chunks: Array<{
    chunk_type: "issue" | "note";
    note_id: number | null;
    text: string;
    metadata_json: string;
  }> = [];

  // Issue chunk: summary + description
  const issueText = [
    `[Issue #${issue.id}] ${issue.summary}`,
    issue.description || "",
  ]
    .filter(Boolean)
    .join("\n\n");

  chunks.push({
    chunk_type: "issue",
    note_id: null,
    text: issueText,
    metadata_json: JSON.stringify({
      issue_id: issue.id,
      project: issue.project.name,
      status: issue.status.name,
      reporter: issue.reporter.name,
      handler: issue.handler?.name ?? null,
      category: issue.category?.name ?? null,
      tags: issue.tags?.map((t) => t.name) ?? [],
    }),
  });

  // Note chunks: one per note
  if (issue.notes) {
    for (const note of issue.notes) {
      if (!note.text || note.text.trim().length === 0) continue;
      const noteText = `[Issue #${issue.id} - Note by ${note.reporter.name}]\n\n${note.text}`;
      chunks.push({
        chunk_type: "note",
        note_id: note.id,
        text: noteText,
        metadata_json: JSON.stringify({
          issue_id: issue.id,
          note_id: note.id,
          project: issue.project.name,
          reporter: note.reporter.name,
          created_at: note.created_at,
        }),
      });
    }
  }

  return chunks;
}

export async function syncIndex(
  client: MantisClient,
  store: VectorStore,
  config: Config,
  options: { projectId?: number } = {}
): Promise<SyncResult> {
  if (syncing) {
    throw new Error("Sync already in progress. Please wait for it to finish.");
  }
  syncing = true;
  const startTime = Date.now();

  try {
    logger.info(
      `Starting sync${options.projectId ? ` for project ${options.projectId}` : ""}...`
    );

    // 1. Fetch all issue headers (lightweight)
    const headers = await client.fetchAllIssueHeaders(options.projectId);
    logger.info(`Fetched ${headers.length} issue headers from MantisBT`);

    // 2. Compare with stored timestamps
    const stored = store.getStoredIssueTimestamps();
    const remoteIds = new Set(headers.map((h) => h.id));

    const toAdd: number[] = [];
    const toUpdate: number[] = [];

    for (const header of headers) {
      const storedTs = stored.get(header.id);
      if (!storedTs) {
        toAdd.push(header.id);
      } else if (storedTs !== header.updated_at) {
        toUpdate.push(header.id);
      }
    }

    // 3. Find deleted issues (in store but not in remote)
    const toDelete: number[] = [];
    for (const [id] of stored) {
      if (!remoteIds.has(id)) {
        toDelete.push(id);
      }
    }

    logger.info(
      `Diff: ${toAdd.length} new, ${toUpdate.length} updated, ${toDelete.length} deleted`
    );

    // 4. Delete removed issues
    for (const id of toDelete) {
      store.deleteIssue(id);
    }

    // 5. Process new + updated issues in batches
    const toProcess = [...toAdd, ...toUpdate];
    let processed = 0;

    for (let i = 0; i < toProcess.length; i += config.SYNC_BATCH_SIZE) {
      const batchIds = toProcess.slice(i, i + config.SYNC_BATCH_SIZE);

      // Fetch full issue details
      const issues: MantisIssue[] = [];
      for (const id of batchIds) {
        try {
          const issue = await client.getIssue(id);
          issues.push(issue);
        } catch (err) {
          logger.warn(
            `Failed to fetch issue #${id}: ${err instanceof Error ? err.message : err}`
          );
        }
      }

      // For updated issues: delete old chunks first
      for (const issue of issues) {
        if (toUpdate.includes(issue.id)) {
          store.deleteIssueChunks(issue.id);
        }
      }

      // Build all chunks for this batch
      const allChunks: Array<{
        issue: MantisIssue;
        chunk: ReturnType<typeof buildChunks>[number];
      }> = [];

      for (const issue of issues) {
        const chunks = buildChunks(issue);
        for (const chunk of chunks) {
          allChunks.push({ issue, chunk });
        }
      }

      // Batch-embed all chunk texts
      const texts = allChunks.map((c) => c.chunk.text);
      const embeddings = await embedBatch(texts);

      // Store everything in a transaction
      const insertTransaction = store.db.transaction(() => {
        for (let j = 0; j < allChunks.length; j++) {
          const { issue, chunk } = allChunks[j];

          // Insert/update the issue record (once per issue)
          store.insertIssue({
            id: issue.id,
            project_id: issue.project.id,
            project_name: issue.project.name,
            summary: issue.summary,
            status: issue.status.name,
            handler: issue.handler?.name ?? null,
            reporter: issue.reporter.name,
            created_at: issue.created_at,
            updated_at: issue.updated_at,
            raw_json: JSON.stringify(issue),
          });

          // Insert chunk + vector
          store.insertChunk(
            {
              issue_id: issue.id,
              chunk_type: chunk.chunk_type,
              note_id: chunk.note_id,
              text: chunk.text,
              metadata_json: chunk.metadata_json,
            },
            embeddings[j]
          );
        }
      });

      insertTransaction();

      processed += issues.length;
      logger.info(
        `Processed ${processed}/${toProcess.length} issues`
      );
    }

    // 6. Update sync metadata
    store.setMeta("last_sync", new Date().toISOString());
    store.setMeta(
      "last_sync_result",
      JSON.stringify({
        added: toAdd.length,
        updated: toUpdate.length,
        deleted: toDelete.length,
      })
    );

    const counts = store.getCounts();
    const durationMs = Date.now() - startTime;

    logger.info(
      `Sync completed in ${(durationMs / 1000).toFixed(1)}s: +${toAdd.length} ~${toUpdate.length} -${toDelete.length}`
    );

    return {
      added: toAdd.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
      totalIssues: counts.issues,
      totalChunks: counts.chunks,
      durationMs,
    };
  } finally {
    syncing = false;
  }
}

export function isSyncing(): boolean {
  return syncing;
}
