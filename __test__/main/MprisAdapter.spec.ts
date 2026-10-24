import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  metadata: [] as unknown[],
  seeked: [] as number[],
}));

vi.mock("@open-orpheus/dbus", () => ({
  MediaSession: class {
    readonly setEventHandler = vi.fn();
    readonly setMetadata = vi.fn(async (metadata: unknown) => {
      hoisted.metadata.push(metadata);
    });
    readonly updatePlaybackState = vi.fn(async (state: Record<string, unknown>) => {
      hoisted.updates.push(state);
    });
    readonly sendSeeked = vi.fn(async (time: number) => {
      hoisted.seeked.push(time);
    });
    readonly setVolume = vi.fn(async () => {});
  },
  PlaybackStatus: { Playing: 0, Paused: 1, Stopped: 2 },
}));

vi.mock("../../src/main/request", () => ({
  client: { get: vi.fn() },
}));

vi.mock("../../src/main/playback/artwork", () => ({
  artworkFileExists: vi.fn(async () => false),
  artworkFileUrl: vi.fn(() => "file:///art.jpg"),
  cacheArtwork: vi.fn(async () => "file:///art.jpg"),
  remoteArtExt: vi.fn(() => ".jpg"),
}));

import MprisAdapter from "../../src/main/playback/adapters/MprisAdapter";
import { PlaybackStatus } from "../../src/main/playback/types";

const track = { id: "1", title: "title", artist: "artist", album: "album" };
const lastUpdate = () => hoisted.updates.at(-1);

beforeEach(() => {
  hoisted.updates.length = 0;
  hoisted.metadata.length = 0;
  hoisted.seeked.length = 0;
});

describe("MprisAdapter", () => {
  it("publishes advancing, seeked, and rate changes", () => {
    const adapter = new MprisAdapter();
    adapter.onTrack(track);
    adapter.onStatus(PlaybackStatus.Playing);
    adapter.onPosition(10, false);

    expect(lastUpdate()).toEqual({
      status: 0,
      position: 10_000_000,
      speed: 1,
      advancing: true,
      seeked: false,
    });

    adapter.onAdvancing(false);
    expect(lastUpdate()).toMatchObject({ advancing: false });

    adapter.onPosition(20, true);
    expect(lastUpdate()).toMatchObject({
      position: 20_000_000,
      advancing: true,
      seeked: true,
    });
    expect(hoisted.seeked).toEqual([20_000_000]);

    adapter.onRate(1.5);
    expect(lastUpdate()).toMatchObject({ speed: 1.5, advancing: true });
  });

  it("resets its cached position on a track change", () => {
    const adapter = new MprisAdapter();
    adapter.onTrack(track);
    adapter.onStatus(PlaybackStatus.Playing);
    adapter.onPosition(60, false);

    adapter.onTrack({ ...track, id: "2" });
    adapter.onStatus(PlaybackStatus.Paused);

    expect(lastUpdate()).toMatchObject({ position: 0, advancing: false });
  });
});
