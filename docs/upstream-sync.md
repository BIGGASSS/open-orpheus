# Selective upstream sync

## Current packaging policy: Nix only

This fork now uses `nix build`, `nix run`, `nix flake check`, and `nix develop` as its public build interface. See [building.md](building.md). pnpm and Cargo remain internal tools, with `pnpm-lock.yaml` and `Cargo.lock` retained alongside `flake.lock`.

- Build natively for `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`; no Windows or cross-compilation pipeline. Intel Macs are unsupported because the pinned nixpkgs 26.11 removed support. Native CI checks builds and tests; graphical runtime behavior needs testing on each target system.
- Run unconditional checks and default-package builds on every PR/push using the three native GitHub runners. Export complete Nix runtime closures for each system.
- Release only from `v*` tag pushes, after checking the tag against `package.json`, using the immutable triggering commit and GitHub-generated release notes.
- The old distro packaging, Copr/Flathub automation, AppImage/Windows releases, change filters, and Zig release-toolchain adaptations are superseded. Do not reintroduce them in future syncs. This is a policy for this repository, not a claim that upstream or third-party channels have shut down.

## 2026-09-15 — reviewed through `0666c4b`

Source: `YUCLing/open-orpheus`, changes since `b4508e9`.
This was a selective import, not a complete adoption of upstream v0.17.1.

### Included

- Unit tests from `9da8939`, including checkout-independent fixtures and quiet malformed skin-template parsing.
- Linux packaging/toolchain changes from `2e05196` and the intent of the Copr fix in `0666c4b` were imported at the time. Their packaging implementation and CI adaptations have since been replaced by the Nix policy above.

### Retained fork adaptations

- Keep `pnpm test` running both AVA and Vitest under Nix.
- Keep offline-cache, cloud-drive, tray, and shutdown fixes unchanged.

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
`modules/audio-effect/dist` declaration changes were not imported. The selective
sync retained v0.17.0 rather than claim the deferred playback fix.
