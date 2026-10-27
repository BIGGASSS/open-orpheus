import { beforeEach, describe, expect, it, vi } from "vitest";
import { vol } from "memfs";

vi.mock("node:fs/promises");
vi.mock("electron", () => ({
  app: {},
  dialog: {},
  Notification: vi.fn(),
  BrowserWindow: vi.fn(),
  screen: {},
}));
vi.mock("../../../src/main/folders", () => ({
  data: "/data",
  defaultCache: "/cache",
  download: "/downloads",
  downloadTemp: "/temp",
  setCachePath: vi.fn(),
  setDownloadPath: vi.fn(),
}));
vi.mock("../../../src/main/database", () => ({ webDb: {} }));
vi.mock("../../../src/main/cache", () => ({
  default: vi.fn(),
  lyricCacheManager: null,
  playCacheManager: null,
}));
vi.mock("../../../src/main/logger", () => ({ default: { error: vi.fn() } }));

async function freshDispatcher() {
  vi.resetModules();
  const { dispatcher } = await import("../../../src/main/calls");
  await import("../../../src/main/calls/storage");
  return dispatcher;
}

beforeEach(() => {
  vol.reset();
});

describe("storage.checkFilesExist", () => {
  it("uses the renderer's singular `exist` field for present and missing files", async () => {
    vol.fromJSON({ "/downloads/artist/present.mp3": "audio" });
    const dispatcher = await freshDispatcher();
    const send = vi.fn();

    await dispatcher.dispatch(
      "storage.checkFilesExist",
      vi.fn(),
      { sender: { send } },
      "check-1",
      [
        { id: "track-1", path: "artist/present.mp3" },
        { id: "track-2", path: "artist/missing.mp3" },
      ],
      "/downloads"
    );

    expect(send).toHaveBeenCalledExactlyOnceWith(
      "channel.call",
      "storage.oncheckfilesexist",
      "check-1",
      true,
      [
        { id: "track-1", exist: true },
        { id: "track-2", exist: false },
      ]
    );
  });

  it("replies successfully when there are no saved downloads", async () => {
    const dispatcher = await freshDispatcher();
    const send = vi.fn();

    await dispatcher.dispatch(
      "storage.checkFilesExist",
      vi.fn(),
      { sender: { send } },
      "check-empty",
      [],
      "/downloads"
    );

    expect(send).toHaveBeenCalledExactlyOnceWith(
      "channel.call",
      "storage.oncheckfilesexist",
      "check-empty",
      true,
      []
    );
  });

  it("recognizes an untagged cloud-disk download after reloading the host", async () => {
    vol.fromJSON({ "/temp/cloud.mp3": "untagged cloud audio" });
    const dispatcher = await freshDispatcher();
    const send = vi.fn();

    // Private-cloud downloads intentionally supply no metadata comment or ID3 fields.
    await dispatcher.dispatch(
      "storage.addid3",
      vi.fn(),
      { sender: { send } },
      "cloud-download",
      "/temp/cloud.mp3",
      "",
      "",
      { media_rel_path: "cloud/song.mp3", image_rel_path: "" }
    );
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "channel.call",
        "storage.onaddid3done",
        "cloud-download",
        1,
        "cloud/song.mp3"
      );
    });
    expect(vol.readFileSync("/downloads/cloud/song.mp3", "utf8")).toBe("untagged cloud audio");

    // A fresh host must keep the saved download without relying on tag-based rescanning.
    const restartedDispatcher = await freshDispatcher();
    const restartedSend = vi.fn();
    await restartedDispatcher.dispatch(
      "storage.checkFilesExist",
      vi.fn(),
      { sender: { send: restartedSend } },
      "startup-check",
      [{ id: "track-cloud", path: "cloud/song.mp3" }],
      "/downloads"
    );

    expect(restartedSend).toHaveBeenCalledExactlyOnceWith(
      "channel.call",
      "storage.oncheckfilesexist",
      "startup-check",
      true,
      [{ id: "track-cloud", exist: true }]
    );
  });
});
