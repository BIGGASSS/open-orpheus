import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext, Script } from "node:vm";
import test from "ava";
import { patchPlaylistCache } from "../src/main/compat/playlistCachePatch";
import {
  installPlaylistCachePersistence,
  type PlaylistSnapshot,
} from "../src/main/compat/playlistCacheRuntime";

class Store {
  db = new DatabaseSync(":memory:");
  failWrites = false;
  failReservation = false;
  loseReservationResponse = false;
  async execSql(sql: string | string[], transaction = false) {
    const text = Array.isArray(sql) ? sql.join("") : sql;
    if (!transaction)
      return {
        error: 0,
        value: this.db
          .prepare(text)
          .all()
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [k, String(v)])
            )
          ),
      };
    this.db.exec("BEGIN");
    try {
      this.db.exec(text);
      if (
        (this.failWrites && text.includes("INSERT OR REPLACE INTO dbTrack")) ||
        (this.failReservation &&
          text.includes("INSERT OR IGNORE INTO playlistCacheEvents"))
      )
        throw new Error("injected");
      this.db.exec("COMMIT");
      if (
        this.loseReservationResponse &&
        text.includes("INSERT OR IGNORE INTO playlistCacheEvents")
      )
        return { error: 1, value: null };
      return { error: 0, value: [] };
    } catch {
      this.db.exec("ROLLBACK");
      return { error: 1, value: null };
    }
  }
  read(table: string, id: string) {
    const row = this.db
      .prepare(`SELECT jsonStr FROM ${table} WHERE id = ?`)
      .get(id);
    return row && JSON.parse(row.jsonStr as string);
  }
}
function fixture(store: Store, previous?: () => Promise<void>) {
  const timers = new Map<number, () => void>();
  let counter = 0;
  const context = {
    setTimeout: (fn: () => void) => {
      timers.set(++counter, fn);
      return counter;
    },
    clearTimeout: (id: number) => timers.delete(id),
    __openOrpheusFlushRequestCache: previous,
  };
  const install = runInNewContext(
    `(${installPlaylistCachePersistence.toString()})`,
    context
  ) as typeof installPlaylistCachePersistence;
  const errors: unknown[] = [];
  return {
    cache: install(store, (error) => errors.push(error)),
    context,
    timers,
    errors,
  };
}
const snapshot = (ids = ["b", "a"], updateTime = 1): PlaylistSnapshot => ({
  id: "p",
  updateTime,
  trackIds: ids.map((id) => ({ id, v: 0 })),
  tracks: ids.map((id) => ({ id, name: id + "'s track" })),
});

test("atomic snapshots replace order/deletions even at lower or equal timestamps", async (t) => {
  const store = new Store();
  const { cache } = fixture(store);
  await cache.upsertTrackIds(snapshot(["a", "b", "c"], Date.now()));
  for (const timestamp of [1, 1]) {
    await cache.upsertTrackIds(snapshot(["b", "a"], timestamp));
    t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
      { id: "b", v: 0 },
      { id: "a", v: 0 },
    ]);
    t.is(store.read("dbTrack", "a").name, "a's track");
  }
  await cache.upsertTrackIds(snapshot([]));
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, []);
  await cache.upsertTracks({ tracks: [{ id: "page", name: "pagination" }] });
  t.is(store.read("dbTrack", "page").name, "pagination");
});

test("failed checked transaction retains immutable pending data for retry and shutdown", async (t) => {
  const store = new Store();
  let chained = 0;
  const f = fixture(store, async () => {
    chained++;
  });
  await f.cache.upsertTrackIds(snapshot(["old"]));
  store.failWrites = true;
  const next = snapshot(["new"]);
  const promise = f.cache.upsertTrackIds(next);
  next.trackIds.length = 0;
  next.tracks![0].name = "mutated";
  await t.throwsAsync(promise);
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
    { id: "old", v: 0 },
  ]);
  t.is(store.read("dbTrack", "new"), undefined);
  await t.throwsAsync(f.context.__openOrpheusFlushRequestCache!());
  store.failWrites = false;
  await f.context.__openOrpheusFlushRequestCache!();
  t.is(chained, 2);
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
    { id: "new", v: 0 },
  ]);
  t.is(store.read("dbTrack", "new").name, "new's track");
  t.is(f.timers.size, 0);
});

test("two renderers: older failed retry cannot resurrect deleted IDs or overwrite tracks", async (t) => {
  const store = new Store();
  const a = fixture(store),
    b = fixture(store);
  store.failWrites = true;
  await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["old"])));
  store.failWrites = false;
  await b.cache.upsertTrackIds(snapshot([]));
  await a.context.__openOrpheusFlushRequestCache!();
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, []);
  t.is(store.read("dbTrack", "old"), undefined);
});

test("reservation failure retains queue but cannot acquire newer retry authority", async (t) => {
  const store = new Store();
  const a = fixture(store),
    b = fixture(store);
  store.failReservation = true;
  await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["old"])));
  store.failReservation = false;
  // The failed transaction may also have rolled back schema creation.
  await t.throwsAsync(a.cache.flush(), {
    message: /Refresh the playlist online again/,
  });
  await b.cache.upsertTrackIds(snapshot([]));
  await t.throwsAsync(a.cache.flush(), {
    message: /Refresh the playlist online again/,
  });
  await t.throwsAsync(a.context.__openOrpheusFlushRequestCache!());
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, []);
  t.is(store.read("dbTrack", "old"), undefined);
});

test("unknown ordering stays rejected until a fresh ordered snapshot covers every key", async (t) => {
  const store = new Store();
  const f = fixture(store);
  await f.cache.upsertTrackIds(snapshot(["old"]));
  store.failReservation = true;
  await t.throwsAsync(f.cache.upsertTrackIds(snapshot(["new"])));
  store.failReservation = false;
  await t.throwsAsync(f.cache.flush(), {
    message: /Refresh the playlist online again/,
  });
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
    { id: "old", v: 0 },
  ]);
  // Neither another playlist nor a deletion covering only the playlist row
  // acknowledges a discarded track write with unknown ordering.
  await t.throwsAsync(
    f.cache.upsertTrackIds({ ...snapshot(["new"]), id: "other" })
  );
  await t.throwsAsync(f.cache.upsertTrackIds(snapshot([])));
  const fresh = snapshot(["new"]);
  fresh.tracks![0].name = "fresh";
  await f.cache.upsertTrackIds(fresh);
  await f.context.__openOrpheusFlushRequestCache!();
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, fresh.trackIds);
  t.is(store.read("dbTrack", "new").name, "fresh");
});

test("lost reservation response recovers the same nonce without newer authority", async (t) => {
  for (const newer of [false, true]) {
    const store = new Store();
    const a = fixture(store),
      b = fixture(store);
    store.loseReservationResponse = true;
    await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["old"])));
    store.loseReservationResponse = false;
    if (newer) await b.cache.upsertTrackIds(snapshot([]));
    await a.cache.flush();
    t.deepEqual(
      store.read("playlistTrackIds", "p").trackIds,
      newer ? [] : [{ id: "old", v: 0 }]
    );
    t.is(
      store.db
        .prepare(
          "SELECT seq FROM sqlite_sequence WHERE name = 'playlistCacheEvents'"
        )
        .get()!.seq,
      newer ? 2 : 1
    );
  }
});

test("an unsequenced retry cannot block a valid ticket still pending in another renderer", async (t) => {
  const store = new Store();
  const a = fixture(store),
    b = fixture(store);
  store.failReservation = true;
  await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["old"])));
  store.failReservation = false;
  store.failWrites = true;
  await t.throwsAsync(b.cache.upsertTrackIds(snapshot(["new"])));
  store.failWrites = false;
  await t.throwsAsync(a.cache.flush(), {
    message: /Refresh the playlist online again/,
  });
  await b.cache.flush();
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
    { id: "new", v: 0 },
  ]);
});

test("snapshots queued behind failures reserve ordering before another renderer writes", async (t) => {
  const store = new Store();
  const a = fixture(store),
    b = fixture(store);
  store.failWrites = true;
  await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["first"])));
  await t.throwsAsync(a.cache.upsertTrackIds(snapshot(["second"])));
  store.failWrites = false;
  await b.cache.upsertTrackIds(snapshot([]));
  await a.cache.flush();
  t.deepEqual(store.read("playlistTrackIds", "p").trackIds, []);
  t.is(store.read("dbTrack", "second"), undefined);
});

test("retry timer and a rejecting previous shutdown barrier still drain playlist queue", async (t) => {
  const store = new Store();
  const f = fixture(store, async () => {
    throw new Error("other cache");
  });
  store.failWrites = true;
  await t.throwsAsync(f.cache.upsertTrackIds(snapshot()));
  store.failWrites = false;
  [...f.timers.values()][0]();
  await f.cache.flush();
  t.deepEqual(
    store.read("playlistTrackIds", "p").trackIds,
    snapshot().trackIds
  );
  await t.throwsAsync(f.context.__openOrpheusFlushRequestCache!(), {
    message: "other cache",
  });
});

const archive = "data/package/package/orpheus.ntpk";
function archiveScript(name: string) {
  return execFileSync(
    "python3",
    [
      "-c",
      'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read(next(p for p in z.namelist() if p.startswith("pub/hybrid/"+sys.argv[2]+".chunk."))).decode(),end="")',
      archive,
      name,
    ],
    { maxBuffer: 30 * 1024 * 1024 }
  ).toString();
}

test("unrelated scripts untouched; changed known modules refuse compatibility", (t) => {
  const unrelated = 'const value="playlistTrackIds";';
  t.is(patchPlaylistCache(unrelated), unrelated);
  t.throws(
    () => patchPlaylistCache("(this.webpackJsonp=[]).push([[137],{}]);"),
    { message: /Unsupported frontend playlist/ }
  );
  t.throws(
    () => patchPlaylistCache('const o="playlistTrackIds",a=async()=>{};'),
    { message: /Unsupported frontend playlist/ }
  );
});

(existsSync(archive) ? test : test.skip)(
  "actual archive patches parse; initial-refresh generators persist merged snapshots before UI",
  async (t) => {
    for (const name of ["app", "subApp", "137", "142"]) {
      const original = archiveScript(name);
      const patched = patchPlaylistCache(original);
      t.not(patched, original);
      t.notThrows(() => new Script(patched));
      t.is(patchPlaylistCache(patched), patched);
      if (name === "app" || name === "subApp") {
        const start = original.indexOf(
          'n.d(t,"a",(function(){return o})),n.d(t,"d",(function(){return a}))'
        );
        const end = original.indexOf("},function(", start);
        // Minimal webpack module fixture: only the helper, no application boot.
        const helper = original.slice(start, end);
        const store = new Store();
        const f = fixture(store);
        const exports: Record<string, unknown> = {};
        const require = Object.assign(
          () => ({ Database: store, b: { warn() {} } }),
          {
            d: (
              target: Record<string, unknown>,
              key: string,
              get: () => unknown
            ) => Object.defineProperty(target, key, { get }),
          }
        );
        runInNewContext(patchPlaylistCache(helper), {
          ...f.context,
          t: exports,
          n: require,
        });
        await (exports.d as (s: PlaylistSnapshot) => Promise<void>)(snapshot());
        t.deepEqual(
          store.read("playlistTrackIds", "p").trackIds,
          snapshot().trackIds
        );
        t.throws(() =>
          patchPlaylistCache(
            original.replace("rows:[{id:t,trackIds:n,updateTime:r}]", "rows:[]")
          )
        );
        continue;
      }
      const start = patched.indexOf("requestPlaylistDetail(");
      const end = patched.indexOf(
        name === "137"
          ? ",requestPlaylistTracksDetail("
          : ",requestYearlyRankData(",
        start
      );
      const method = patched.slice(start, end);
      for (const failPersistence of [false, true]) {
        for (const storedTime of [1, Date.now()]) {
          const store = new Store();
          const f = fixture(store);
          await f.cache.upsertTrackIds(snapshot(["stale"]));
          store.failWrites = failPersistence;
          const local = { id: "local", v: -1 };
          const helper = {
            b: async () => ({ trackIds: [local], updateTime: storedTime }),
            c: async () => [{ id: "local" }],
            d: f.cache.upsertTrackIds,
            e: () => {
              throw new Error("duplicate write");
            },
          };
          const response = async () => ({
            playlist: {
              id: "p",
              updateTime: 1,
              trackIds: [{ id: "server", v: 0 }],
            },
            tracks: [{ id: "server" }],
          });
          const api = { b: response, e: async () => ({}) };
          const context =
            name === "137"
              ? {
                  s: { b: () => true },
                  a: api,
                  v: { b: {} },
                  c: helper,
                  m: Object.assign,
                  y: { a: { getDispatch: () => () => {} } },
                }
              : {
                  m: { b: () => true },
                  b: response,
                  g: { b: {} },
                  y: helper,
                  k: Object.assign,
                  d: async () => ({}),
                };
          const model = runInNewContext("({" + method + "})", context);
          const actions: string[] = [];
          const effects = {
            call: (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
            select: () => ({ starPlaylistId: "other", likeTrackIds: [] }),
            put: (action: { type: string; payload: unknown }) => {
              actions.push(action.type);
              if (action.type === "setTracks") {
                t.true(JSON.stringify(action.payload).includes("server"));
                t.false(JSON.stringify(action.payload).includes("stale"));
              }
              if (
                !failPersistence &&
                (action.type === "setTracks" || action.type === "setItem")
              ) {
                t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
                  local,
                  { id: "server", v: 0 },
                ]);
                t.truthy(store.read("dbTrack", "server"));
              }
            },
          };
          const iterator = model.requestPlaylistDetail(
            { payload: { id: "p", isOwn: true } },
            effects
          );
          let step = iterator.next();
          let injected = 0;
          while (!step.done) {
            let value;
            try {
              value = await step.value;
            } catch (error) {
              injected++;
              step = iterator.throw(error);
              continue;
            }
            step = iterator.next(value);
          }
          t.is(injected, failPersistence ? 1 : 0);
          t.is(step.value, undefined);
          t.true(actions.includes("setTracks"));
          if (failPersistence) {
            t.true(f.errors.length > 0);
            await t.throwsAsync(f.cache.flush());
            await t.throwsAsync(f.context.__openOrpheusFlushRequestCache!());
            t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
              { id: "stale", v: 0 },
            ]);
            store.failWrites = false;
            await f.cache.flush();
            t.deepEqual(store.read("playlistTrackIds", "p").trackIds, [
              local,
              { id: "server", v: 0 },
            ]);
            t.truthy(store.read("dbTrack", "server"));
          }
        }
      }
    }
  }
);
