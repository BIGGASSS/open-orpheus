# Internal build helpers

The supported build and packaging interface is Nix. From the repository root:

```sh
nix build .#default
nix run
nix flake check
```

For development, use the pinned tools in `devShells.default`:

```sh
nix develop
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:modules
pnpm start
pnpm test
pnpm lint
```

`build-modules.ts` builds compatible workspace modules in dependency order; `gui-wrapper.ts` runs the GUI Vite build or development server. These are internal helpers, not alternative release commands. pnpm and Cargo remain build tools with committed lockfiles. Do not restore the old distro packagers, external-channel publishing helpers, or cross-compilation tool installers.

If manually invoking a TypeScript helper with extensionless imports produces `ERR_MODULE_NOT_FOUND`, run it from the repository root inside `nix develop` with the loader:

```sh
node --loader ./scripts/_loader.ts ./scripts/<helper>.ts
```

See [the building guide](../docs/building.md) for supported native systems, dependency updates, closure artifacts, and troubleshooting, and [the release checklist](../docs/RELEASE_CHECKLIST.md) for tag-based publishing.
