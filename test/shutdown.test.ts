import { runInNewContext } from "node:vm";

import test from "ava";

import {
  createShutdownHandler,
  flushShutdownCache,
  type ShutdownFrame,
} from "../src/main/shutdown";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function frame(
  url: string,
  execute: () => Promise<unknown>,
  destroyed = false
): ShutdownFrame {
  return { url, isDestroyed: () => destroyed, executeJavaScript: execute };
}

test("flush waits for every trusted frame before database barrier", async (t) => {
  const first = deferred();
  const second = deferred();
  const calls: string[] = [];
  const work = flushShutdownCache(
    [
      frame("orpheus://orpheus/index.html", () => {
        calls.push("main");
        return first.promise;
      }),
      frame("orpheus://orpheus/child", () => {
        calls.push("child");
        return second.promise;
      }),
      frame("https://orpheus/", async () => {
        t.fail("untrusted frame");
      }),
      frame("orpheus://orpheus.evil/", async () => {
        t.fail("untrusted host");
      }),
      frame("orpheus://orpheus:123/", async () => {
        t.fail("untrusted port");
      }),
      frame(
        "orpheus://orpheus/",
        async () => {
          t.fail("destroyed frame");
        },
        true
      ),
    ],
    async () => {
      calls.push("barrier");
    }
  );
  first.resolve();
  await tick();
  t.deepEqual(calls, ["main", "child"]);
  second.resolve();
  await work;
  t.deepEqual(calls, ["main", "child", "barrier"]);
});

test("renderer script awaits the global hook and tolerates auxiliary frames without it", async (t) => {
  const saved = deferred();
  let drained = false;
  const location = { protocol: "orpheus:", hostname: "orpheus", port: "" };
  const work = flushShutdownCache(
    [
      {
        url: "orpheus://orpheus/",
        isDestroyed: () => false,
        executeJavaScript: (code) =>
          runInNewContext(code, {
            location,
            __openOrpheusFlushRequestCache: () => saved.promise,
          }),
      },
    ],
    async () => {
      drained = true;
    }
  );
  await tick();
  t.false(drained);
  saved.resolve();
  await work;
  t.true(drained);
  await flushShutdownCache(
    [
      {
        url: "orpheus://orpheus/child",
        isDestroyed: () => false,
        executeJavaScript: (code) => runInNewContext(code, { location }),
      },
    ],
    async () => {}
  );
});

test("no windows still drains database; renderer and barrier failures propagate", async (t) => {
  let drained = false;
  await flushShutdownCache([], async () => {
    drained = true;
  });
  t.true(drained);
  await t.throwsAsync(
    flushShutdownCache(
      [
        frame("orpheus://orpheus/", async () => {
          throw new Error("renderer");
        }),
      ],
      async () => {
        t.fail("must wait for renderer success");
      }
    ),
    { message: "renderer" }
  );
  await t.throwsAsync(
    flushShutdownCache([], async () => {
      throw new Error("database");
    }),
    { message: "database" }
  );
});

test("concurrent quits are prevented until flush completes; final quit passes through", async (t) => {
  const work = deferred();
  let flushes = 0;
  let quits = 0;
  let prevented = 0;
  const event = {
    preventDefault() {
      prevented++;
    },
  };
  const handler = createShutdownHandler({
    async flush() {
      flushes++;
      await work.promise;
    },
    async onFailure() {
      t.fail("unexpected failure");
      return "quit";
    },
    onPromptFailure() {
      t.fail("unexpected prompt failure");
    },
    quit() {
      quits++;
      handler(event);
    },
  });
  handler(event);
  handler(event);
  t.is(prevented, 2);
  t.is(flushes, 1);
  t.is(quits, 0);
  work.resolve();
  await tick();
  t.is(quits, 1);
  t.is(prevented, 2);
});

test("failure prompts and retries before permitting quit", async (t) => {
  let attempts = 0;
  const calls: string[] = [];
  const handler = createShutdownHandler({
    async flush() {
      if (++attempts === 1) throw new Error("disk full");
    },
    async onFailure(error) {
      calls.push((error as Error).message);
      return "retry";
    },
    onPromptFailure() {
      t.fail();
    },
    quit() {
      calls.push("quit");
    },
  });
  handler({ preventDefault() {} });
  await tick();
  t.is(attempts, 2);
  t.deepEqual(calls, ["disk full", "quit"]);
});

test("cancel quit returns to the app and permits a later quit attempt", async (t) => {
  let attempts = 0;
  let quits = 0;
  const handler = createShutdownHandler({
    async flush() {
      if (++attempts === 1) throw new Error("refresh required");
    },
    async onFailure() {
      return "cancel";
    },
    onPromptFailure() {
      t.fail();
    },
    quit() {
      quits++;
    },
  });
  handler({ preventDefault() {} });
  await tick();
  t.is(quits, 0);
  handler({ preventDefault() {} });
  await tick();
  t.is(attempts, 2);
  t.is(quits, 1);
});

test("timeout requires explicit Quit Anyway even with repeated quit requests", async (t) => {
  const prompted = deferred();
  const choice = deferred();
  const quit = deferred();
  let quits = 0;
  let prompts = 0;
  const handler = createShutdownHandler({
    flush: () => new Promise(() => {}),
    timeoutMs: 5,
    async onFailure(error) {
      prompts++;
      t.regex((error as Error).message, /timed out/);
      prompted.resolve();
      await choice.promise;
      return "quit";
    },
    onPromptFailure() {
      t.fail();
    },
    quit() {
      quits++;
      quit.resolve();
    },
  });
  handler({ preventDefault() {} });
  await prompted.promise;
  handler({ preventDefault() {} });
  t.is(quits, 0);
  t.is(prompts, 1);
  choice.resolve();
  await quit.promise;
  t.is(quits, 1);
});
