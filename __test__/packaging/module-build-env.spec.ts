import { execFile as execFileCb } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { moduleBuildEnv } from "../../scripts/module-build-env.ts";
import {
  CARGO_ZIGBUILD_VERSION,
  ZIG_VERSION,
} from "../../packaging/common/toolchain.ts";
import { generateRules } from "../../packaging/deb/rules.ts";
import { generateSpec } from "../../packaging/rpm/spec.ts";

const hostFlags =
  " -O2\t-flto=auto -ffat-lto-objects -march=x86-64-v3 -mtune=generic " +
  "-fno-omit-frame-pointer -mno-omit-leaf-frame-pointer -fstack-protector-strong ";
const portableFlags =
  "-O2 -fno-omit-frame-pointer -mno-omit-leaf-frame-pointer -fstack-protector-strong";
const rustFlags = "-Clink-arg=-specs=/usr/lib/rpm/redhat/redhat-package-notes";

describe("moduleBuildEnv", () => {
  it.each(["build", "build:debug", "test", "build:linux:debug"])(
    "leaves the environment untouched for %s",
    (script) => {
      const env = Object.freeze({
        CFLAGS: hostFlags,
        CXXFLAGS: hostFlags,
        RUSTFLAGS: rustFlags,
        PREFER_SCRIPT: "build:linux",
      });
      expect(moduleBuildEnv(script, env)).toEqual(env);
    }
  );

  it("filters only portable C/C++ flags without mutating the caller", () => {
    const env = Object.freeze({
      CFLAGS: hostFlags,
      CXXFLAGS: hostFlags,
      RUSTFLAGS: rustFlags,
      LDFLAGS: "-flto=auto",
      PATH: "/tools/bin",
    });
    expect(moduleBuildEnv("build:linux", env)).toEqual({
      ...env,
      CFLAGS: portableFlags,
      CXXFLAGS: portableFlags,
    });
    expect(env.CFLAGS).toBe(hostFlags);
    expect(env.CXXFLAGS).toBe(hostFlags);
  });

  it("handles separate CPU arguments and preserves unrelated quoted flags", () => {
    const keep =
      '-DNAME="two  words" -DOTHER=two\\ words -flto=thin -fno-fat-lto-objects';
    expect(
      moduleBuildEnv("build:linux", {
        CFLAGS: `-march native -mtune generic ${keep} -flto=auto`,
      }).CFLAGS
    ).toBe(keep);
  });

  it("preserves unset and empty flag variables", () => {
    expect(moduleBuildEnv("build:linux", {})).toEqual({});
    expect(moduleBuildEnv("build:linux", { CFLAGS: "" })).toEqual({
      CFLAGS: "",
    });
    expect(moduleBuildEnv("build:linux", { CXXFLAGS: "-flto=auto" })).toEqual({
      CXXFLAGS: "",
    });
  });
});

// Run the actual entry point against temporary modules and a fake pnpm. No
// native compiler, Zig installation, or checkout build artifacts are involved.
describe("build-modules script selection", () => {
  const execFile = promisify(execFileCb);
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orpheus-module-build-"));
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    for (const script of ["build-modules.ts", "module-build-env.ts"]) {
      await copyFile(
        resolve(import.meta.dirname, "../../scripts", script),
        join(root, "scripts", script)
      );
    }
    const modules = {
      native: {
        scripts: {
          build: "native",
          "build:linux": "portable",
          "build:debug": "debug",
          "build:debug:linux": "must-not-be-selected",
        },
      },
      wasm: {
        scripts: { build: "wasm" },
        dependencies: { "@fixture/native": "workspace:*" },
      },
      excluded: {
        scripts: { build: "excluded", "build:linux": "excluded" },
        os: [`!${process.platform}`],
      },
    };
    for (const [name, pkg] of Object.entries(modules)) {
      const dir = join(root, "modules", name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: `@fixture/${name}`, ...pkg })
      );
    }
    await writeFile(
      join(root, "bin", "pnpm.cjs"),
      `const fs = require("node:fs");
fs.writeFileSync("build-result.json", JSON.stringify({
  args: process.argv.slice(2),
  CFLAGS: process.env.CFLAGS,
  CXXFLAGS: process.env.CXXFLAGS,
  RUSTFLAGS: process.env.RUSTFLAGS,
}));
`
    );
    await writeFile(
      join(root, "bin", process.platform === "win32" ? "pnpm.cmd" : "pnpm"),
      process.platform === "win32"
        ? '@"%MODULE_TEST_NODE%" "%MODULE_TEST_PNPM%" %*\r\n'
        : '#!/bin/sh\nexec "$MODULE_TEST_NODE" "$MODULE_TEST_PNPM" "$@"\n',
      { mode: 0o755 }
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function runBuild(env: NodeJS.ProcessEnv = {}) {
    const result = await execFile(
      process.execPath,
      ["scripts/build-modules.ts"],
      {
        cwd: root,
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
          MODULE_TEST_NODE: process.execPath,
          MODULE_TEST_PNPM: join(root, "bin", "pnpm.cjs"),
          PREFER_SCRIPT: "",
          SKIP_IF_NO_SCRIPT: "",
          CFLAGS: hostFlags,
          CXXFLAGS: hostFlags,
          RUSTFLAGS: rustFlags,
          ...env,
        },
      }
    );
    await expect(
      readFile(join(root, "modules/excluded/build-result.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    return result;
  }

  async function readBuild(module: string) {
    return JSON.parse(
      await readFile(
        join(root, "modules", module, "build-result.json"),
        "utf-8"
      )
    );
  }

  it("defaults to native build even when build:linux exists", async () => {
    await runBuild();
    for (const module of ["native", "wasm"]) {
      expect(await readBuild(module)).toEqual({
        args: ["run", "build"],
        CFLAGS: hostFlags,
        CXXFLAGS: hostFlags,
        RUSTFLAGS: rustFlags,
      });
    }
  });

  it("opts in explicitly, sanitizing only the portable command, not WASM fallback", async () => {
    await runBuild({ PREFER_SCRIPT: "build:linux" });
    expect(await readBuild("native")).toEqual({
      args: ["run", "build:linux"],
      CFLAGS: portableFlags,
      CXXFLAGS: portableFlags,
      RUSTFLAGS: rustFlags,
    });
    expect(await readBuild("wasm")).toEqual({
      args: ["run", "build"],
      CFLAGS: hostFlags,
      CXXFLAGS: hostFlags,
      RUSTFLAGS: rustFlags,
    });
  });

  it("keeps custom preferred scripts exact rather than selecting platform variants", async () => {
    await runBuild({ PREFER_SCRIPT: "build:debug" });
    expect(await readBuild("native")).toMatchObject({
      args: ["run", "build:debug"],
      CFLAGS: hostFlags,
    });
    expect(await readBuild("wasm")).toMatchObject({
      args: ["run", "build"],
      CFLAGS: hostFlags,
    });
  });

  it("still skips missing preferred scripts when SKIP_IF_NO_SCRIPT is set", async () => {
    await runBuild({ PREFER_SCRIPT: "build:linux", SKIP_IF_NO_SCRIPT: "1" });
    expect(await readBuild("native")).toMatchObject({
      args: ["run", "build:linux"],
    });
    await expect(readBuild("wasm")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("source packaging toolchains", () => {
  async function renderTemplates(installTools: boolean, prebuilt = false) {
    const options = {
      name: "open-orpheus",
      cargoZigbuild: CARGO_ZIGBUILD_VERSION,
      zig: ZIG_VERSION,
      installTools,
      prebuilt,
    };
    return Promise.all([
      generateRules(options),
      generateSpec({
        ...options,
        version: "0.17.0",
        release: "1",
        summary: "test",
        description: "test",
        license: "MIT",
        homepage: "https://example.com",
        nodeVersion: "24",
        wasmBindgen: "0.2.100",
        changelog: "",
      }),
    ]);
  }

  it.each([true, false])(
    "opts source builds in with installTools=%s",
    async (installTools) => {
      const templates = await renderTemplates(installTools);
      for (const template of templates) {
        expect(template).toContain(
          "PREFER_SCRIPT=build:linux pnpm run build:modules"
        );
        expect(
          template.includes(
            `cargo install --locked "cargo-zigbuild@${CARGO_ZIGBUILD_VERSION}"`
          )
        ).toBe(installTools);
        expect(
          template.includes(`https://ziglang.org/download/${ZIG_VERSION}/`)
        ).toBe(installTools);
        expect(template.includes("ln -sf")).toBe(installTools);
        expect(template).not.toContain("rust-cross/cargo-zigbuild/releases");
        expect(template).not.toContain("strip_flags");
        expect(template).not.toContain("export CFLAGS=");
      }
      expect(templates[1]).toContain('ORIGINAL_RUSTFLAGS="$RUSTFLAGS"');
      expect(templates[1]).toContain(
        "sed 's|-Clink-arg=-specs=/usr/lib/rpm/redhat/redhat-package-notes||g'"
      );
      expect(templates[1]).toContain('export RUSTFLAGS="$ORIGINAL_RUSTFLAGS"');
    }
  );

  it("does not install toolchains or compile modules for prebuilt packages", async () => {
    for (const template of await renderTemplates(true, true)) {
      expect(template).not.toContain("cargo install");
      expect(template).not.toContain("build:modules");
    }
  });
});
