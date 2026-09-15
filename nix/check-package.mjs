// Validate the installed ASAR, rather than accidentally testing source outputs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "package.json"));
const { listPackage, extractFile } = require("@electron/asar");
const [out, platform] = process.argv.slice(2);
const resources =
  platform === "darwin"
    ? join(out, "Applications/open-orpheus.app/Contents/Resources")
    : join(out, "lib/open-orpheus/resources");
const archive = join(resources, "app.asar");
const files = listPackage(archive).map((file) => file.replaceAll("\\", "/"));
const has = (pattern) =>
  assert(
    files.some((file) => pattern.test(file)),
    `Missing ${pattern}`
  );
const manifest = JSON.parse(extractFile(archive, "package.json").toString());
assert.equal(manifest.name, "open-orpheus");
assert.equal(manifest.main, ".vite/build/main.js");
if (platform === "linux") {
  // Electron defaults to <name>.desktop; MPRIS advertises "open-orpheus".
  const desktopName = manifest.desktopName ?? `${manifest.name}.desktop`;
  assert.equal(desktopName, "open-orpheus.desktop");
  const desktop = readFileSync(
    join(out, "share/applications", desktopName),
    "utf8"
  );
  assert.match(desktop, /^Exec=open-orpheus %U$/m);
  assert.match(desktop, /^Icon=open-orpheus$/m);
  assert.match(desktop, /^MimeType=x-scheme-handler\/orpheus;$/m);
  const metainfo = readFileSync(
    join(out, "share/metainfo/io.github.yucling.open-orpheus.metainfo.xml"),
    "utf8"
  );
  assert(
    metainfo.includes(
      `<launchable type="desktop-id">${desktopName}</launchable>`
    ),
    "AppStream launchable must match the installed desktop file"
  );
}
for (const entry of [
  "main",
  "preload",
  "manage",
  "package-download",
  "desktop-lyrics",
  "desktop-lyrics-preview",
  "mini-player",
  "menu",
]) {
  assert(files.includes(`/.vite/build/${entry}.js`), `Missing entry ${entry}`);
}
for (const worklet of [
  "audio-effect",
  "av3a-player",
  "music-recorder",
  "pcm-honeypot",
]) {
  assert(
    files.includes(`/.vite/build/worklets/${worklet}.js`),
    `Missing worklet ${worklet}`
  );
}
has(/\/\.vite\/build\/gui\/index\.html$/);
has(/\/\.vite\/build\/gui\/.*\.css$/);
has(/\/\.vite\/build\/gui\/.*\.js$/);
has(/\/\.vite\/build\/worklets\/assets\/audio_effect_bg\.wasm$/);
has(/\/\.vite\/build\/assets\/av3a-decoder-[^/]+\.js$/);
has(/\/\.vite\/build\/pino-worker-[^/]+\.js$/);
has(/\/\.vite\/build\/thread-stream-worker-[^/]+\.js$/);
for (const module of [
  "database",
  "window",
  "ui",
  "av3a",
  platform === "darwin" ? "nowplaying" : "dbus",
]) {
  const binding = files.find(
    (file) =>
      file.includes(`/@open-orpheus/${module}/`) && file.endsWith(".node")
  );
  assert(binding, `Missing native module ${module}`);
  assert(files.includes(`/node_modules/@open-orpheus/${module}/index.js`));
}
const suffix = `.${platform}-${process.arch}${platform === "linux" ? "-gnu" : ""}.node`;
for (const binding of files.filter((file) => file.endsWith(".node"))) {
  assert(binding.endsWith(suffix), `Wrong platform binding: ${binding}`);
  const path = join(resources, "app.asar.unpacked", binding);
  assert(existsSync(path), `${binding} must be unpacked`);
  // Loading tests ELF/Mach-O dependencies and N-API registration without
  // starting Electron, opening windows, or downloading application data.
  require(path);
}
has(/\/music-tag-native-[^/]+\/.*\.node$/);
has(/\/7z-wasm\/.*\.wasm$/);
has(/\/photon-node\/.*\.wasm$/);
assert(existsSync(join(out, "bin/open-orpheus")));
assert(
  readFileSync(join(out, "share/licenses/open-orpheus/LICENSE")).length > 0
);
const { getCurrentFuseWire, FuseV1Options, FuseState } = await import(
  require.resolve("@electron/fuses")
);
const executable =
  platform === "darwin"
    ? join(out, "Applications/open-orpheus.app")
    : join(out, "lib/open-orpheus/open-orpheus");
const fuses = await getCurrentFuseWire(executable);
for (const option of [
  "RunAsNode",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "GrantFileProtocolExtraPrivileges",
]) {
  assert.equal(fuses[FuseV1Options[option]], FuseState.DISABLE, option);
}
for (const option of [
  "EnableCookieEncryption",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
]) {
  assert.equal(fuses[FuseV1Options[option]], FuseState.ENABLE, option);
}
console.log("Installed package layout, native bindings and fuses OK");
