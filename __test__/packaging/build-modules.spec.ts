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

const hostFlags =
  " -O2\t-flto=auto -ffat-lto-objects -march=x86-64-v3 -mtune=generic " +
  "-fno-omit-frame-pointer -mno-omit-leaf-frame-pointer -fstack-protector-strong ";
const rustFlags = "-C debuginfo=1";

// Run the actual entry point against temporary modules and a fake pnpm. No
// native compiler or checkout build artifacts are involved.
describe("build-modules script selection", () => {
  const execFile = promisify(execFileCb);
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orpheus-module-build-"));
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await copyFile(
      resolve(import.meta.dirname, "../../scripts/build-modules.ts"),
      join(root, "scripts/build-modules.ts")
    );
    const modules = {
      native: {
        scripts: {
          build: "native",
          "build:debug": "debug",
          [`build:debug:${process.platform}`]: "must-not-be-selected",
        },
      },
      wasm: {
        scripts: { build: "wasm" },
        dependencies: { "@fixture/native": "workspace:*" },
      },
      excluded: {
        scripts: { build: "excluded", "build:debug": "excluded" },
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

  it("defaults to native builds and preserves host build flags", async () => {
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

  it("keeps preferred scripts exact and preserves flags for WASM fallbacks", async () => {
    await runBuild({ PREFER_SCRIPT: "build:debug" });
    for (const module of ["native", "wasm"]) {
      expect(await readBuild(module)).toEqual({
        args: ["run", module === "native" ? "build:debug" : "build"],
        CFLAGS: hostFlags,
        CXXFLAGS: hostFlags,
        RUSTFLAGS: rustFlags,
      });
    }
  });

  it("falls back to build when the preferred script is missing", async () => {
    await runBuild({ PREFER_SCRIPT: "missing" });
    for (const module of ["native", "wasm"]) {
      expect(await readBuild(module)).toMatchObject({
        args: ["run", "build"],
      });
    }
  });

  it("skips missing preferred scripts when SKIP_IF_NO_SCRIPT is set", async () => {
    await runBuild({ PREFER_SCRIPT: "build:debug", SKIP_IF_NO_SCRIPT: "1" });
    expect(await readBuild("native")).toMatchObject({
      args: ["run", "build:debug"],
    });
    await expect(readBuild("wasm")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
