import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { Database } from "@open-orpheus/database";
import test from "ava";
import { MusicFile } from "music-tag-native";

import {
  CompletedDownloadContexts,
  finalizeAudioFile,
  metadataForFinalization,
  normalizeDownloadRelativePath,
  readIndexedDownloadInfo,
} from "../src/main/cloudDrive";
import {
  initializeCloudDriveIndex,
  SqliteDownloadMetadataIndex,
} from "../src/main/cloudDriveIndex";
import { ID3JsonToComment } from "../src/main/id3";

class TestDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
  }

  async exec(
    sql: string,
    parameters: unknown[]
  ): Promise<[number, Record<string, unknown>[]]> {
    const statement = this.sqlite.prepare(sql);
    const values = parameters as SQLInputValue[];
    if (sql.trimStart().toUpperCase().startsWith("SELECT")) {
      return [0, statement.all(...values) as Record<string, unknown>[]];
    }
    return [Number(statement.run(...values).changes), []];
  }

  close() {
    this.sqlite.close();
  }
}

function asDatabase(db: TestDatabase): Database {
  return db as unknown as Database;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "open-orpheus-cloud-drive-"));
  const dbPath = join(root, "host.db");
  const db = new TestDatabase(dbPath);
  await initializeCloudDriveIndex(asDatabase(db));
  return {
    root,
    db,
    dbPath,
    index: new SqliteDownloadMetadataIndex(asDatabase(db), root),
  };
}

test("empty mediaInfo finalizes and is found by a restart scan", async (t) => {
  const { root, db, dbPath, index } = await fixture();
  const relativePath = "歌手/现场/曲目.flac";
  const source = join(root, "temporary.flac");
  const finalPath = join(root, relativePath);
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(source, Buffer.from("playable audio bytes"));

  const metadata = metadataForFinalization(
    "",
    "add-id3-task",
    relativePath,
    { tit2: "曲目", tpe1: ["歌手"] },
    {
      id: "download-request-42",
      relPath: "temporary.flac",
      size: 20,
      mediaType: 1,
      type: 0,
      completedAt: Date.now(),
    }
  );
  const finalized = await finalizeAudioFile(source, finalPath, async () => {
    throw new Error("unsupported tags");
  });
  await index.put({
    relativePath,
    metadata,
    size: finalized.size,
    mtimeMs: finalized.mtimeMs,
    contextJson: JSON.stringify({ requestId: "download-request-42" }),
  });

  // A new database/index object represents the next host process.
  const restartedDb = new TestDatabase(dbPath);
  await initializeCloudDriveIndex(asDatabase(restartedDb));
  const scanned = await readIndexedDownloadInfo(
    relativePath,
    root,
    new SqliteDownloadMetadataIndex(asDatabase(restartedDb), root),
    async () => {
      throw new Error("no readable tag");
    }
  );

  t.is(scanned?.comment, metadata);
  t.is(
    JSON.parse(metadata.slice("music:".length)).musicId,
    "download-request-42"
  );
  t.is(scanned?.path, relativePath);
  restartedDb.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("real tag writer embeds scanner-compatible metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-orpheus-real-tag-"));
  const source = join(root, "source.mp3");
  const destination = join(root, "final.mp3");
  const silentMp3 = Buffer.from(
    "/+MYxAAAAANIAAAAAExBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxDsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV/+MYxHYAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV",
    "base64"
  );
  await writeFile(source, silentMp3);
  const metadata = metadataForFinalization(
    "",
    "cloud-track-7",
    "未知歌手 - Verrückt.mp3",
    {}
  );

  const result = await finalizeAudioFile(source, destination, async (dest) => {
    const taggedFile = await MusicFile.load(source);
    taggedFile.comment = ID3JsonToComment(metadata);
    await taggedFile.save(dest);
  });
  const scanned = await readIndexedDownloadInfo(
    "final.mp3",
    root,
    {
      async get() {
        return undefined;
      },
      async put() {},
      async delete() {},
    },
    async (filePath) => (await MusicFile.load(filePath)).comment
  );

  t.true(result.embedded);
  t.is(scanned?.comment, metadata);
  await rm(root, { recursive: true, force: true });
});

test("tag failure preserves the final audio bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "open-orpheus-tag-failure-"));
  const source = join(root, "source.mp3");
  const destination = join(root, "final.mp3");
  const audio = Buffer.from([0, 1, 2, 3, 255, 128]);
  await writeFile(source, audio);

  const result = await finalizeAudioFile(source, destination, async () => {
    await writeFile(destination, "partial tag output");
    throw new Error("save failed");
  });

  t.false(result.embedded);
  t.truthy(result.tagError);
  t.deepEqual(await readFile(destination), audio);
  await rm(root, { recursive: true, force: true });
});

test("embedded scanner metadata takes precedence over the durable index", async (t) => {
  const { root, db, index } = await fixture();
  const relativePath = "nested/song.mp3";
  const finalPath = join(root, relativePath);
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, "audio");
  const embedded = `music:${JSON.stringify({ musicId: "embedded", musicName: "Embedded" })}`;
  const indexed = `music:${JSON.stringify({ musicId: "indexed", musicName: "Indexed" })}`;
  const fileStat = await stat(finalPath);
  await index.put({
    relativePath,
    metadata: indexed,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    contextJson: "{}",
  });

  const scanned = await readIndexedDownloadInfo(
    relativePath,
    root,
    index,
    async () => ID3JsonToComment(embedded)
  );

  t.is(scanned?.comment, embedded);
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("index records are isolated by configured download root", async (t) => {
  const { root, db, index } = await fixture();
  const metadata = `music:${JSON.stringify({ musicId: "root-a", musicName: "Root A" })}`;
  await index.put({
    relativePath: "same-name.mp3",
    metadata,
    size: 1,
    mtimeMs: 1,
    contextJson: "{}",
  });

  const otherRootIndex = new SqliteDownloadMetadataIndex(
    asDatabase(db),
    join(root, "other-download-root")
  );
  t.is(await otherRootIndex.get("same-name.mp3"), undefined);
  t.is((await index.get("same-name.mp3"))?.metadata, metadata);
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("malformed supplied metadata is replaced with scanner-compatible data", (t) => {
  const metadata = metadataForFinalization(
    "music:{}",
    "cloud-42",
    "未知歌手 - Verrückt.mp3",
    {}
  );
  const parsed = JSON.parse(metadata.slice("music:".length));
  t.is(parsed.musicId, "cloud-42");
  t.is(parsed.musicName, "未知歌手 - Verrückt");
});

test("normalizes nested Unicode paths without losing their spelling", (t) => {
  t.is(
    normalizeDownloadRelativePath("音乐\\现场/第一场/../歌曲 🎵.mp3"),
    "音乐/现场/歌曲 🎵.mp3"
  );
  t.is(normalizeDownloadRelativePath("../outside.mp3"), undefined);
  t.is(normalizeDownloadRelativePath("C:\\outside.mp3"), undefined);
});

test("same-size modification invalidates indexed metadata", async (t) => {
  const { root, db, index } = await fixture();
  const relativePath = "changed/song.mp3";
  const finalPath = join(root, relativePath);
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, "audio");
  const fileStat = await stat(finalPath);
  const metadata = `music:${JSON.stringify({ musicId: "old", musicName: "Old" })}`;
  await index.put({
    relativePath,
    metadata,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    contextJson: "{}",
  });

  const changedTime = new Date(fileStat.mtimeMs + 10_000);
  await utimes(finalPath, changedTime, changedTime);
  t.is(
    await readIndexedDownloadInfo(relativePath, root, index, async () => null),
    undefined
  );
  t.is(await index.get(relativePath), undefined);
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("stale size mismatch and deletion remove indexed metadata", async (t) => {
  const { root, db, index } = await fixture();
  const relativePath = "stale/song.mp3";
  const finalPath = join(root, relativePath);
  await mkdir(dirname(finalPath), { recursive: true });
  await writeFile(finalPath, "new audio");
  const metadata = `music:${JSON.stringify({ musicId: "old", musicName: "Old" })}`;
  const originalStat = await stat(finalPath);
  await index.put({
    relativePath,
    metadata,
    size: 999,
    mtimeMs: originalStat.mtimeMs,
    contextJson: "{}",
  });

  t.is(
    await readIndexedDownloadInfo(relativePath, root, index, async () => null),
    undefined
  );
  t.is(await index.get(relativePath), undefined);

  await index.put({
    relativePath,
    metadata,
    size: originalStat.size,
    mtimeMs: originalStat.mtimeMs,
    contextJson: "{}",
  });
  await rm(finalPath);
  t.is(
    await readIndexedDownloadInfo(relativePath, root, index, async () => null),
    undefined
  );
  t.is(await index.get(relativePath), undefined);
  db.close();
  await rm(root, { recursive: true, force: true });
});

test("completed download correlation is normalized, bounded, and expires", (t) => {
  let now = 1_000;
  const contexts = new CompletedDownloadContexts(2, 100, () => now);
  const add = (path: string, id: string) =>
    contexts.set(path, {
      id,
      relPath: `${id}.mp3`,
      size: 1,
      mediaType: 1,
      type: 0,
    });

  add("tmp/a/../one.mp3", "one");
  add("tmp/two.mp3", "two");
  add("tmp/three.mp3", "three");
  t.is(contexts.get("tmp/one.mp3"), undefined);
  t.is(contexts.get("tmp/two.mp3")?.id, "two");
  contexts.delete("tmp/two.mp3");
  t.is(contexts.get("tmp/two.mp3"), undefined);

  add("tmp/four.mp3", "four");
  now += 101;
  t.is(contexts.get("tmp/four.mp3"), undefined);
});
