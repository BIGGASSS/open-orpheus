# Building with Nix

The flake is the build and release entry point. It builds the Rust N-API modules,
WASM audio effects, lifecycle library, Svelte GUI, and Electron application from
this checkout. Forge remains an internal bundler; it no longer makes installers.

## Requirements and commands

Install Nix with `nix-command` and `flakes` enabled. Supported native hosts are
`x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`. The pinned nixpkgs no longer
supports Intel macOS. Windows and cross-compilation are not supported by this
build pipeline; existing platform-specific application code is retained.

```sh
nix build                     # result -> complete installed application
nix run                       # run it, or: nix run . -- <application arguments>
nix flake check -L             # build, package validation, tests, lint, Rust checks
nix develop                   # enter the pinned development environment
nix fmt flake.nix nix/default.nix # format Nix expressions
```

No host Node, pnpm, Rust, Zig, or system development libraries are required.
Nix initially needs network access for fixed-output dependency downloads and
binary caches. CI explicitly enables `sandbox = true` on Linux and macOS; enable
it in your local Nix configuration too. Application compilation and checks use
vendored Cargo dependencies, the offline pnpm store, and a hash-verified Electron
ZIP. They do not download NetEase assets or disable Electron checksum validation.
`flake.lock`, `pnpm-lock.yaml`, and `Cargo.lock` must all remain committed.

New files must be added to Git before a Git-backed flake sees them. The build also
uses a source allow-list in `nix/default.nix`; update it when introducing a new
build input. Local `node_modules`, `target`, `.vite`, `out`, generated module
binaries, and private `data` directories are never build inputs.

## Development

Inside `nix develop`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:modules
pnpm start
pnpm test
pnpm lint
```

The shell provides the same pinned toolchain and patched Electron distribution
as the build. Electron's npm installer is disabled. Linux native npm libraries
can find the Nix C++ runtime and Fontconfig through the shell's library path.
Installing development dependencies is intentionally explicit, not a shell hook
with hidden network access. If switching from host-installed dependencies,
reinstall them inside this shell.

`pnpm build` and `pnpm package` forward to `nix build`. The module scripts and
Forge configuration are internal build steps, not alternative release pipelines.
`nix develop -c pnpm exec electron-forge package` can be useful for debugging,
but its mutable `out/` directory is not an installable Nix package.

## Installed application

Linux installs the full Electron distribution and ASAR under
`result/lib/open-orpheus`, with a launcher in `result/bin`, desktop/protocol
registration, AppStream metadata, and icons in `result/share`. macOS installs
`result/Applications/open-orpheus.app` and a command-line launcher. The final
macOS bundle is ad-hoc signed offline with rcodesign, preserving Electron's JIT
entitlements. It is not notarized; CI verifies the bundle with Apple's codesign.
Native libraries remain outside the ASAR. Package checks validate the installed archive,
not leftover workspace build products.

The launcher does **not** pass `--no-sandbox`. Linux needs usable unprivileged user
namespaces for Chromium's sandbox. Host security policy (including AppArmor on
some distributions) may need configuration. Nix does not install a setuid helper.
On non-NixOS Linux, hardware acceleration may require host driver integration
such as nixGL; graphics, audio, and the desktop session are runtime host concerns.

NetEase resources are not included. First launch downloads missing resources to
the user's writable application data directory as before. Desktop GUI, graphics,
media controls, and macOS signing still require testing on their native systems;
headless build checks are not a substitute for interactive smoke tests.

## Updating dependencies

Toolchain pins live in `flake.lock` and `nix/default.nix`. Additional fetched
artifacts and dependency-store hashes live in `nix/sources.json`.

1. Update application dependencies inside `nix develop` and regenerate
   `pnpm-lock.yaml` or `Cargo.lock` as appropriate.
2. Set `pnpmDepsHash` in `nix/sources.json` to the empty string when the pnpm lock,
   workspace configuration, patches, or pnpm version changes. Run:
   `nix build .#open-orpheus.pnpmDeps -L`. Copy the reported `got: sha256-…`
   into that field. The fetcher includes all supported platform optionals.
3. If changing the pinned `avs3a` Git revision, reset `avs3aHash` to the empty
   string, build `.#open-orpheus.cargoDeps`, and record the reported hash. Registry
   crates use checksums from `Cargo.lock`.
4. Keep the pnpm version in `package.json` and `nix/sources.json` identical. Its
   `hash` is the npm tarball hash (`nix store prefetch-file <tarball-url>`).
5. Keep Electron's version in `package.json` and `nix/sources.json` identical.
   Update every supported platform's ZIP SHA-256 from the release's
   `SHASUMS256.txt`; Nix verifies each ZIP independently.
6. The wasm-bindgen CLI must exactly match the workspace dependency and lockfile.
   Its source `hash` is an **unpacked** `fetchCrate` hash, not the tarball hash.
   Reset it, build `.#open-orpheus.wasm-bindgen`, and record the reported hash;
   then repeat with `cargoHash` to refresh its vendored dependencies.
7. Use `nix flake update` for nixpkgs/rust-overlay updates. Review the lock diff,
   check the selected Rust release still exists, and revalidate dependency hashes.
8. Run `nix flake check -L` and `nix build -L` on each supported native host before
   committing all changed locks and hashes.

## CI and release artifacts

PR and push CI uses the flake on all three native systems. Tag releases verify
that `v<version>` matches `package.json`, build that immutable commit, and publish
compressed Nix runtime closures (`.nar.zst`). These are **not** portable tarballs,
DEB/RPM/Flatpak/AppImage packages, or Windows installers. The old installer and
external-channel publishing scripts have been removed; independently maintained
external channels may still exist.

A closure can be imported on the matching system with:

```sh
zstd -dc open-orpheus-x86_64-linux.nar.zst | nix-store --import
```

Use the application store path printed by the import, or build/install the tagged
flake directly. Importing foreign closures requires an appropriately trusted Nix
user; only import artifacts whose provenance you trust. See
[the release checklist](RELEASE_CHECKLIST.md).
