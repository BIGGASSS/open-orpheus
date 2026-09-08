# Offline playlist persistence

The downloaded frontend has **two independent offline paths** in `webdb.dat`:

- `requestCache(id, jsonStr)` caches API responses. Its `jsonStr` contains
  `{ id, cache }`, where `cache` is another JSON-serialized response.
- Own-playlist views bypass that cache when offline. They read membership/order
  from `playlistTrackIds` and track objects from `dbTrack`. Both tables store
  `{ id, jsonStr }`, with the complete row serialized in `jsonStr`.

## Playlist snapshots

`src/main/compat/playlistCachePatch.ts` patches the shared playlist database
helpers and the playlist-detail generators in chunks 137 and 142. After merging
local-only tracks, every successful own-playlist refresh queues an atomic write
of its track objects and membership/order **before publishing the refreshed UI**.
The server timestamp no longer gates that write: an equal timestamp, or a local
reorder timestamp ahead of the server, must not preserve obsolete membership.
Empty lists and deletions replace the saved list too. Later track-detail fetches
continue to update `dbTrack` through the checked helper.

`playlistCacheRuntime.ts` bypasses SDK transaction/put helpers that swallow SQL
errors. It snapshots arguments synchronously, checks native transaction results,
retains failed writes, retries, and contributes to the shutdown barrier. A failed
save does not turn a successful online response into stale offline UI.

## Request cache and shared writers

`requestCachePatch.ts` / `requestCacheRuntime.ts` replace upstream's ten-minute
buffering and idle-scheduled writes. Pending data is cleared only after a checked
SQLite commit. Legacy startup duplicates are read using the greatest timestamp.
Reads consult the shared database rather than a renderer's stale version index.
Offline/error fallback does not require allocating a write ticket.

Both persistence runtimes reserve shared SQLite sequence tickets when handling
updates, not when retrying them. Conditional transactions prevent older retries
from replacing newer committed updates. The request cache retains per-key
invalidation high-water marks and privilege barriers so an older pending response
cannot resurrect an invalidated key. Local later-page invalidations also cancel
pending writes. Page discovery and size eviction use database snapshots; a page
first introduced concurrently after discovery can still escape that selection.

Ordering is the order of successful shared ticket reservations, not server
request-start order. This does not fix stale responses supplied by the server or
frontend's separate in-memory API cache.

## Failures and shutdown

Normal quit waits for trusted frontend frames' combined flush hooks, then the
native SQL worker queue barrier. Failures/timeouts offer **Retry**, **Cancel Quit**,
or **Quit Anyway**. Cancel Quit allows returning to the app to refresh online.

A write with an allocated ticket can retry safely. If initial ticket reservation
fails and its original ordering cannot be recovered, assigning a new ticket to
that old snapshot would risk overwriting another renderer's newer data. Instead,
the queue remains unresolved and shutdown reports the problem. Fetch a fresh
successful response (for playlist snapshots, covering the retained track rows as
well) to replace it; it is not silently acknowledged as saved. Playlist ticket
reservations with a lost acknowledgement recover their original nonce/ticket.

No cache reset or manual migration is needed. Small ordering tables are created
automatically; per-key high-water marks intentionally survive cache eviction.
Already-lost responses require another online fetch. Forced termination, power
loss before commit, and Quit Anyway can still lose memory-resident updates.

## Compatibility and validation

`src/main/orpheus.ts` applies both transformations to served JavaScript. Signed
archives on disk remain untouched. Every known minified anchor is checked before
serving a transformed script; incompatible recognized modules are refused with
an error log. Verify/update anchors and SDK SQL envelopes after frontend updates.
Keep serialized installers independent of module-scope imports and variables.

Run `pnpm test`. Regression tests use temporary SQLite and isolated renderer VMs,
including competing writers, invalidation, failed reservations/commits, and quit
ordering. An optional actual-archive test executes both patched playlist generators
(including persistence failures and local-only track merging); it skips if the
proprietary archive is absent.

Still smoke-test the packaged Electron app: refresh changed/reordered/deleted
songs online, quit normally, restart offline, and repeat across windows. Automated
storage/generator tests are not a substitute for that end-to-end UI test.
