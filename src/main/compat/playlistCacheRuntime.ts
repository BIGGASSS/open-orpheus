export interface PlaylistCacheDatabase {
  execSql(
    sql: string | string[],
    transaction?: boolean
  ): Promise<{ error: number; value: unknown }>;
}
export interface PlaylistSnapshot {
  id: string | number;
  trackIds: unknown[];
  updateTime?: number;
  tracks?: { id: string | number; [key: string]: unknown }[];
}

/** Self-contained: serialized into the frontend, never written into the archive. */
export function installPlaylistCachePersistence(
  database: PlaylistCacheDatabase,
  report: (error: unknown) => void
) {
  const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  type Row = { table: string; id: string; json: string };
  type Pending = {
    rows: Row[];
    playlist?: string;
    nonce: string;
    ticket?: number;
    uncertain: boolean;
    reservation?: Promise<void>;
  };
  const pending: Pending[] = [];
  const prefix = Date.now() + ":" + Math.random() + ":" + Math.random();
  let counter = 0;
  let flushing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schema = [
    // Matches the inspected webdb.dat Database.put envelope.
    "CREATE TABLE IF NOT EXISTS playlistTrackIds (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);",
    "CREATE TABLE IF NOT EXISTS dbTrack (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);",
    "CREATE TABLE IF NOT EXISTS playlistCacheEvents (ticket INTEGER PRIMARY KEY AUTOINCREMENT, nonce TEXT UNIQUE NOT NULL);",
    "CREATE TABLE IF NOT EXISTS playlistCacheOrder (key TEXT PRIMARY KEY, ticket INTEGER NOT NULL);",
  ];
  async function execute(sql: string[]) {
    const result = await database.execSql(sql, true);
    if (!result || result.error !== 0)
      throw new Error(`Playlist cache transaction failed: ${result?.error}`);
  }
  const key = (row: Row) => row.table + ":" + row.id;
  const allowed = (key: string, ticket: number) =>
    `NOT EXISTS (SELECT 1 FROM playlistCacheOrder WHERE key = ${quote(key)} AND ticket > ${ticket})`;
  const unresolved = () =>
    new Error(
      "Refresh the playlist online again before saving or quitting: playlist cache ordering could not be established."
    );

  async function drain() {
    try {
      for (const item of [...pending]) {
        if (item.reservation) {
          const reservation = item.reservation;
          item.reservation = undefined;
          await reservation;
        }
        // Never allocate again after an ambiguous failure: only the original
        // nonce can prove receipt ordering (including a lost commit response).
        if (item.ticket === undefined) {
          let result;
          try {
            result = await database.execSql(
              `select ticket from playlistCacheEvents WHERE nonce = ${quote(item.nonce)};`
            );
          } catch (error) {
            if (item.uncertain) continue;
            throw error;
          }
          const ticket = Number(
            (result?.value as { ticket: string }[])?.[0]?.ticket
          );
          if (result?.error !== 0) {
            if (item.uncertain) continue;
            throw new Error("Playlist cache ticket query failed");
          }
          if (!Number.isSafeInteger(ticket) || ticket <= 0) {
            if (item.uncertain) continue;
            throw new Error("Playlist cache ticket query failed");
          }
          item.ticket = ticket;
          item.uncertain = false;
        }
        const ticket = item.ticket;
        const guard = item.playlist ? allowed(item.playlist, ticket) : "1";
        const sql: string[] = [];
        // Tracks first, playlist last: all guards see the previous high water.
        for (const row of item.rows) {
          const accept = `${guard} AND ${allowed(key(row), ticket)}`;
          sql.push(
            `INSERT OR REPLACE INTO ${row.table} (id, jsonStr) SELECT ${quote(row.id)}, ${quote(row.json)} WHERE ${accept};`,
            `INSERT OR REPLACE INTO playlistCacheOrder (key, ticket) SELECT ${quote(key(row))}, ${ticket} WHERE ${accept};`
          );
        }
        sql.push(
          `DELETE FROM playlistCacheEvents WHERE nonce = ${quote(item.nonce)};`
        );
        await execute(sql);
        // Only a later same-renderer, successfully ordered snapshot covering
        // EVERY key may replace unresolved data. A playlist deletion alone
        // does not cover its old track rows. Other renderers cannot resolve an
        // unknown receipt order merely by having a high-water mark.
        const covered = new Set(item.rows.map(key));
        const index = pending.indexOf(item);
        for (let i = index - 1; i >= 0; i--) {
          const older = pending[i];
          if (
            older.uncertain &&
            older.playlist === item.playlist &&
            older.rows.every((row) => covered.has(key(row)))
          )
            pending.splice(i, 1);
        }
        pending.splice(pending.indexOf(item), 1);
      }
      if (pending.length) throw unresolved();
    } finally {
      flushing = undefined;
    }
  }
  function flush(): Promise<void> {
    if (flushing) return flushing;
    clearTimeout(timer);
    timer = undefined;
    flushing = Promise.resolve().then(drain);
    void flushing.catch((error) => {
      report(error);
      timer = setTimeout(() => {
        void flush();
      }, 1000);
    });
    return flushing;
  }
  async function reserve(item: Pending) {
    try {
      await execute([
        ...schema,
        `INSERT OR IGNORE INTO playlistCacheEvents (nonce) VALUES (${quote(item.nonce)});`,
      ]);
    } catch (error) {
      // Keep the nonce for recovery, but never manufacture retry authority.
      item.uncertain = true;
      throw error;
    }
  }
  function enqueue(
    snapshot:
      PlaylistSnapshot | { tracks: NonNullable<PlaylistSnapshot["tracks"]> }
  ) {
    // Snapshot and enqueue BEFORE any await, even if the caller catches failure.
    const rows: Row[] = (snapshot.tracks ?? []).map((track) => ({
      table: "dbTrack",
      id: String(track.id),
      json: JSON.stringify(track),
    }));
    let playlist: string | undefined;
    if ("id" in snapshot) {
      const row = {
        table: "playlistTrackIds",
        id: String(snapshot.id),
        json: JSON.stringify({
          id: snapshot.id,
          trackIds: snapshot.trackIds,
          updateTime: snapshot.updateTime,
        }),
      };
      rows.push(row);
      playlist = key(row);
    }
    const item: Pending = {
      rows,
      playlist,
      nonce: prefix + ":" + ++counter,
      uncertain: false,
    };
    pending.push(item);
    // Submit the ordering event at receipt, not when a failed queue drains.
    item.reservation = reserve(item);
    void item.reservation.catch(() => {});
    return flush();
  }
  const host = globalThis as typeof globalThis & {
    __openOrpheusFlushRequestCache?: () => Promise<void>;
  };
  const previous = host.__openOrpheusFlushRequestCache;
  host.__openOrpheusFlushRequestCache = async () => {
    // Attempt both queues even when the earlier shutdown barrier rejects.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => previous?.()),
      flush(),
    ]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  return { upsertTrackIds: enqueue, upsertTracks: enqueue, flush };
}
