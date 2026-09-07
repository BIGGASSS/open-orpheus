export interface RequestCacheState {
  cachedKeys: Map<string, number>;
  runtimeCacheMap: Map<string, unknown>;
  toBeCleanCacheMap: Map<string, number[]>;
  initPromise: Promise<unknown>;
  tryToFlushCacheToStore(force?: boolean): Promise<void>;
  invalidateCache(options: {
    privilege: boolean;
    size: boolean;
  }): Promise<void>;
  updateToBeCleanCacheMap(key: string): void;
}

export interface RequestCacheDatabase {
  execSql(
    sql: string | string[],
    transaction?: boolean
  ): Promise<{ error: number; value: unknown }>;
}

export interface RequestCacheOptions {
  limits(): { maxCacheCountInLocal: number; overCleanPercentInLocal: number };
  uid(): unknown;
  report(error: unknown): void;
}

/**
 * Serialized into the signed frontend's response (not into its archive).
 * Keep this function self-contained: no references to imports/module state.
 */
export function installRequestCachePersistence(
  cache: RequestCacheState,
  database: RequestCacheDatabase,
  options: RequestCacheOptions
): void {
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const invalidations: { privilege: boolean; size: boolean }[] = [];
  let flushing: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  async function execute(sql: string[]) {
    if (!sql.length) return;
    // Upstream transaction/put swallow execSql errors (and may silently no-op
    // before schema initialization). Check the native transaction result.
    const result = await database.execSql(sql, true);
    if (!result || result.error !== 0) {
      throw new Error(`Request cache transaction failed: ${result?.error}`);
    }
  }

  function deleteVersions(key: string, version: number, inclusive = true) {
    const prefix = quote(key + "-");
    // Remove legacy duplicates too, otherwise eviction resurrects an older
    // snapshot on restart. Use SQLite length, not JS UTF-16 string length.
    return `DELETE FROM requestCache WHERE substr(id, 1, length(${prefix})) = ${prefix} AND CAST(substr(id, length(${prefix}) + 1) AS INTEGER) ${inclusive ? "<=" : "<"} ${version};`;
  }

  async function flushSnapshots() {
    while (cache.runtimeCacheMap.size || cache.toBeCleanCacheMap.size) {
      const entries = new Map(
        Array.from(cache.runtimeCacheMap, ([key, value]) => [
          key,
          { value, version: cache.cachedKeys.get(key) },
        ])
      );
      const cleanup = new Map(
        Array.from(cache.toBeCleanCacheMap, ([key, versions]) => [
          key,
          [...versions],
        ])
      );
      const sql = [
        "CREATE TABLE IF NOT EXISTS requestCache (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);",
      ];
      for (const [key, { value, version }] of entries) {
        if (version === undefined)
          throw new Error("Request cache entry has no version");
        const id = key + "-" + version;
        // Match Database.put's on-disk format. Database.get deserializes this
        // envelope; getCacheResultByKey then deserializes its cache field.
        const jsonStr = JSON.stringify({ id, cache: JSON.stringify(value) });
        sql.push(
          `INSERT OR REPLACE INTO requestCache (id, jsonStr) VALUES (${quote(id)}, ${quote(jsonStr)});`,
          deleteVersions(key, version, false)
        );
      }
      for (const [key, versions] of cleanup) {
        // Replacements already clean all older versions without deleting
        // themselves. A key with no replacement is a cross-key invalidation
        // (e.g. refreshing page 1 invalidates cached later pages).
        if (entries.has(key) || !versions.length) continue;
        const newest = versions.reduce((max, version) =>
          Math.max(max, version)
        );
        sql.push(deleteVersions(key, newest));
      }
      // Replacements and predecessor removal commit together. Pending maps
      // remain readable and retryable until the native commit acknowledges.
      await execute(sql);
      for (const [key, { value, version }] of entries) {
        if (
          cache.runtimeCacheMap.get(key) === value &&
          cache.cachedKeys.get(key) === version
        ) {
          cache.runtimeCacheMap.delete(key);
        }
      }
      for (const [key, versions] of cleanup) {
        const current = cache.cachedKeys.get(key);
        if (
          !entries.has(key) &&
          current !== undefined &&
          versions.includes(current) &&
          !cache.runtimeCacheMap.has(key)
        ) {
          cache.cachedKeys.delete(key);
        }
        const remaining = (cache.toBeCleanCacheMap.get(key) ?? []).filter(
          (version) => !versions.includes(version)
        );
        if (remaining.length) cache.toBeCleanCacheMap.set(key, remaining);
        else cache.toBeCleanCacheMap.delete(key);
      }
      // Updates received during the transaction are flushed in the next pass.
    }
  }

  async function evict() {
    const requests = invalidations.slice();
    const { maxCacheCountInLocal: limit, overCleanPercentInLocal: percent } =
      options.limits();
    const byPrivilege = requests.some((reason) => reason.privilege);
    const bySize = cache.cachedKeys.size > limit;
    if (!byPrivilege && !bySize) {
      invalidations.splice(0, requests.length);
      return;
    }
    const candidates = Array.from(cache.cachedKeys, ([key, version]) => ({
      key,
      version,
      metadata: JSON.parse(key),
    }));
    const remove = new Map<string, number>();
    if (byPrivilege) {
      for (const entry of candidates) {
        if (
          entry.metadata.privilegeRelated &&
          entry.metadata.uid === options.uid()
        ) {
          remove.set(entry.key, entry.version);
        }
      }
    }
    if (bySize) {
      const count = Math.ceil(candidates.length - limit * (1 - percent));
      for (const entry of candidates
        .filter((entry) => !entry.metadata.persistent)
        .sort((a, b) => a.version - b.version)
        .slice(0, count)) {
        remove.set(entry.key, entry.version);
      }
    }
    await execute(
      Array.from(remove, ([key, version]) => deleteVersions(key, version))
    );
    // Keep invalidation requests and the key index intact on failure. They
    // participate in the same retry/shutdown barrier as response writes.
    invalidations.splice(0, requests.length);
    for (const [key, version] of remove) {
      if (
        cache.cachedKeys.get(key) === version &&
        !cache.runtimeCacheMap.has(key)
      ) {
        cache.cachedKeys.delete(key);
      }
    }
  }

  async function drain() {
    try {
      await cache.initPromise;
      for (;;) {
        await flushSnapshots();
        await evict();
        if (
          !cache.runtimeCacheMap.size &&
          !cache.toBeCleanCacheMap.size &&
          !invalidations.length
        ) {
          // No await between the empty check and releasing the shared promise.
          // A later response starts a new flush instead of joining a spent one.
          return;
        }
      }
    } finally {
      flushing = undefined;
    }
  }

  cache.updateToBeCleanCacheMap = (key) => {
    const version = cache.cachedKeys.get(key);
    if (version === undefined) return;
    const versions = cache.toBeCleanCacheMap.get(key) ?? [];
    if (!versions.includes(version))
      cache.toBeCleanCacheMap.set(key, [...versions, version]);
  };

  cache.tryToFlushCacheToStore = () => {
    if (flushing) return flushing;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    // Every successful response requests a write, not only the 51st entry or
    // the ten-minute timer. Concurrent requests share one draining flush.
    const result = Promise.resolve().then(drain);
    flushing = result;
    // Observe errors for fire-and-forget response/timer callers, but return
    // the rejecting promise so forced/shutdown callers cannot report success.
    void result.catch((error) => {
      options.report(error);
      retryTimer = setTimeout(() => {
        void cache.tryToFlushCacheToStore();
      }, 1000);
    });
    return result;
  };

  cache.invalidateCache = (reason) => {
    invalidations.push(reason);
    return cache.tryToFlushCacheToStore(true);
  };

  const host = globalThis as typeof globalThis & {
    __openOrpheusFlushRequestCache?: () => Promise<void>;
  };
  const previousFlush = host.__openOrpheusFlushRequestCache;
  host.__openOrpheusFlushRequestCache = async () => {
    await previousFlush?.();
    await cache.tryToFlushCacheToStore(true);
  };
}
