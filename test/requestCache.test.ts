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
  beforeWrite?: () => Promise<void>;
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
      // modules/database execute_sql_impl exposes named columns as strings;
      // the SDK turns a missing native row array into [].
      const value = this.sqlite
        .prepare(sql)
        .all()
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              String(value),
            ])
          )
        );
      return { error: 0, value };
    }
    if (!transaction) throw new Error("Expected an atomic cache transaction");
    const text = Array.isArray(sql) ? sql.join("") : sql;
    const dataWrite =
      text.includes("requestCache (") ||
      text.includes("DELETE FROM requestCache WHERE");
    if (dataWrite) this.transactions++;
    if (dataWrite) await this.beforeWrite?.();
    this.sqlite.exec("BEGIN;");
    try {
      this.sqlite.exec(Array.isArray(sql) ? sql.join("") : sql);
      if (dataWrite) await this.beforeCommit?.();
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
  const update = async (version: number, value: unknown, cacheKey = key) => {
    const ticket = await cache.allocateCacheTicket!();
    await cache.updateToBeCleanCacheMap(cacheKey, ticket);
    cache.cachedKeys.set(cacheKey, version);
    cache.stageCacheValue!(cacheKey, ticket, value);
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
    await update(1, songs);
    await cache.tryToFlushCacheToStore();
    t.is(cache.runtimeCacheMap.size, 0);
    const reopened = new Store(path);
    try {
      t.deepEqual(reopened.read(key, 1), songs);
    } finally {
      reopened.sqlite.close();
    }
    await update(2, { code: 200, songs: [] });
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
  await update(1, { songs: ["latest"] });
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
  await update(2, { songs: ["new"] });
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
  store.beforeWrite = async () => {
    started.resolve();
    await release.promise;
  };
  await update(2, { songs: ["intermediate"] });
  const flush = cache.tryToFlushCacheToStore(true);
  await started.promise;
  await update(3, { songs: ["also intermediate"] });
  await update(4, { songs: ["latest"] });
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
  await update(1, { songs: ["new"] });
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
  await update(1, {}, persistent);
  await update(2, {}, oldest);
  await update(3, {}, newest);
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
  store.beforeWrite = async () => {
    if (store.transactions === 2) {
      started.resolve();
      await release.promise;
    }
  };
  await update(1, { songs: ["old"] });
  await update(2, {}, other);
  const flush = cache.tryToFlushCacheToStore(true);
  await started.promise;
  await update(3, { songs: ["latest"] });
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
  await update(3, { songs: ["first page"] });
  await cache.updateToBeCleanCacheMap(laterPage);
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
const i=t.i,r={a:value=>value===undefined?undefined:JSON.parse(JSON.stringify(value))},a={b:{error(){}}},d={a:{"preload#requestFallback":{maxCacheCountInLocal:5000,overCleanPercentInLocal:.25}}},l={a:{getStore:()=>({host:{uid:"user-1"}})}};
t.get=()=>b;
const v="api.dbcache",h=async e=>{};const b=new class{
constructor(){this.cachedKeys=new Map;this.runtimeCacheMap=new Map;this.toBeCleanCacheMap=new Map;this.initPromise=this.init()}async init(){
this.cachedKeys=await(async()=>{const{value:t}=await i.Database.execSql("select id from requestCache");const n=new Map;for(const{id:i}of t){const e=i.lastIndexOf("-"),t=Number(i.slice(e+1)),r=i.slice(0,e);n.set(r,t)}return n})();
}
getCacheStrategy(){return {enable:this.enabled!==false}}
postResponse(e){return async t=>{const n=this.getCacheStrategy(e);if(null!==n&&void 0!==n&&n.enable){var i,o;const c=this.computeRequestKey(e);if(!c)return t;if(500!==(null===(i=t.body)||void 0===i?void 0:i.code)&&this.online!==false){if(200===(null===(o=t.body)||void 0===o?void 0:o.code)){if(e.url.includes("api/batch")&&t.body){const e=await this.getCacheResultByKey(c,"batch request");if(n.generateCacheData&&e)t.body=n.generateCacheData(e,Object(r.a)(t.body))}if(this.updateToBeCleanCacheMap(c),n.generateCleanCacheKeys){const t=n.generateCleanCacheKeys(e,this.cachedKeys,this.toBeCleanCacheMap);for(const e of t)this.updateToBeCleanCacheMap(e)}this.cachedKeys.set(c,Date.now()),this.runtimeCacheMap.set(c,Object(r.a)(t.body)),this.tryToFlushCacheToStore()}}else if(this.cachedKeys.has(c)){let e=await this.getCacheResultByKey(c,"request error");if(e)t.body=e}}return t}}
computeRequestKey(e){return e.key}
async post(c,value){await this.postResponse({key:c,url:c})({body:{code:200,...value}});await this.tryToFlushCacheToStore()}
async fallback(c){return (await this.postResponse({key:c,url:c})({body:{code:500}})).body}
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
  t.deepEqual(store.read(key, 901), { code: 200, songs: ["fresh"] });
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
  t.deepEqual(store.read(key, 901), { code: 200, songs: ["new"] });
  store.sqlite.close();
});

function responseFixture(store: Store) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const context = {
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    __openOrpheusFlushRequestCache: undefined as
      undefined | (() => Promise<void>),
  };
  const module = {
    i: { Database: store },
    get: undefined as
      | undefined
      | (() => RequestCacheState & {
          enabled: boolean;
          online: boolean;
          postResponse(request: {
            key: string;
            url: string;
          }): (response: { body: unknown }) => Promise<{ body: unknown }>;
        }),
  };
  runInNewContext(patchRequestCache(bundle), context)[0]({}, module, {});
  const cache = module.get!();
  return {
    cache,
    context,
    timers,
    respond: cache.postResponse({ key, url: "/api/playlist/detail" }),
  };
}

test("response registration and shared ordering precede a delayed refresh scan", async (t) => {
  const store = new Store();
  const first = responseFixture(store);
  const second = responseFixture(store);
  await Promise.all([first.cache.initPromise, second.cache.initPromise]);
  const started = deferred();
  const release = deferred();
  const refresh = first.cache.refreshCacheKeys!;
  first.cache.refreshCacheKeys = async () => {
    started.resolve();
    await release.promise;
    await refresh();
  };
  const body = { code: 200, songs: ["older"] };
  const oldResponse = first.respond({ body });
  await started.promise;
  body.songs.push("mutation after receipt");
  let acknowledged = false;
  const shutdown = first.context.__openOrpheusFlushRequestCache!().then(() => {
    acknowledged = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.false(acknowledged, "shutdown must see responses awaiting refresh scans");
  await second.respond({ body: { code: 200, songs: ["newer"] } });
  await second.context.__openOrpheusFlushRequestCache!();
  release.resolve();
  await oldResponse;
  await shutdown;
  t.deepEqual(await first.cache.getCacheResultByKey!(key), {
    code: 200,
    songs: ["newer"],
  });
  store.sqlite.close();
});

test("real postResponse offline/error fallback stays read-only when SQL writes fail", async (t) => {
  const store = new Store();
  store.seed(key, 1, { code: 200, songs: ["saved"] });
  const { cache, respond } = responseFixture(store);
  await cache.initPromise;
  let allocations = 0;
  const allocate = cache.allocateCacheTicket!;
  cache.allocateCacheTicket = () => {
    allocations++;
    return allocate();
  };
  store.fail = true;
  t.deepEqual((await respond({ body: { code: 500 } })).body, {
    code: 200,
    songs: ["saved"],
  });
  cache.online = false;
  t.deepEqual((await respond({ body: { code: 200, songs: [] } })).body, {
    code: 200,
    songs: ["saved"],
  });
  cache.online = true;
  cache.enabled = false;
  const response = { body: { code: 200, songs: ["uncached"] } };
  t.is(await respond(response), response);
  t.is(allocations, 0);
  store.sqlite.close();
});

test("response reservation failure retains an unresolved shutdown barrier until a fresh response", async (t) => {
  const store = new Store();
  const { cache, respond, context } = responseFixture(store);
  await cache.initPromise;
  let allocations = 0;
  const allocate = cache.allocateCacheTicket!;
  cache.allocateCacheTicket = () => {
    allocations++;
    return allocate();
  };
  store.fail = true;
  t.deepEqual(
    (await respond({ body: { code: 200, songs: ["retained"] } })).body,
    { code: 200, songs: ["retained"] },
    "cache failure must not reject a successful network response"
  );
  store.fail = false;
  await t.throwsAsync(context.__openOrpheusFlushRequestCache!(), {
    message: /ordering unresolved/,
  });
  await t.throwsAsync(cache.tryToFlushCacheToStore(true), {
    message: /ordering unresolved/,
  });
  t.is(allocations, 1, "must not give the old response a new ticket on retry");
  await respond({ body: { code: 200, songs: ["fresh"] } });
  await context.__openOrpheusFlushRequestCache!();
  t.deepEqual(await cache.getCacheResultByKey!(key), {
    code: 200,
    songs: ["fresh"],
  });
  store.sqlite.close();
});

test("shutdown waits for a received response's ticket reservation and detached snapshot", async (t) => {
  const store = new Store();
  const { cache, respond, context } = responseFixture(store);
  await cache.initPromise;
  const started = deferred();
  const release = deferred();
  const allocate = cache.allocateCacheTicket!;
  cache.allocateCacheTicket = async () => {
    started.resolve();
    await release.promise;
    return allocate();
  };
  const body = { code: 200, songs: ["received"] };
  const response = respond({ body });
  await started.promise;
  body.songs.push("later mutation");
  let acknowledged = false;
  const flush = context.__openOrpheusFlushRequestCache!().then(() => {
    acknowledged = true;
  });
  await Promise.resolve();
  t.false(acknowledged);
  release.resolve();
  await response;
  await flush;
  t.deepEqual(await cache.getCacheResultByKey!(key), {
    code: 200,
    songs: ["received"],
  });
  store.sqlite.close();
});

test("an older response resumed after local invalidation cannot stage before its commit", async (t) => {
  const store = new Store();
  store.seed(key, 1, { old: true });
  const { cache } = fixture(store);
  cache.cachedKeys.set(key, 1);
  const older = await cache.allocateCacheTicket!();
  const newer = await cache.allocateCacheTicket!();
  await cache.updateToBeCleanCacheMap(key, newer);
  await cache.updateToBeCleanCacheMap(key, older);
  cache.stageCacheValue!(key, older, { stale: true });
  t.false(cache.runtimeCacheMap.has(key));
  await cache.tryToFlushCacheToStore(true);
  t.is(await cache.getCacheResultByKey!(key), undefined);
  store.sqlite.close();
});

test("patched batch response reserves before its read and cannot revive a newer local invalidation", async (t) => {
  const store = new Store();
  store.seed(key, 1, { code: 200, old: true });
  const { cache, context } = responseFixture(store);
  await cache.initPromise;
  const started = deferred();
  const release = deferred();
  const read = cache.getCacheResultByKey!;
  cache.getCacheResultByKey = async (key, reason) => {
    if (reason === "batch request") {
      started.resolve();
      await release.promise;
    }
    return read(key, reason);
  };
  const response = cache.postResponse({ key, url: "/api/batch" })({
    body: { code: 200, stale: true },
  });
  await started.promise;
  const newer = await cache.allocateCacheTicket!();
  await cache.updateToBeCleanCacheMap(key, newer);
  release.resolve();
  await response;
  await context.__openOrpheusFlushRequestCache!();
  t.is(await cache.getCacheResultByKey!(key), undefined);
  t.false(cache.runtimeCacheMap.has(key));
  store.sqlite.close();
});

test("invalidation allocation failure is observed and scheduled for retry", async (t) => {
  const store = new Store();
  const protectedKey = JSON.stringify({
    uid: "user-1",
    privilegeRelated: true,
  });
  store.seed(protectedKey, 1, { old: true });
  const { cache, timers, errors } = fixture(store);
  store.fail = true;
  await t.throwsAsync(cache.invalidateCache({ privilege: true, size: false }));
  t.is(errors.length, 1);
  t.is(timers.size, 1);
  t.is(await cache.getCacheResultByKey!(protectedKey), undefined);
  store.fail = false;
  [...timers.values()][0]();
  await cache.tryToFlushCacheToStore(true);
  t.is(store.read(protectedKey, 1), undefined);
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

async function sharedStores() {
  const root = await mkdtemp(join(tmpdir(), "orpheus-shared-cache-"));
  const path = join(root, "webdb.dat");
  const first = new Store(path);
  const second = new Store(path);
  return {
    first,
    second,
    async close() {
      first.sqlite.close();
      second.sqlite.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("shared SQLite: equal timestamps and reversed clocks use response tickets", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  await a.update(100, { from: "a" });
  await b.update(100, { from: "b" });
  await a.cache.tryToFlushCacheToStore(true);
  await b.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await a.cache.getCacheResultByKey!(key), { from: "b" });
  await a.update(50, { from: "slow clock" });
  await a.cache.tryToFlushCacheToStore(true);
  t.is(stores.second.read(key, 100), undefined);
  t.deepEqual(await b.cache.getCacheResultByKey!(key), { from: "slow clock" });
  t.is(
    stores.first.sqlite.prepare("SELECT count(*) AS n FROM requestCache").get()!
      .n,
    1
  );
});

test("shared SQLite: competing writers retain a busy transaction for retry", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  const started = deferred();
  const release = deferred();
  stores.first.beforeCommit = async () => {
    started.resolve();
    await release.promise;
  };
  await a.update(100, { from: "a" });
  await b.update(100, { from: "b" });
  const firstFlush = a.cache.tryToFlushCacheToStore(true);
  await started.promise;
  await t.throwsAsync(b.cache.tryToFlushCacheToStore(true));
  t.is(b.cache.runtimeCacheMap.size, 1);
  t.is(b.timers.size, 1);
  release.resolve();
  await firstFlush;
  await b.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await a.cache.getCacheResultByKey!(key), { from: "b" });
});

test("shared SQLite: patched fallback does not gate a lookup on the startup index", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const module = {
    i: { Database: stores.second },
    get: undefined as
      | undefined
      | (() => RequestCacheState & {
          fallback(key: string): Promise<unknown>;
        }),
  };
  runInNewContext(patchRequestCache(bundle), { setTimeout, clearTimeout })[0](
    {},
    module,
    {}
  );
  const reader = module.get!();
  await reader.initPromise;
  const writer = fixture(stores.first);
  await writer.update(1, { from: "writer" });
  await writer.cache.tryToFlushCacheToStore(true);
  t.false(reader.cachedKeys.has(key));
  t.deepEqual(await reader.fallback(key), { from: "writer" });
});

test("shared SQLite: stale and missing exact-version indexes discover replacements and deletions", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  await a.update(10, { songs: ["first"] });
  await a.cache.tryToFlushCacheToStore(true);
  t.false(b.cache.cachedKeys.has(key));
  t.deepEqual(await b.cache.getCacheResultByKey!(key), { songs: ["first"] });
  await a.update(20, { songs: ["second"] });
  await a.cache.tryToFlushCacheToStore(true);
  t.is(b.cache.cachedKeys.get(key), 10);
  const read = (await b.cache.getCacheResultByKey!(key)) as { songs: string[] };
  read.songs.push("mutated");
  t.deepEqual(await b.cache.getCacheResultByKey!(key), { songs: ["second"] });
  await a.cache.updateToBeCleanCacheMap(key);
  await a.cache.tryToFlushCacheToStore(true);
  t.is(await b.cache.getCacheResultByKey!(key), undefined);
  t.false(b.cache.cachedKeys.has(key));
});

test("shared SQLite: privilege and size eviction discover keys absent from local startup index", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second, {
    maxCacheCountInLocal: 1,
    overCleanPercentInLocal: 0,
  });
  const protectedKey = JSON.stringify({
    url: "/protected",
    uid: "user-1",
    privilegeRelated: true,
  });
  await a.update(1, {}, protectedKey);
  await a.cache.tryToFlushCacheToStore(true);
  t.false(b.cache.cachedKeys.has(protectedKey));
  await b.cache.invalidateCache({ privilege: true, size: false });
  t.is(await a.cache.getCacheResultByKey!(protectedKey), undefined);
  await a.update(2, {}, key);
  await a.update(3, {}, protectedKey);
  await a.cache.tryToFlushCacheToStore(true);
  await b.cache.invalidateCache({ privilege: false, size: true });
  t.is(await a.cache.getCacheResultByKey!(key), undefined);
  t.deepEqual(await a.cache.getCacheResultByKey!(protectedKey), {});
});

test("shared SQLite: page invalidation preserves responses with newer tickets", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  const later = JSON.stringify({ url: "/playlist", page: 2 });
  await b.update(5, { stale: true }, later);
  await b.cache.tryToFlushCacheToStore(true);
  await a.cache.refreshCacheKeys!();
  t.true(a.cache.cachedKeys.has(later));
  await a.cache.updateToBeCleanCacheMap(later);
  await b.update(50, { newer: true }, later);
  await b.cache.tryToFlushCacheToStore(true);
  await a.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await b.cache.getCacheResultByKey!(later), { newer: true });
});

test("cross-key invalidation cancels a pending page instead of persisting it as a replacement", async (t) => {
  const store = new Store();
  t.teardown(() => store.sqlite.close());
  const { cache, update } = fixture(store);
  const later = JSON.stringify({ url: "/playlist", page: 2 });
  await update(1, { stale: true }, later);
  await cache.updateToBeCleanCacheMap(later);
  await update(2, { page: 1 });
  t.is(await cache.getCacheResultByKey!(later), undefined);
  await cache.tryToFlushCacheToStore(true);
  t.is(store.read(later, 1), undefined);
  t.false(cache.cachedKeys.has(later));
});

test("cross-key invalidation during COMMIT survives repeated same-version cleanup", async (t) => {
  const store = new Store();
  t.teardown(() => store.sqlite.close());
  const { cache, update } = fixture(store);
  store.seed(key, 1, {});
  cache.cachedKeys.set(key, 1);
  await update(1, { pending: true });
  const started = deferred();
  const release = deferred();
  store.beforeCommit = async () => {
    started.resolve();
    await release.promise;
  };
  const cleanupTicket = await cache.allocateCacheTicket!();
  const flush = cache.tryToFlushCacheToStore(true);
  await started.promise;
  await cache.updateToBeCleanCacheMap(key, cleanupTicket);
  t.is(await cache.getCacheResultByKey!(key), undefined);
  release.resolve();
  await flush;
  t.is(store.read(key, 1), undefined);
  t.is(cache.toBeCleanCacheMap.size, 0);
  t.false(cache.cachedKeys.has(key));
});

test("shared SQLite: a foreign pending response cannot resurrect invalidation", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  await a.update(1, {});
  await a.cache.tryToFlushCacheToStore(true);
  await b.update(2, { pending: true });
  await a.cache.updateToBeCleanCacheMap(key);
  await a.cache.tryToFlushCacheToStore(true);
  await b.cache.tryToFlushCacheToStore(true);
  t.is(await a.cache.getCacheResultByKey!(key), undefined);
});

test("shared SQLite: an older pending retry cannot overwrite a newer committed response", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  await a.update(900, { stale: true });
  stores.first.fail = true;
  await t.throwsAsync(a.cache.tryToFlushCacheToStore(true));
  stores.first.fail = false;
  await b.update(100, { fresh: true });
  await b.cache.tryToFlushCacheToStore(true);
  await a.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await a.cache.getCacheResultByKey!(key), { fresh: true });
  t.is(stores.first.read(key, 900), undefined);
  t.is(a.cache.runtimeCacheMap.size, 0);
});

test("shared SQLite: explicit page tombstone covers a key absent from every index", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  await b.update(1, { stale: true });
  await a.cache.updateToBeCleanCacheMap(key);
  await a.cache.tryToFlushCacheToStore(true);
  await b.cache.tryToFlushCacheToStore(true);
  t.is(await a.cache.getCacheResultByKey!(key), undefined);
});

test("shared SQLite: invalidation retry keeps its ticket and preserves a later refresh", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  const protectedKey = JSON.stringify({
    url: "/private",
    privilegeRelated: true,
    uid: "user-1",
  });
  await b.update(1, { old: true }, protectedKey);
  await b.cache.tryToFlushCacheToStore(true);
  stores.first.beforeWrite = async () => {
    stores.first.fail = true;
  };
  await t.throwsAsync(
    a.cache.invalidateCache({ privilege: true, size: false })
  );
  stores.first.beforeWrite = undefined;
  stores.first.fail = false;
  await b.update(2, { fresh: true }, protectedKey);
  await b.cache.tryToFlushCacheToStore(true);
  await a.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await a.cache.getCacheResultByKey!(protectedKey), {
    fresh: true,
  });
});

test("shared SQLite: privilege tombstone covers foreign pending keys never stored", async (t) => {
  const stores = await sharedStores();
  t.teardown(() => stores.close());
  const a = fixture(stores.first);
  const b = fixture(stores.second);
  const protectedKey = JSON.stringify({
    url: "/private",
    privilegeRelated: true,
    uid: "user-1",
  });
  await b.update(1, { stale: true }, protectedKey);
  await a.cache.invalidateCache({ privilege: true, size: false });
  await b.cache.tryToFlushCacheToStore(true);
  t.is(await a.cache.getCacheResultByKey!(protectedKey), undefined);
  await b.update(2, { fresh: true }, protectedKey);
  await b.cache.tryToFlushCacheToStore(true);
  t.deepEqual(await a.cache.getCacheResultByKey!(protectedKey), {
    fresh: true,
  });
});
