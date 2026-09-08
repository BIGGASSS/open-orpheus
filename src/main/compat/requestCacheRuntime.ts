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
  updateToBeCleanCacheMap(key: string, ticket?: number): void | Promise<void>;
  allocateCacheTicket?(): Promise<number>;
  runCacheResponse?(
    key: string,
    value: unknown,
    work: (ticket: number, snapshot: unknown) => Promise<void>
  ): Promise<void>;
  stageCacheValue?(key: string, ticket: number, value: unknown): void;
  getCacheResultByKey?(key: string, reason?: string): Promise<unknown>;
  refreshCacheKeys?(): Promise<void>;
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
  clone?(value: unknown): unknown;
}

/**
 * Serialized into the signed frontend's response (not into its archive).
 * Keep this function self-contained: no references to imports/module state.
 *
 * Responses carry shared SQLite sequence tickets, never renderer timestamps or
 * drain-time tickets. Per-key high water marks survive deletion as tombstones.
 * Privilege barriers also cover keys that exist only in foreign pending maps.
 * Page/size candidate selection remains a snapshot; reads are not a barrier.
 */
export function installRequestCachePersistence(
  cache: RequestCacheState,
  database: RequestCacheDatabase,
  options: RequestCacheOptions
): void {
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  type Invalidation = {
    privilege: boolean;
    size: boolean;
    ticket?: number;
    allocation?: Promise<number>;
  };
  const invalidations: Invalidation[] = [];
  type ResponseTask = {
    key: string;
    snapshot: unknown;
    work: (ticket: number, snapshot: unknown) => Promise<void>;
    promise?: Promise<void>;
    error?: Error;
  };
  const responses = new Set<ResponseTask>();
  const tickets = new Map<string, number>();
  const cleanupTickets = new WeakMap<number[], number>();
  const schema = [
    "CREATE TABLE IF NOT EXISTS requestCacheEvents (ticket INTEGER PRIMARY KEY AUTOINCREMENT, nonce TEXT UNIQUE NOT NULL);",
    "CREATE TABLE IF NOT EXISTS requestCacheOrder (key TEXT PRIMARY KEY, ticket INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS requestCachePrivilege (uid TEXT PRIMARY KEY, ticket INTEGER NOT NULL);",
  ];
  let nonceCounter = 0;
  const noncePrefix = Date.now() + ":" + Math.random() + ":" + Math.random();
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

  cache.allocateCacheTicket = async () => {
    // Reserve before initialization/refresh awaits: an already received response
    // must not obtain newer authority merely because its startup scan was slow.
    const nonce = quote(noncePrefix + ":" + ++nonceCounter);
    // Verified SDK: execSql joins arrays with ""; true uses storage.exectransaction.
    // It resolves {error,value}; query values are named-column objects. Do not
    // depend on transaction result arrays or connection-local last_insert_rowid.
    await execute([
      ...schema,
      `INSERT INTO requestCacheEvents (nonce) VALUES (${nonce});`,
    ]);
    const result = await database.execSql(
      `select ticket from requestCacheEvents WHERE nonce = ${nonce};`
    );
    // The host's execute_sql_impl converts every SQL cell to a string.
    const ticket = Number((result.value as { ticket: string }[])?.[0]?.ticket);
    if (result.error !== 0 || !Number.isSafeInteger(ticket) || ticket <= 0)
      throw new Error("Request cache ticket allocation failed");
    // AUTOINCREMENT retains the high-water mark in sqlite_sequence even after
    // deleting event rows. A failed housekeeping delete is harmless.
    try {
      await execute([`DELETE FROM requestCacheEvents WHERE nonce = ${nonce};`]);
    } catch (error) {
      options.report(error);
    }
    return ticket;
  };

  cache.runCacheResponse = (key, value, work) => {
    // Retain the received payload and continuation BEFORE any SQL or batch await.
    const task: ResponseTask = {
      key,
      snapshot: options.clone
        ? options.clone(value)
        : JSON.parse(JSON.stringify(value)),
      work,
    };
    const predecessors = [...responses].filter((entry) => entry.key === key);
    responses.add(task);
    task.promise = (async () => {
      let ticket: number;
      try {
        ticket = await cache.allocateCacheTicket!();
      } catch {
        // A failed reservation has no trustworthy shared order. Never mint a
        // newer ticket for this old payload on retry.
        throw new Error(
          `Request cache ordering unresolved for ${key}; fetch a fresh successful response to replace the retained payload before shutdown`
        );
      }
      await task.work(ticket, task.snapshot);
      for (const previous of predecessors)
        if (previous.error) responses.delete(previous);
      responses.delete(task);
    })().catch((error) => {
      task.error = error;
      options.report(error);
      throw error;
    });
    void task.promise.catch(() => {});
    return task.promise;
  };

  cache.stageCacheValue = (key, ticket, value) => {
    if ((tickets.get(key) ?? 0) > ticket) return;
    tickets.set(key, ticket);
    cache.runtimeCacheMap.set(key, value);
  };

  function accept(key: string, ticket: number) {
    const metadata = JSON.parse(key);
    const privilege = metadata.privilegeRelated
      ? ` AND NOT EXISTS (SELECT 1 FROM requestCachePrivilege WHERE uid = ${quote(JSON.stringify(metadata.uid) ?? "null")} AND ticket >= ${ticket})`
      : "";
    return `NOT EXISTS (SELECT 1 FROM requestCacheOrder WHERE key = ${quote(key)} AND ticket > ${ticket})${privilege}`;
  }

  function orderedDelete(key: string, ticket: number) {
    return [
      `INSERT OR IGNORE INTO requestCacheOrder (key, ticket) VALUES (${quote(key)}, 0);`,
      `UPDATE requestCacheOrder SET ticket = ${ticket} WHERE key = ${quote(key)} AND ticket < ${ticket};`,
      deleteVersions(key).replace(
        ";",
        ` AND (SELECT ticket FROM requestCacheOrder WHERE key = ${quote(key)}) = ${ticket};`
      ),
    ];
  }

  function deleteVersions(key: string) {
    const prefix = quote(key + "-");
    // Remove legacy duplicates too, otherwise eviction resurrects an older
    // snapshot on restart. Use SQLite length, not JS UTF-16 string length.
    return `DELETE FROM requestCache WHERE substr(id, 1, length(${prefix})) = ${prefix};`;
  }

  async function rows(sql: string) {
    const result = await database.execSql(sql);
    if (!result || result.error !== 0 || !Array.isArray(result.value))
      throw new Error(`Request cache query failed: ${result?.error}`);
    return result.value as { id: string; jsonStr: string }[];
  }

  async function readStoredKeys() {
    const keys = new Map<string, number>();
    for (const { id } of await rows("select id from requestCache")) {
      const split = id.lastIndexOf("-");
      const key = id.slice(0, split);
      const version = Number(id.slice(split + 1));
      if (Number.isFinite(version) && version > (keys.get(key) ?? -Infinity))
        keys.set(key, version);
    }
    return keys;
  }

  cache.refreshCacheKeys = async () => {
    await cache.initPromise;
    try {
      const stored = await readStoredKeys();
      // Preserve unacknowledged local state while discovering other renderers'
      // pages for upstream generateCleanCacheKeys / cache strategy callbacks.
      for (const [key, version] of cache.cachedKeys) {
        if (cache.runtimeCacheMap.has(key) || cache.toBeCleanCacheMap.has(key))
          stored.set(key, version);
      }
      cache.cachedKeys = stored;
    } catch (error) {
      options.report(error);
    }
  };

  cache.getCacheResultByKey = async (key) => {
    await cache.initPromise;
    const pending = () => {
      const metadata = JSON.parse(key);
      return (
        cache.toBeCleanCacheMap.has(key) ||
        invalidations.some(
          (reason) =>
            reason.privilege &&
            metadata.privilegeRelated &&
            metadata.uid === options.uid()
        )
      );
    };
    const clone = (value: unknown) =>
      options.clone
        ? options.clone(value)
        : value === undefined
          ? undefined
          : JSON.parse(JSON.stringify(value));
    try {
      if (cache.runtimeCacheMap.has(key)) {
        const ticket = tickets.get(key)!;
        const allowed = await rows(
          `select 1 AS id WHERE ${accept(key, ticket)};`
        );
        if (tickets.get(key) !== ticket) return cache.getCacheResultByKey!(key);
        if (allowed.length) return clone(cache.runtimeCacheMap.get(key));
        cache.runtimeCacheMap.delete(key);
      }
      if (pending()) return undefined;
      const prefix = quote(key + "-");
      // Never consult a renderer's stale exact-version index. Also discovers
      // entries written after this renderer's initialization. Legacy duplicates
      // are read deterministically until the next replacement normalizes them.
      const result = await rows(
        `select id, jsonStr from requestCache WHERE substr(id, 1, length(${prefix})) = ${prefix} ORDER BY CAST(substr(id, length(${prefix}) + 1) AS INTEGER) DESC LIMIT 1;`
      );
      if (cache.runtimeCacheMap.has(key))
        return clone(cache.runtimeCacheMap.get(key));
      if (pending()) return undefined;
      const row = result[0];
      if (!row) {
        cache.cachedKeys.delete(key);
        return undefined;
      }
      cache.cachedKeys.set(
        key,
        Number(row.id.slice(row.id.lastIndexOf("-") + 1))
      );
      return clone(JSON.parse(JSON.parse(row.jsonStr).cache));
    } catch (error) {
      options.report(error);
      return undefined;
    }
  };

  async function flushSnapshots() {
    while (cache.runtimeCacheMap.size || cache.toBeCleanCacheMap.size) {
      const entries = new Map(
        Array.from(cache.runtimeCacheMap, ([key, value]) => [
          key,
          {
            value,
            version: cache.cachedKeys.get(key),
            ticket: tickets.get(key),
          },
        ])
      );
      const cleanup = new Map(cache.toBeCleanCacheMap);
      const sql = [
        ...schema,
        "CREATE TABLE IF NOT EXISTS requestCache (id VARCHAR(40) NOT NULL PRIMARY KEY, jsonStr TEXT);",
      ];
      for (const [key, { value, version, ticket }] of entries) {
        if (ticket === undefined)
          throw new Error("Request cache entry has no ordering ticket");
        if (version === undefined)
          throw new Error("Request cache entry has no version");
        const id = key + "-" + version;
        // Match Database.put's on-disk format. Database.get deserializes this
        // envelope; getCacheResultByKey then deserializes its cache field.
        const jsonStr = JSON.stringify({ id, cache: JSON.stringify(value) });
        sql.push(
          deleteVersions(key).replace(";", ` AND ${accept(key, ticket)};`),
          `INSERT INTO requestCache (id, jsonStr) SELECT ${quote(id)}, ${quote(jsonStr)} WHERE ${accept(key, ticket)};`,
          `INSERT OR IGNORE INTO requestCacheOrder (key, ticket) VALUES (${quote(key)}, 0);`,
          `UPDATE requestCacheOrder SET ticket = ${ticket} WHERE key = ${quote(key)} AND ticket < ${ticket};`
        );
      }
      for (const [key, versions] of cleanup) {
        // Replacements already clean all older versions without deleting
        // themselves. A key with no replacement is a cross-key invalidation
        // (e.g. refreshing page 1 invalidates cached later pages).
        if (entries.has(key) || !versions.length) continue;
        const ticket = cleanupTickets.get(versions);
        if (ticket === undefined)
          throw new Error("Request cache cleanup has no ordering ticket");
        sql.push(...orderedDelete(key, ticket));
      }
      // Replacements and predecessor removal commit together. Pending maps
      // remain readable and retryable until the native commit acknowledges.
      await execute(sql);
      for (const [key, { value, version, ticket }] of entries) {
        if (
          cache.runtimeCacheMap.get(key) === value &&
          tickets.get(key) === ticket &&
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
        // Identity matters: a repeated invalidation of the same numeric
        // version during COMMIT must survive into the next transaction.
        if (cache.toBeCleanCacheMap.get(key) === versions)
          cache.toBeCleanCacheMap.delete(key);
      }
      // Updates received during the transaction are flushed in the next pass.
    }
  }

  async function invalidationTicket(request: Invalidation) {
    if (request.ticket !== undefined) return request.ticket;
    request.allocation ??= cache.allocateCacheTicket!();
    try {
      return (request.ticket = await request.allocation);
    } finally {
      request.allocation = undefined;
    }
  }

  async function evict() {
    const requests = invalidations.slice();
    for (const request of requests) await invalidationTicket(request);
    const { maxCacheCountInLocal: limit, overCleanPercentInLocal: percent } =
      options.limits();
    const byPrivilege = requests.some((reason) => reason.privilege);
    // Renderer startup indexes are hints, not an inventory of the shared DB.
    const stored = await readStoredKeys();
    const bySize = stored.size > limit;
    if (!byPrivilege && !bySize) {
      invalidations.splice(0, requests.length);
      return;
    }
    if (!requests.length) {
      // Automatic size eviction is an ordered operation too. Retain its ticket
      // across a failed commit rather than turning its retry into a new event.
      const request: Invalidation = { privilege: false, size: true };
      requests.push(request);
      invalidations.push(request);
      await invalidationTicket(request);
    }
    const ticket = Math.max(...requests.map((request) => request.ticket!));
    const privilegeTicket = Math.max(
      0,
      ...requests
        .filter((request) => request.privilege)
        .map((request) => request.ticket!)
    );
    const removalTickets = new Map<string, number>();
    const candidates = Array.from(stored, ([key, version]) => ({
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
          removalTickets.set(entry.key, privilegeTicket);
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
        removalTickets.set(entry.key, ticket);
      }
    }
    const sql = [...schema];
    if (byPrivilege) {
      const uid = quote(JSON.stringify(options.uid()) ?? "null");
      sql.push(
        `INSERT OR IGNORE INTO requestCachePrivilege (uid, ticket) VALUES (${uid}, 0);`,
        `UPDATE requestCachePrivilege SET ticket = ${privilegeTicket} WHERE uid = ${uid} AND ticket < ${privilegeTicket};`
      );
    }
    for (const [key] of remove)
      sql.push(...orderedDelete(key, removalTickets.get(key)!));
    await execute(sql);
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
        for (const response of responses) await response.promise;
        await flushSnapshots();
        await evict();
        if (
          !cache.runtimeCacheMap.size &&
          !cache.toBeCleanCacheMap.size &&
          !invalidations.length &&
          !responses.size
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

  cache.updateToBeCleanCacheMap = (key, ticket) => {
    if (ticket === undefined)
      return cache.allocateCacheTicket!().then((allocated) =>
        cache.updateToBeCleanCacheMap(key, allocated)
      );
    if ((tickets.get(key) ?? 0) > ticket) return;
    tickets.set(key, ticket);
    // Explicit invalidation must tombstone even a key absent from this index:
    // it may exist only in another renderer's uncommitted response.
    const version = cache.cachedKeys.get(key) ?? 0;
    const versions = cache.toBeCleanCacheMap.get(key) ?? [];
    const next = [...versions, version];
    cache.toBeCleanCacheMap.set(key, next);
    if (ticket !== undefined) cleanupTickets.set(next, ticket);
    // Upstream calls this both before replacing this key and when invalidating
    // later pages. A pending later page must not be written as a replacement.
    cache.runtimeCacheMap.delete(key);
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

  cache.invalidateCache = async (reason) => {
    const request: Invalidation = { ...reason };
    invalidations.push(request);
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
