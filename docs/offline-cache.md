# Offline request-cache persistence

The song-list fallback is owned by the downloaded frontend's `api.dbcache`
module, not the audio-file cache. Its rows live in `webdb.dat`, in
`requestCache(id, jsonStr)`. `jsonStr` contains `{ id, cache }`, where `cache` is
itself a JSON-serialized response.

The upstream implementation buffered up to 50 entries for ten minutes. Even its
forced flush only scheduled an idle callback and cleared the pending map before
SQLite committed. Awaiting that flush during exit therefore did not guarantee
persistence. Its startup key scan also chose whichever version happened to be
returned last, rather than the greatest timestamp. The SDK's `transaction`/`put`
helpers can swallow SQL errors, so awaiting those helpers alone is insufficient.

## Host compatibility fix

- `src/main/compat/requestCachePatch.ts` transforms the cache module when
  `src/main/orpheus.ts` serves JavaScript. It patches both app and sub-app bundles;
  the signed archive on disk is never edited. Startup selects the greatest
  timestamp, and subsequent per-key timestamps increase monotonically.
- `requestCacheRuntime.ts` installs a self-contained persistence implementation.
  Every successful cache update requests a flush. Writes, superseded-version
  cleanup, and explicit invalidations are serialized. Pending data is cleared
  only after the checked native transaction result acknowledges success.
- Responses arriving during a write or eviction are drained before the shared
  flush completes. Failures retain pending work and schedule retries. Eviction
  deletes historical versions too, preventing their resurrection after restart.
- `src/main/shutdown.ts` makes normal application quit await each trusted frontend
  frame's flush hook, then the native SQL worker queue barrier. Timeout/failure
  offers **Retry** or **Quit Anyway**, rather than silently discarding pending data.

No cache reset or database migration is needed. Already-lost responses cannot be
recovered without another online fetch. Forced process termination, power loss
before commit, or explicitly choosing Quit Anyway can still lose pending work.

## Updating the frontend package

The patch intentionally verifies every known minified-code anchor before applying
any changes. An incompatible cache module is refused with an error log instead
of being partially patched. When upstream changes this module, update the anchors
and verify the SQL envelope, initialization, response, and invalidation contracts.
Keep the serialized installer independent of module-scope variables/imports.

Regression coverage is in `test/requestCache.test.ts` and
`test/shutdown.test.ts`; run `pnpm test`. Tests use real temporary SQLite storage,
an isolated renderer realm, and a small webpack-shaped fixture, without requiring
the downloaded frontend. Also smoke-test the current downloaded app and sub-app
bundles after changing the patch, including a short online session followed by a
normal quit and an offline restart.
