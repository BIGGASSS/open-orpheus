import type { Stats } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from "node:path";

import { commentToID3Json } from "./id3";

export type DownloadIdentity = {
  id: string;
  relPath: string;
  size: number;
  md5?: string;
  mediaType: number;
  type: number;
  completedAt: number;
};

export type CloudDriveTagFields = {
  talb?: string;
  tit2?: string;
  tpe1?: string | string[];
  tpos?: string;
  trck?: string;
};

export type DownloadIndexEntry = {
  relativePath: string;
  metadata: string;
  size: number;
  mtimeMs: number;
  contextJson: string;
};

export interface DownloadMetadataIndex {
  get(relativePath: string): Promise<DownloadIndexEntry | undefined>;
  put(entry: DownloadIndexEntry): Promise<void>;
  delete(relativePath: string): Promise<void>;
}

const CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_CONTEXTS = 512;

function mediaPathKey(mediaPath: string): string {
  const key = resolve(mediaPath.replaceAll("\\", "/"));
  return process.platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
}

/** Short-lived correlation between download.start and storage.addid3. */
export class CompletedDownloadContexts {
  private readonly entries = new Map<string, DownloadIdentity>();

  constructor(
    private readonly maxEntries = MAX_CONTEXTS,
    private readonly ttlMs = CONTEXT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  set(mediaPath: string, context: Omit<DownloadIdentity, "completedAt">) {
    this.prune();
    const key = mediaPathKey(mediaPath);
    this.entries.delete(key);
    this.entries.set(key, { ...context, completedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get(mediaPath: string): DownloadIdentity | undefined {
    this.prune();
    return this.entries.get(mediaPathKey(mediaPath));
  }

  delete(mediaPath: string) {
    this.entries.delete(mediaPathKey(mediaPath));
  }

  private prune() {
    const oldestAllowed = this.now() - this.ttlMs;
    for (const [key, context] of this.entries) {
      if (context.completedAt >= oldestAllowed) continue;
      this.entries.delete(key);
    }
  }
}

export const completedDownloadContexts = new CompletedDownloadContexts();

/** Canonical, platform-independent key used for a path below the download root. */
export function normalizeDownloadRelativePath(
  path: string
): string | undefined {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return;
  const normalized = normalize(path.replaceAll("\\", "/")).replaceAll(
    "\\",
    "/"
  );
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return;
  }
  return normalized.replace(/^\.\//, "");
}

export function indexKeyForFile(
  downloadRoot: string,
  filePath: string
): string | undefined {
  const root = resolve(downloadRoot);
  const file = resolve(filePath);
  const relPath = relative(root, file);
  return normalizeDownloadRelativePath(relPath);
}

export function isScannerMetadata(
  value: string | null | undefined
): value is string {
  if (!value?.startsWith("music:")) return false;
  try {
    const parsed: unknown = JSON.parse(value.slice("music:".length));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return false;
    const metadata = parsed as Record<string, unknown>;
    return (
      (typeof metadata.musicId === "string" ||
        typeof metadata.musicId === "number") &&
      typeof metadata.musicName === "string"
    );
  } catch {
    return false;
  }
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * Produce the raw `music:...` value expected by the Cloud Drive scanner.
 * Correlated request/task identity is retained verbatim rather than guessed from a URL.
 */
export function synthesizeScannerMetadata(
  taskId: string,
  relativePath: string,
  fields: CloudDriveTagFields,
  context?: DownloadIdentity
): string {
  const fileName = basename(relativePath, extname(relativePath));
  const artists = Array.isArray(fields.tpe1)
    ? fields.tpe1
    : fields.tpe1
      ? [fields.tpe1]
      : [];
  const identity = context?.id || taskId;
  const payload = {
    musicId: identity,
    musicName: fields.tit2 || fileName || identity,
    artist: artists.map((artist) => [artist, ""]),
    albumId: "",
    album: fields.talb || "",
    albumPicDocId: "",
    albumPic: "",
    bitrate: 0,
    mp3DocId: context?.md5 || identity,
    duration: 0,
    mvId: "0",
    alias: [],
    transNames: [],
    format: extname(relativePath).slice(1).toLowerCase(),
    fee: 0,
    volumeDelta: 0,
    privilege: { flag: 0 },
    _openOrpheus: {
      downloadRequestId: context?.id,
      addId3TaskId: taskId,
      requestedRelativePath: context?.relPath,
      requestedSize: context?.size,
      mediaType: context?.mediaType,
      downloadType: context?.type,
      artistFallback: first(fields.tpe1),
    },
  };
  return `music:${JSON.stringify(payload)}`;
}

export function metadataForFinalization(
  supplied: string,
  taskId: string,
  relativePath: string,
  fields: CloudDriveTagFields,
  context?: DownloadIdentity
): string {
  return isScannerMetadata(supplied)
    ? supplied
    : synthesizeScannerMetadata(taskId, relativePath, fields, context);
}

export type FinalizeAudioResult = {
  embedded: boolean;
  tagError?: unknown;
  size: number;
  mtimeMs: number;
};

/** Save a tagged file, falling back to a byte-for-byte copy on any tag failure. */
export async function finalizeAudioFile(
  sourcePath: string,
  finalPath: string,
  embed: (finalPath: string) => Promise<void>
): Promise<FinalizeAudioResult> {
  try {
    await embed(finalPath);
    const fileStat = await stat(finalPath);
    return {
      embedded: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (tagError) {
    await copyFile(sourcePath, finalPath);
    const fileStat = await stat(finalPath);
    return {
      embedded: false,
      tagError,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }
}

export type ScannedDownloadInfo = {
  comment: string;
  creation_time: number;
  last_accessed: number;
  last_modified: number;
  path: string;
  size: number;
};

/** Embedded metadata wins; a file-identity-checked durable record handles untaggable files. */
export async function readIndexedDownloadInfo(
  file: string,
  base: string,
  index: DownloadMetadataIndex,
  readEmbeddedComment: (filePath: string) => Promise<string | null>
): Promise<ScannedDownloadInfo | undefined> {
  const relativePath = normalizeDownloadRelativePath(file);
  if (!relativePath) return;
  const filePath = resolve(base, relativePath);
  let fileStat: Stats;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await index.delete(relativePath);
      return;
    }
    throw error;
  }

  try {
    const embedded = commentToID3Json(await readEmbeddedComment(filePath));
    if (isScannerMetadata(embedded)) {
      return scanInfo(relativePath, embedded, fileStat);
    }
  } catch {
    // Tag readers can reject otherwise playable files. Try the host index.
  }

  const indexed = await index.get(relativePath);
  if (!indexed) return;
  if (
    indexed.size !== fileStat.size ||
    indexed.mtimeMs !== fileStat.mtimeMs ||
    !isScannerMetadata(indexed.metadata)
  ) {
    await index.delete(relativePath);
    return;
  }
  return scanInfo(relativePath, indexed.metadata, fileStat);
}

function scanInfo(
  path: string,
  comment: string,
  fileStat: Stats
): ScannedDownloadInfo {
  return {
    comment,
    creation_time: Number(fileStat.birthtimeMs),
    last_accessed: Number(fileStat.atimeMs),
    last_modified: Number(fileStat.mtimeMs),
    path,
    size: Number(fileStat.size),
  };
}
