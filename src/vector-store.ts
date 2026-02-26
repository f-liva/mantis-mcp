import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

const VECTOR_DIMS = 384;

export interface ChunkRow {
  id: number;
  issue_id: number;
  chunk_type: "issue" | "note";
  note_id: number | null;
  text: string;
  metadata_json: string;
}

export interface SearchResult {
  chunk_id: number;
  distance: number;
  issue_id: number;
  chunk_type: string;
  note_id: number | null;
  text: string;
  metadata_json: string;
}

export class VectorStore {
  public db: Database.Database;

  constructor(config: Config) {
    this.db = new Database(config.DB_PATH);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db);
    this.initSchema();
    logger.info(`Vector store initialized at ${config.DB_PATH}`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        handler TEXT,
        reporter TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        chunk_type TEXT NOT NULL CHECK(chunk_type IN ('issue', 'note')),
        note_id INTEGER,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_issue_id ON chunks(issue_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[${VECTOR_DIMS}] distance_metric=cosine
      );

      CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** Insert or replace a cached issue record */
  insertIssue(issue: {
    id: number;
    project_id: number;
    project_name: string;
    summary: string;
    status: string;
    handler: string | null;
    reporter: string;
    created_at: string;
    updated_at: string;
    raw_json: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO issues
         (id, project_id, project_name, summary, status, handler, reporter, created_at, updated_at, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        issue.id,
        issue.project_id,
        issue.project_name,
        issue.summary,
        issue.status,
        issue.handler,
        issue.reporter,
        issue.created_at,
        issue.updated_at,
        issue.raw_json
      );
  }

  /** Insert a text chunk and its embedding vector */
  insertChunk(
    chunk: {
      issue_id: number;
      chunk_type: "issue" | "note";
      note_id: number | null;
      text: string;
      metadata_json: string;
    },
    embedding: Float32Array
  ): void {
    const info = this.db
      .prepare(
        `INSERT INTO chunks (issue_id, chunk_type, note_id, text, metadata_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        chunk.issue_id,
        chunk.chunk_type,
        chunk.note_id,
        chunk.text,
        chunk.metadata_json
      );

    const chunkId = Number(info.lastInsertRowid);

    // sqlite-vec requires a Buffer for the vector
    const vecBuf = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );

    this.db
      .prepare(`INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)`)
      .run(chunkId, vecBuf);
  }

  /** Delete all chunks and vectors for a given issue */
  deleteIssueChunks(issueId: number): void {
    // Get chunk IDs first to delete from vec_chunks
    const chunks = this.db
      .prepare(`SELECT id FROM chunks WHERE issue_id = ?`)
      .all(issueId) as Array<{ id: number }>;

    if (chunks.length > 0) {
      const ids = chunks.map((c) => c.id);
      // sqlite-vec doesn't support UPDATE, must delete+reinsert
      for (const id of ids) {
        this.db.prepare(`DELETE FROM vec_chunks WHERE chunk_id = ?`).run(id);
      }
      this.db.prepare(`DELETE FROM chunks WHERE issue_id = ?`).run(issueId);
    }
  }

  /** Delete an issue and all its chunks/vectors */
  deleteIssue(issueId: number): void {
    this.deleteIssueChunks(issueId);
    this.db.prepare(`DELETE FROM issues WHERE id = ?`).run(issueId);
  }

  /** KNN search: find top-k nearest chunks to query vector */
  search(queryEmbedding: Float32Array, limit: number = 10): SearchResult[] {
    const vecBuf = Buffer.from(
      queryEmbedding.buffer,
      queryEmbedding.byteOffset,
      queryEmbedding.byteLength
    );

    const rows = this.db
      .prepare(
        `SELECT
           v.chunk_id,
           v.distance,
           c.issue_id,
           c.chunk_type,
           c.note_id,
           c.text,
           c.metadata_json
         FROM vec_chunks v
         JOIN chunks c ON c.id = v.chunk_id
         WHERE v.embedding MATCH ?
         ORDER BY v.distance
         LIMIT ?`
      )
      .all(vecBuf, limit) as SearchResult[];

    return rows;
  }

  /** Get all stored issue IDs with their updated_at timestamps */
  getStoredIssueTimestamps(): Map<number, string> {
    const rows = this.db
      .prepare(`SELECT id, updated_at FROM issues`)
      .all() as Array<{ id: number; updated_at: string }>;
    return new Map(rows.map((r) => [r.id, r.updated_at]));
  }

  /** Get/set sync metadata */
  getMeta(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM sync_metadata WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_metadata (key, value) VALUES (?, ?)`
      )
      .run(key, value);
  }

  /** Get counts for sync status */
  getCounts(): { issues: number; chunks: number } {
    const issueCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM issues`)
      .get() as { count: number };
    const chunkCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM chunks`)
      .get() as { count: number };
    return { issues: issueCount.count, chunks: chunkCount.count };
  }

  close(): void {
    this.db.close();
    logger.info("Vector store closed.");
  }
}
