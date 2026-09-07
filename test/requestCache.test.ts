import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";

import test from "ava";

import { patchRequestCache } from "../src/main/compat/requestCachePatch";
import {
  installRequestCachePersistence,
  type RequestCacheDatabase,
  type RequestCacheOptions,
  type RequestCacheState,
} from "../src/main/compat/requestCacheRuntime";

const key = JSON.stringify({ url: "/api/playlist/detail", uid: "user-1" });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class Store implements RequestCacheDatabase {
  sqlite: DatabaseSync;
  beforeCommit?: () => Promise<void>;
  fail = false;
  transactions = 0;

  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS requestCache (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);"
    );
  }

  async execSql(sql: string | string[], transaction = false) {
    if (typeof sql === "string" && sql.startsWith("select")) {
      return { error: 0, value: this.sqlite.prepare(sql).all() };
    }
    if (!transaction) throw new Error("Expected an atomic cache transaction");
    this.transactions++;
    this.sqlite.exec("BEGIN;");
    try {
      this.sqlite.exec(Array.isArray(sql) ? sql.join("") : sql);
      await this.beforeCommit?.();
      if (this.fail) throw new Error("injected commit failure");
      this.sqlite.exec("COMMIT;");
      return { error: 0, value: [] };
    } catch {
      this.sqlite.exec("ROLLBACK;");
      // The real frontend SDK resolves an error object instead of rejecting.
      return { error: 1, value: null };
    }
  }

  seed(cacheKey: string, version: number, value: unknown) {
    const id = cacheKey + "-" + version;
    this.sqlite
      .prepare("INSERT INTO requestCache VALUES (?, ?)")
      .run(id, JSON.stringify({ id, cache: JSON.stringify(value) }));
  }

  read(cacheKey: string, version: number) {
    const row = this.sqlite
      .prepare("SELECT jsonStr FROM requestCache WHERE id = ?")
      .get(cacheKey + "-" + version);
    // Same two-level deserialization as Database.get -> getCacheResultByKey.
    return row
      ? JSON.parse(JSON.parse(row.jsonStr as string).cache)
      : undefined;
  }
}

function fixture(
  store: Store,
  limits = { maxCacheCountInLocal: 5000, overCleanPercentInLocal: 0.25 }
) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const errors: unknown[] = [];
  const context = {
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    __openOrpheusFlushRequestCache: undefined as
      undefined | (() => Promise<void>),
  };
  const cache: RequestCacheState = {
    cachedKeys: new Map(),
    runtimeCacheMap: new Map(),
    toBeCleanCacheMap: new Map(),
    initPromise: Promise.resolve(),
    tryToFlushCacheToStore: async () => {},
    invalidateCache: async () => {},
    updateToBeCleanCacheMap: () => {},
  };
  const options: RequestCacheOptions = {
    limits: () => limits,
    uid: () => "user-1",
    report: (error) => errors.push(error),
  };
  // Exercise the actual serialized form used in the served bundle, in an
  // isolated renderer realm. No Node/import bindings are available there.
  runInNewContext(`(${installRequestCachePersistence.toString()})`, context)(
    cache,
    store,
    options
  );
  const update = (version: number, value: unknown, cacheKey = key) => {
    cache.updateToBeCleanCacheMap(cacheKey);
    cache.cachedKeys.set(cacheKey, version);
    cache.runtimeCacheMap.set(cacheKey, value);
  };
  return { cache, update, context, errors, timers };
}

test("a single synced response is persisted without idle time and survives reopening", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orpheus-request-cache-"));
  const path = join(root, "webdb.dat");
  const store = new Store(path);
  try {
    const { cache, update } = fixture(store);
    const songs = { code: 200, songs: ["added", "歌手's song", "reordered"] };
    update(1, songs);
    await cache.tryToFlushCacheToStore();
    t.is(cache.runtimeCacheMap.size, 0);
    const reopened = new Store(path);
    try {
      t.deepEqual(reopened.read(key, 1), songs);
    } finally {
      reopened.sqlite.close();
    }
    update(2, { code: 200, songs: [] });
    await cache.tryToFlushCacheToStore(true);
    t.deepEqual(store.read(key, 2), { code: 200, songs: [] });
    t.is(store.read(key, 1), undefined);
  } finally {
    store.sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("forced flush and shutdown hook wait for COMMIT, retaining pending data meanwhile", async (t) => {
  const store = new Store();
  const { cache, update, context } = fixture(store);
  const started = deferred();
  const release = deferred();
  store.beforeCommit = async () => {
    started.resolve();
    await release.promise;
  };
  update(1, { songs: ["latest"] });
  let acknowledged = false;
  const flush = context.__openOrpheusFlushRequestCache!().then(() => {
    acknowledged = true;
  });
  await started.promise;
  t.false(acknowledged);
  t.is(cache.runtimeCacheMap.size, 1);
  release.resolve();
  await flush;
  t.true(acknowledged);
  t.is(cache.runtimeCacheMap.size, 0);
  t.deepEqual(store.read(key, 1), { songs: ["latest"] });
  store.sqlite.close();
});

test("failed transactions retain the previous snapshot and pending replacements for retry", async (t) => {
  const store = new Store();
  store.seed(key, 1, { songs: ["old"] });
  const { cache, update, errors, timers } = fixture(store);
  cache.cachedKeys.set(key, 1);
  update(2, { songs: ["new"] });
  store.fail = true;
  await t.throwsAsync(cache.tryToFlushCacheToStore(true), {
    message: /transaction failed/,
  });
  t.deepEqual(store.read(key, 1), { songs: ["old"] });
  t.is(store.read(key, 2), undefined);
  t.is(cache.runtimeCacheMap.size, 1);
  t.deepEqual(cache.toBeCleanCacheMap.get(key), [1]);
  t.is(errors.length, 1);
  t.is(timers.size, 1);
  store.fail = false;
  const retry = [...timers.values()][0];
  retry();
  await cache.tryToFlushCacheToStore(true);
  t.is(store.read(key, 1), undefined);
  t.deepEqual(store.read(key, 2), { songs: ["new"] });
  t.is(cache.toBeCleanCacheMap.size, 0);
  store.sqlite.close();
});

test("updates during a write are drained, with all superseded versions deleted", async (t) => {
  const store = new Store();
  store.seed(key, 1, { songs: ["old"] });
  const { cache, update } = fixture(store);
  cache.cachedKeys.set(key, 1);
  const started = deferred();
  const release = deferred();
  store.beforeCommit = async () => {
    started.resolve();
    await release.promise;
  };
  update(2, { songs: ["intermediate"] });
  const flush = cache.tryToFlushCacheToStore(true);
  await started.promise;
  update(3, { songs: ["also intermediate"] });
  update(4, { songs: ["latest"] });
  t.is(cache.tryToFlushCacheToStore(), flush);
  release.resolve();
  await flush;
  t.is(cache.runtimeCacheMap.size, 0);
  t.is(cache.toBeCleanCacheMap.size, 0);
  t.is(store.read(key, 1), undefined);
  t.is(store.read(key, 2), undefined);
  t.is(store.read(key, 3), undefined);
  t.deepEqual(store.read(key, 4), { songs: ["latest"] });
  store.sqlite.close();
});

test("legacy same-version cleanup cannot delete its own replacement", async (t) => {
  const store = new Store();
  store.seed(key, 1, { songs: ["old"] });
  const { cache, update } = fixture(store);
  cache.cachedKeys.set(key, 1);
  update(1, { songs: ["new"] });
  await cache.tryToFlushCacheToStore(true);
  t.deepEqual(store.read(key, 1), { songs: ["new"] });
  store.sqlite.close();
});

test("size eviction preserves persistent entries and removes the oldest eligible cache", async (t) => {
  const store = new Store();
  const { cache, update } = fixture(store, {
    maxCacheCountInLocal: 2,
    overCleanPercentInLocal: 0,
  });
  const persistent = JSON.stringify({ url: "/playlist", persistent: true });
  const oldest = JSON.stringify({ url: "/oldest" });
  const newest = JSON.stringify({ url: "/newest" });
  update(1, {}, persistent);
  update(2, {}, oldest);
  update(3, {}, newest);
  await cache.tryToFlushCacheToStore(true);
  t.true(cache.cachedKeys.has(persistent));
  t.false(cache.cachedKeys.has(oldest));
  t.true(cache.cachedKeys.has(newest));
  t.is(store.read(oldest, 2), undefined);
  store.sqlite.close();
});

test("updates during eviction are persisted before the shared flush acknowledges", async (t) => {
  const store = new Store();
  const { cache, update } = fixture(store, {
    maxCacheCountInLocal: 1,
    overCleanPercentInLocal: 0,
  });
  const other = JSON.stringify({ url: "/other" });
  const started = deferred();
  const release = deferred();
  store.beforeCommit = async () => {
    if (store.transactions === 2) {
      started.resolve();
      await release.promise;
    }
  };
  update(1, { songs: ["old"] });
  update(2, {}, other);
  const flush = cache.tryToFlushCacheToStore(true);
  await started.promise;
  update(3, { songs: ["latest"] });
  t.is(cache.tryToFlushCacheToStore(), flush);
  release.resolve();
  await flush;
  t.is(cache.runtimeCacheMap.size, 0);
  t.is(cache.toBeCleanCacheMap.size, 0);
  t.deepEqual(store.read(key, 3), { songs: ["latest"] });
  t.is(store.read(key, 1), undefined);
  store.sqlite.close();
});

test("cross-key invalidation deletes cached later pages and historical versions", async (t) => {
  const store = new Store();
  const { cache, update } = fixture(store);
  const laterPage = JSON.stringify({ url: "/api/歌单/🎵", page: 2 });
  store.seed(laterPage, 1, { songs: ["obsolete"] });
  store.seed(laterPage, 2, { songs: ["also obsolete"] });
  cache.cachedKeys.set(laterPage, 2);
  update(3, { songs: ["first page"] });
  cache.updateToBeCleanCacheMap(laterPage);
  await cache.tryToFlushCacheToStore(true);
  t.false(cache.cachedKeys.has(laterPage));
  t.is(store.read(laterPage, 1), undefined);
  t.is(store.read(laterPage, 2), undefined);
  t.deepEqual(store.read(key, 3), { songs: ["first page"] });
  store.sqlite.close();
});

test("failed privilege invalidation blocks shutdown and retries without resurrecting older versions", async (t) => {
  const store = new Store();
  const { cache, context } = fixture(store);
  const protectedKey = JSON.stringify({
    url: "/privileged",
    privilegeRelated: true,
    uid: "user-1",
  });
  const otherUser = JSON.stringify({
    url: "/privileged",
    privilegeRelated: true,
    uid: "user-2",
  });
  store.seed(protectedKey, 1, { songs: ["obsolete"] });
  store.seed(protectedKey, 2, { songs: ["newest"] });
  store.seed(otherUser, 1, { songs: ["other user"] });
  cache.cachedKeys.set(protectedKey, 2);
  cache.cachedKeys.set(otherUser, 1);
  store.fail = true;
  await t.throwsAsync(cache.invalidateCache({ privilege: true, size: false }));
  t.true(cache.cachedKeys.has(protectedKey));
  await t.throwsAsync(context.__openOrpheusFlushRequestCache!());
  store.fail = false;
  await context.__openOrpheusFlushRequestCache!();
  t.false(cache.cachedKeys.has(protectedKey));
  t.is(store.read(protectedKey, 1), undefined);
  t.is(store.read(protectedKey, 2), undefined);
  t.deepEqual(store.read(otherUser, 1), { songs: ["other user"] });
  store.sqlite.close();
});

// A minimal webpack module with the known upstream anchors. This is not a copy
// of the multi-megabyte downloaded bundle, so CI needs neither downloads nor
// proprietary application data.
const bundle = `[function(e,t,n){
const i=t.i,a={b:{error(){}}},d={a:{"preload#requestFallback":{maxCacheCountInLocal:5000,overCleanPercentInLocal:.25}}},l={a:{getStore:()=>({host:{uid:"user-1"}})}};
t.get=()=>b;
const v="api.dbcache",h=async e=>{};const b=new class{
constructor(){this.cachedKeys=new Map;this.runtimeCacheMap=new Map;this.toBeCleanCacheMap=new Map;this.initPromise=this.init()}async init(){
this.cachedKeys=await(async()=>{const{value:t}=await i.Database.execSql("select id from requestCache");const n=new Map;for(const{id:i}of t){const e=i.lastIndexOf("-"),t=Number(i.slice(e+1)),r=i.slice(0,e);n.set(r,t)}return n})();
}
getCacheStrategy(){return {enable:true}}
postResponse(e){return async t=>{const n=this.getCacheStrategy(e);const c=e;this.updateToBeCleanCacheMap(c);this.cachedKeys.set(c,Date.now());this.runtimeCacheMap.set(c,t);return this.tryToFlushCacheToStore()}}
post(c,value){return this.postResponse(c)(value)}
}},function(){}]`;

test("bundle patch selects the maximum stored version, makes versions monotonic and installs a usable flush", async (t) => {
  const store = new Store();
  // Out of chronological order: last row must not win on startup.
  store.seed(key, 900, { songs: ["newest"] });
  store.seed(key, 100, { songs: ["old"] });
  const patched = patchRequestCache(bundle);
  t.is(patchRequestCache(patched), patched);
  const context = { setTimeout, clearTimeout, Date: { now: () => 500 } };
  const module = {
    i: { Database: store },
    get: undefined as
      | undefined
      | (() => RequestCacheState & {
          post(key: string, value: unknown): Promise<void>;
        }),
  };
  runInNewContext(patched, context)[0]({}, module, {});
  const cache = module.get!();
  await cache.initPromise;
  t.is(cache.cachedKeys.get(key), 900);
  await cache.post(key, { songs: ["fresh"] });
  t.is(cache.cachedKeys.get(key), 901);
  t.deepEqual(store.read(key, 901), { songs: ["fresh"] });
  t.is(store.read(key, 900), undefined);
  store.sqlite.close();
});

test("responses wait for the startup key scan instead of losing their versions to initialization", async (t) => {
  const store = new Store();
  store.seed(key, 900, { songs: ["old"] });
  const release = deferred();
  const database = {
    async execSql(sql: string | string[], transaction?: boolean) {
      if (typeof sql === "string" && sql.startsWith("select"))
        await release.promise;
      return store.execSql(sql, transaction);
    },
  };
  const module = {
    i: { Database: database },
    get: undefined as
      | undefined
      | (() => RequestCacheState & {
          post(key: string, value: unknown): Promise<void>;
        }),
  };
  runInNewContext(patchRequestCache(bundle), {
    setTimeout,
    clearTimeout,
    Date: { now: () => 500 },
  })[0]({}, module, {});
  const cache = module.get!();
  const response = cache.post(key, { songs: ["new"] });
  t.is(cache.runtimeCacheMap.size, 0);
  release.resolve();
  await response;
  t.is(cache.cachedKeys.get(key), 901);
  t.deepEqual(store.read(key, 901), { songs: ["new"] });
  store.sqlite.close();
});

test("unknown cache bundles fail explicitly, unrelated scripts pass through unchanged", (t) => {
  const unrelated = "console.log('hello');";
  t.is(patchRequestCache(unrelated), unrelated);
  t.throws(
    () =>
      patchRequestCache(
        bundle.replace("r=i.slice(0,e);n.set(r,t)", "differentImplementation()")
      ),
    { message: /Unsupported frontend/ }
  );
  t.throws(() => patchRequestCache('const cacheName="api.dbcache";'), {
    message: /Unsupported frontend/,
  });
});
