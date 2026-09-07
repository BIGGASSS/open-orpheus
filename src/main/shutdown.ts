// Kept independent of Electron so shutdown ordering and failure handling can be tested.
export interface ShutdownFrame {
  readonly url: string;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

const FLUSH_REQUEST_CACHE = `
(async () => {
  // Recheck in the renderer in case it navigated since frame enumeration.
  if (location.protocol !== 'orpheus:' || location.hostname !== 'orpheus' || location.port) {
    throw new Error('Request cache frame navigated during shutdown');
  }
  const flush = globalThis.__openOrpheusFlushRequestCache;
  if (typeof flush === 'function') await flush();
})()
`;

export async function flushShutdownCache(
  frames: Iterable<ShutdownFrame>,
  databaseBarrier: () => Promise<unknown>
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const frame of frames) {
    if (frame.isDestroyed()) continue;
    let url: URL;
    try {
      url = new URL(frame.url);
    } catch {
      continue;
    }
    if (url.protocol !== "orpheus:" || url.hostname !== "orpheus" || url.port)
      continue;
    // Missing hooks are normal in auxiliary frames and older frontend packs.
    pending.push(frame.executeJavaScript(FLUSH_REQUEST_CACHE));
  }
  await Promise.all(pending);
  // Renderer flush acknowledgements must precede the native worker queue barrier.
  await databaseBarrier();
}

async function withTimeout(
  work: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Request cache flush timed out")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ShutdownOptions {
  flush(): Promise<void>;
  // Must visibly report failure. A failed prompt leaves shutdown blocked.
  onFailure(error: unknown): Promise<"retry" | "quit">;
  onPromptFailure(error: unknown): void;
  quit(): void;
  timeoutMs?: number;
}

export function createShutdownHandler(options: ShutdownOptions) {
  let allowed = false;
  let pending = false;

  return (event: { preventDefault(): void }): void => {
    if (allowed) return;
    event.preventDefault();
    if (pending) return;
    pending = true;

    void (async () => {
      try {
        for (;;) {
          try {
            await withTimeout(options.flush(), options.timeoutMs ?? 15_000);
            break;
          } catch (error) {
            if ((await options.onFailure(error)) === "quit") break;
          }
        }
        allowed = true;
        options.quit();
      } catch (error) {
        options.onPromptFailure(error);
      } finally {
        pending = false;
      }
    })();
  };
}
