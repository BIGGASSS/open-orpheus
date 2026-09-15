/**
 * Build a child-process environment without changing the caller's flags.
 * Only the explicit portable N-API script uses Zig; native builds and WASM
 * fallbacks must retain the host's flags (including RPM's RUSTFLAGS handling).
 */
export function moduleBuildEnv(
  script: string,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const result = { ...env };
  if (script !== "build:linux") return result;

  for (const name of ["CFLAGS", "CXXFLAGS"] as const) {
    const flags = env[name];
    if (flags === undefined) continue;

    // Keep quoted/escaped arguments intact while splitting the flag list.
    const args =
      flags.match(/(?:[^\s"'\\]|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/g) ?? [];
    result[name] = args
      .filter((arg, index) => {
        // Host CPU tuning and GCC's LTO variants are incompatible with our
        // portable Zig build. Frame-pointer and other hardening flags stay.
        if (arg === "-march" || arg === "-mtune") return false;
        if (args[index - 1] === "-march" || args[index - 1] === "-mtune") {
          return false;
        }
        return (
          arg !== "-flto=auto" &&
          arg !== "-ffat-lto-objects" &&
          !/^-m(?:arch|tune)=/.test(arg)
        );
      })
      .join(" ");
  }
  return result;
}
