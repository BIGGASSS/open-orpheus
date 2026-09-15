# Selective upstream sync

## 2026-09-15 — reviewed through `0666c4b`

Source: `YUCLing/open-orpheus`, changes since `b4508e9`.
This is a selective import, not a complete adoption of upstream v0.17.1.

### Included

- Unit tests and CI from `9da8939`, including checkout-independent packaging
  fixtures, Flatpak build/lint checks, and quiet malformed skin-template parsing.
- Linux packaging/toolchain improvements from `2e05196` and the intent of the
  Copr fix in `0666c4b`, with the adaptations below.

### Fork adaptations

- Keep `pnpm test` running both AVA and Vitest. CI filters include `test/**`,
  and Flatpak filters also cover build scripts, modules and dependency patches.
- Preserve the fork's explicit symlink assertions rather than restoring the
  obsolete util snapshot.
- Keep local `pnpm build:modules` native. Release CI and source packagers opt
  into Zig explicitly with `PREFER_SCRIPT=build:linux`; modules without that
  script fall back to their ordinary build.
- Sanitize incompatible C/C++ flags at the Zig subprocess boundary, not only
  in RPM packaging. Preserve frame-pointer flags and native build environments.
- Compile cargo-zigbuild on deb/RPM build hosts instead of downloading a GNU
  executable that itself requires a newer glibc. Flatpak keeps checksummed
  offline toolchains inside its known runtime.
- Keep offline-cache, cloud-drive, tray and shutdown fixes unchanged.

### Deferred

Do not import `7a6833a` (media-session play/pause state tracking), or the later
router-test additions that depend on it, until these reviewed cases are handled:

1. Rapid MPRIS `PlayPause` calls must remain toggles, not collapse into identical
   absolute requests derived from stale native state.
2. Pause must still cancel an accepted restart when loading exceeds the router's
   three-second intent timeout.
3. Late AV3A PCM after pausing must not produce stale Playing status that causes
   subsequent OS Play to be discarded.

`src/main/playback/PlayerCommandRouter.ts` and `src/main/mediaSession.ts` remain
at their pre-sync implementations. These are deferrals, not fixes to the
existing absolute Play/Pause behavior. Revisit upstream router tests together
with the eventual playback fix.

The v0.17.1 version/release notes from `01a9052` and unrelated generated
`modules/audio-effect/dist` declaration changes are not imported. The fork
continues to identify as v0.17.0 rather than claim the deferred playback fix.
