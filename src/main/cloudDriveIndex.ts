import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { Database } from "@open-orpheus/database";

import type { DownloadIndexEntry, DownloadMetadataIndex } from "./cloudDrive";
import { normalizeDownloadRelativePath } from "./cloudDrive";

const TABLE = "cloud_drive_download_index";

function filesystemKey(relativePath: string): string {
  return process.platform === "win32"
    ? relativePath.toLocaleLowerCase("en-US")
    : relativePath;
}

export async function initializeCloudDriveIndex(db: Database): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
      root_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      metadata TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime REAL NOT NULL,
      context_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (root_id, relative_path)
    )`,
    []
  );
}

/** Durable host-side metadata for audio files whose tags cannot be read. */
export class SqliteDownloadMetadataIndex implements DownloadMetadataIndex {
  private readonly rootId: string;

  constructor(
    private readonly db: Database,
    downloadRoot: string
  ) {
    const normalizedRoot = resolve(downloadRoot);
    const filesystemRoot =
      process.platform === "win32"
        ? normalizedRoot.toLocaleLowerCase("en-US")
        : normalizedRoot;
    this.rootId = createHash("sha256").update(filesystemRoot).digest("hex");
  }

  async get(relativePath: string): Promise<DownloadIndexEntry | undefined> {
    const normalized = normalizeDownloadRelativePath(relativePath);
    if (!normalized) return;
    const key = filesystemKey(normalized);
    const [, rows] = await this.db.exec(
      `SELECT relative_path, metadata, file_size, file_mtime, context_json
       FROM ${TABLE} WHERE root_id = ? AND relative_path = ?`,
      [this.rootId, key]
    );
    const row = rows[0];
    if (!row) return;
    return {
      relativePath: String(row.relative_path),
      metadata: String(row.metadata),
      size: Number(row.file_size),
      mtimeMs: Number(row.file_mtime),
      contextJson: String(row.context_json),
    };
  }

  async put(entry: DownloadIndexEntry): Promise<void> {
    const normalized = normalizeDownloadRelativePath(entry.relativePath);
    if (!normalized)
      throw new Error(`Invalid download index path: ${entry.relativePath}`);
    const key = filesystemKey(normalized);
    await this.db.exec(
      `INSERT INTO ${TABLE}
        (root_id, relative_path, metadata, file_size, file_mtime, context_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_id, relative_path) DO UPDATE SET
        metadata = excluded.metadata,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        context_json = excluded.context_json,
        updated_at = excluded.updated_at`,
      [
        this.rootId,
        key,
        entry.metadata,
        entry.size,
        entry.mtimeMs,
        entry.contextJson,
        Date.now(),
      ]
    );
  }

  async delete(relativePath: string): Promise<void> {
    const normalized = normalizeDownloadRelativePath(relativePath);
    if (!normalized) return;
    const key = filesystemKey(normalized);
    await this.db.exec(
      `DELETE FROM ${TABLE} WHERE root_id = ? AND relative_path = ?`,
      [this.rootId, key]
    );
  }
}
