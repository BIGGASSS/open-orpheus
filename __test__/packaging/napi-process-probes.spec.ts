import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

// Regression coverage for the @napi-rs/cli 3.9.0 process-incarnation probes.
// `execFile` can throw *synchronously* (e.g. EPERM when macOS sandboxing
// denies the process identity probes), and `executeProcessIncarnationCommand`
// must treat that exactly like the asynchronous spawn-error callback and
// resolve null instead of rejecting and aborting filesystem-lock
// reconciliation. `processOwnerState` must then never turn that unavailable
// identity into a "stale" verdict for a live or unverifiable lock owner.
//
// These helpers are not exported directly. Extract them from the pinned
// bundles and run them in isolated vm contexts with stubbed process probes.
// This exercises the shipped dependency on every host, without running native
// builds, spawning ps/sysctl/ioreg, or mutating host globals. Extraction fails
// loudly if a dependency update changes the expected function boundaries.

const bundles = ["dist/cli.js", "dist/index.js", "dist/index.cjs"] as const;

// Resolve the dependency through a workspace module that actually owns it so
// this suite needs no root devDependency on @napi-rs/cli.
const napiCliRequire = createRequire(
  resolve(import.meta.dirname, "../../modules/window/package.json")
);
const napiCliDirectory = dirname(
  napiCliRequire.resolve("@napi-rs/cli/package.json")
);

/**
 * Extract a top-level (optionally `async`) `function name(...) { ... }`
 * declaration from a shipped bundle. The bundler emits top-level declarations
 * at column 0, so the body runs to the first closing brace in column 0. The
 * declaration marker must occur exactly once — any drift in the pinned
 * @napi-rs/cli fails here instead of silently testing a reimplementation.
 */
function extractBundleFunction(
  bundle: string,
  source: string,
  name: string
): string {
  const marker = `function ${name}(`;
  const found = source.indexOf(marker);
  if (found === -1 || source.indexOf(marker, found + 1) !== -1) {
    throw new Error(
      `${bundle}: expected exactly one \`${marker}\` declaration`
    );
  }
  const start = source.lastIndexOf("\n", found) + 1;
  const prefix = source.slice(start, found);
  if (prefix !== "" && prefix !== "async ") {
    throw new Error(`${bundle}: ${name} is not a top-level declaration`);
  }
  const lines = source.slice(start).split("\n");
  const end = lines.findIndex((line) => line === "}");
  if (end <= 0) {
    throw new Error(`${bundle}: cannot find the end of ${name}`);
  }
  return lines.slice(0, end + 1).join("\n");
}

function spawnError(code: string): Error & { code: string } {
  return Object.assign(new Error(`spawn ${code}`), { code });
}

type ExecFileCallback = (
  error: (Error & { code?: string }) | null,
  stdout: string
) => void;

interface ExecFileInvocation {
  args: string[];
  callback: ExecFileCallback;
  command: string;
  options: {
    encoding?: unknown;
    env?: unknown;
    timeout?: unknown;
    windowsHide?: unknown;
  };
}

type ExecuteProcessIncarnationCommand = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<string | null>;

interface ProbeHarness {
  defaultEnv: NodeJS.ProcessEnv;
  invocations: ExecFileInvocation[];
  probe: ExecuteProcessIncarnationCommand;
  respondWith: (behavior: (invocation: ExecFileInvocation) => void) => void;
  timeout: number;
}

/**
 * Load the bundle's real `executeProcessIncarnationCommand` with a scripted
 * execFile double. The sentinel timeout differs from the bundle's built-in
 * 2000ms so the forwarding assertions prove the module-scope binding is used.
 */
function createProbeHarness(bundle: string, source: string): ProbeHarness {
  const extracted = extractBundleFunction(
    bundle,
    source,
    "executeProcessIncarnationCommand"
  );
  const invocations: ExecFileInvocation[] = [];
  let behavior: (invocation: ExecFileInvocation) => void = () => {};
  const execFile = (
    command: string,
    args: string[],
    options: ExecFileInvocation["options"],
    callback: ExecFileCallback
  ): void => {
    const invocation: ExecFileInvocation = { args, callback, command, options };
    invocations.push(invocation);
    behavior(invocation);
  };
  const defaultEnv = { NAPI_PROCESS_PROBE: "sentinel" };
  const timeout = 1337;
  const context = createContext({
    // The ESM bundles import execFile directly while the CJS bundle
    // dereferences the node:child_process namespace import; bind both names
    // to the same double.
    execFile,
    node_child_process: { execFile },
    process: { env: defaultEnv },
    processIncarnationCommandTimeout: timeout,
  });
  const probe = runInContext(
    `${extracted}\nexecuteProcessIncarnationCommand;`,
    context
  ) as ExecuteProcessIncarnationCommand;
  return {
    defaultEnv,
    invocations,
    probe,
    respondWith: (next) => {
      behavior = next;
    },
    timeout,
  };
}

describe.each(bundles)("executeProcessIncarnationCommand (%s)", (bundle) => {
  let source: string;

  beforeAll(async () => {
    source = await readFile(join(napiCliDirectory, bundle), "utf8");
  });

  // The regression itself: without the try/catch around execFile this promise
  // rejects with EPERM and breaks lock reconciliation on sandboxed hosts.
  it("resolves null when execFile throws synchronously with EPERM", async () => {
    const harness = createProbeHarness(bundle, source);
    harness.respondWith(() => {
      throw spawnError("EPERM");
    });
    await expect(
      harness.probe("/bin/ps", ["-o", "lstart=", "-p", "42"])
    ).resolves.toBe(null);
    expect(harness.invocations).toHaveLength(1);
  });

  it.each(["ENOENT", "EPERM"])(
    "resolves null on an asynchronous %s spawn error",
    async (code) => {
      const harness = createProbeHarness(bundle, source);
      harness.respondWith(({ callback }) => {
        queueMicrotask(() => callback(spawnError(code), ""));
      });
      await expect(
        harness.probe("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
      ).resolves.toBe(null);
    }
  );

  it("resolves the trimmed stdout on success", async () => {
    const harness = createProbeHarness(bundle, source);
    harness.respondWith(({ callback }) =>
      callback(null, "  1507632000000 \r\n")
    );
    await expect(harness.probe("probe", [])).resolves.toBe("1507632000000");
  });

  it.each(["", " \t\r\n"])(
    "resolves null for empty output %j",
    async (stdout) => {
      const harness = createProbeHarness(bundle, source);
      harness.respondWith(({ callback }) => callback(null, stdout));
      await expect(harness.probe("probe", [])).resolves.toBe(null);
    }
  );

  it("forwards command, args, env, timeout and windowsHide", async () => {
    const harness = createProbeHarness(bundle, source);
    harness.respondWith(({ callback }) => callback(null, "ok"));
    const env = { LANG: "C", LC_ALL: "C", TZ: "UTC" };
    await harness.probe("/bin/ps", ["-o", "lstart=", "-p", "42"], env);
    expect(harness.invocations).toHaveLength(1);
    const [invocation] = harness.invocations;
    expect(invocation.command).toBe("/bin/ps");
    expect(invocation.args).toEqual(["-o", "lstart=", "-p", "42"]);
    expect(invocation.options).toEqual({
      encoding: "utf8",
      env,
      timeout: harness.timeout,
      windowsHide: true,
    });
  });

  it("defaults env to process.env when none is passed", async () => {
    const harness = createProbeHarness(bundle, source);
    harness.respondWith(({ callback }) => callback(null, "ok"));
    await harness.probe("probe", []);
    expect(harness.invocations[0].options.env).toBe(harness.defaultEnv);
  });
});

interface ProcessExecutionIdentity {
  boot: string | null;
  bootSession: string | null;
  machine: string | null;
  namespace: string | null;
}

interface LockOwner {
  boot?: unknown;
  bootSession?: unknown;
  incarnation?: unknown;
  machine?: unknown;
  namespace?: unknown;
  pid?: unknown;
}

interface OwnerState {
  stale: boolean;
  unverifiableReason?: string;
}

interface OwnerStateHarness {
  classify: (owner: LockOwner) => Promise<OwnerState>;
  killCalls: Array<{ pid: number; signal: number }>;
  setCurrentIdentity: (identity: ProcessExecutionIdentity) => void;
  setObservedIncarnation: (incarnation: string | null) => void;
  setOwnerAlive: (alive: boolean) => void;
}

// Realistic linux identity values; the helpers only compare them for
// (in)equality, so any distinct sentinel strings would do.
const localIdentity: ProcessExecutionIdentity = {
  boot: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  bootSession: null,
  machine:
    "linux-machine:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  namespace: "linux-pid-namespace:pid:[4026531836]",
};

const liveOwner: LockOwner = {
  boot: localIdentity.boot,
  machine: localIdentity.machine,
  namespace: localIdentity.namespace,
  pid: 4242,
};

const ownerIncarnation = `linux-proc:${localIdentity.boot}:100`;

/**
 * Load the bundle's real `processOwnerState` together with the pure helpers
 * it delegates to (`processIncarnationFormat`, `processBootIdentitiesMatch`,
 * `processExists`). Only the environment seams are stubbed: the current
 * process execution identity, the incarnation observation, and `process`
 * (platform + kill), so no host PID is ever signalled.
 */
function createOwnerStateHarness(
  bundle: string,
  source: string
): OwnerStateHarness {
  const extracted = [
    "processIncarnationFormat",
    "processOwnerState",
    "processBootIdentitiesMatch",
    "processExists",
  ]
    .map((name) => extractBundleFunction(bundle, source, name))
    .join("\n");
  let current = localIdentity;
  let observedIncarnation: string | null = null;
  let ownerAlive = true;
  const killCalls: Array<{ pid: number; signal: number }> = [];
  const context = createContext({
    getCurrentProcessExecutionIdentity: () => Promise.resolve(current),
    observeProcessIncarnation: () => Promise.resolve(observedIncarnation),
    process: {
      platform: "linux",
      kill(pid: number, signal: number): void {
        killCalls.push({ pid, signal });
        if (!ownerAlive) {
          throw spawnError("ESRCH");
        }
      },
    },
  });
  const classify = runInContext(
    `${extracted}\nprocessOwnerState;`,
    context
  ) as OwnerStateHarness["classify"];
  return {
    classify,
    killCalls,
    setCurrentIdentity: (identity) => {
      current = identity;
    },
    setObservedIncarnation: (incarnation) => {
      observedIncarnation = incarnation;
    },
    setOwnerAlive: (alive) => {
      ownerAlive = alive;
    },
  };
}

describe.each(bundles)("processOwnerState (%s)", (bundle) => {
  let source: string;

  beforeAll(async () => {
    source = await readFile(join(napiCliDirectory, bundle), "utf8");
  });

  it.each([
    ["without any identity metadata", { pid: 4242 }],
    [
      "with only partial identity metadata",
      { machine: localIdentity.machine, pid: 4242 },
    ],
  ])("does not classify a legacy owner %s as stale", async (_label, owner) => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(harness.classify(owner)).resolves.toEqual({
      stale: false,
      unverifiableReason: expect.stringContaining("predates"),
    });
    // No local PID guess is allowed for pre-identity-metadata owners.
    expect(harness.killCalls).toHaveLength(0);
  });

  it.each([
    [
      "completely",
      { boot: null, bootSession: null, machine: null, namespace: null },
    ],
    ["partially", { ...localIdentity, boot: null }],
  ])(
    "does not classify a fully described owner as stale when the current identity is %s unavailable",
    async (_label, identity) => {
      const harness = createOwnerStateHarness(bundle, source);
      harness.setCurrentIdentity(identity);
      await expect(
        harness.classify({ ...liveOwner, incarnation: ownerIncarnation })
      ).resolves.toEqual({
        stale: false,
        unverifiableReason: expect.stringContaining("cannot determine"),
      });
      expect(harness.killCalls).toHaveLength(0);
    }
  );

  it("does not classify a foreign-machine owner as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(
      harness.classify({
        ...liveOwner,
        incarnation: ownerIncarnation,
        machine: "linux-machine:elsewhere",
      })
    ).resolves.toEqual({
      stale: false,
      unverifiableReason: expect.stringContaining("shared volume"),
    });
    // A shared-volume owner may be alive elsewhere; never probe its PID.
    expect(harness.killCalls).toHaveLength(0);
  });

  it("does not classify a foreign-namespace owner as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(
      harness.classify({
        ...liveOwner,
        namespace: "linux-pid-namespace:pid:[1]",
      })
    ).resolves.toEqual({
      stale: false,
      unverifiableReason: expect.stringContaining("not authoritative"),
    });
    expect(harness.killCalls).toHaveLength(0);
  });

  it("does not classify a live owner without an incarnation identity as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(harness.classify(liveOwner)).resolves.toEqual({
      stale: false,
      unverifiableReason: expect.stringContaining("PID reuse"),
    });
    expect(harness.killCalls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  // This is the downstream contract of the synchronous-EPERM fix: when the
  // incarnation probe resolves null (EPERM-denied execFile), the live owner
  // must remain unverifiable, never stale.
  it("does not classify a live owner as stale when its incarnation cannot be observed", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    harness.setObservedIncarnation(null);
    await expect(
      harness.classify({ ...liveOwner, incarnation: ownerIncarnation })
    ).resolves.toEqual({ stale: false });
  });

  it("does not classify an unrecognized incarnation format as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(
      harness.classify({ ...liveOwner, incarnation: "mystery-format" })
    ).resolves.toEqual({ stale: false });
  });

  // Positive controls: the guardrails above must not degenerate into always
  // answering "not stale" — comparable identities still reclaim dead owners.

  it("classifies an owner from a prior boot as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    await expect(
      harness.classify({
        ...liveOwner,
        boot: "00000000-0000-4000-8000-000000000000",
      })
    ).resolves.toEqual({ stale: true });
    // A proven prior boot settles the verdict before any PID check.
    expect(harness.killCalls).toHaveLength(0);
  });

  it("classifies an owner whose PID is gone as stale", async () => {
    const harness = createOwnerStateHarness(bundle, source);
    harness.setOwnerAlive(false);
    await expect(harness.classify(liveOwner)).resolves.toEqual({
      stale: true,
    });
    expect(harness.killCalls).toEqual([{ pid: 4242, signal: 0 }]);
  });

  it.each([
    ["matching", `linux-proc:${localIdentity.boot}:100`, false],
    ["mismatched", `linux-proc:${localIdentity.boot}:200`, true],
  ])(
    "classifies a live owner with a %s observed incarnation (%s) as stale=%s",
    async (_label, observed, stale) => {
      const harness = createOwnerStateHarness(bundle, source);
      harness.setObservedIncarnation(observed);
      await expect(
        harness.classify({ ...liveOwner, incarnation: ownerIncarnation })
      ).resolves.toEqual({ stale });
    }
  );
});
