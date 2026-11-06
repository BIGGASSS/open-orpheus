import { beforeEach, describe, expect, it, vi } from "vitest";

type Point = { x: number; y: number };
type Display = {
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
};

const hoisted = vi.hoisted(() => ({
  screen: {} as Record<string, unknown>,
}));

vi.mock("electron", () => ({ screen: hoisted.screen }));

const { dipToScreenPoint, screenToDipPoint } = await import("../../../src/main/util/screenPoint");

const primary: Display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 };
const external: Display = {
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

function setScreen(api: Record<string, unknown>) {
  for (const key of Object.keys(hoisted.screen)) delete hoisted.screen[key];
  Object.assign(hoisted.screen, api);
}

describe("screen point conversion", () => {
  describe("macOS screen API shape (no native conversion)", () => {
    beforeEach(() => {
      setScreen({
        getDisplayNearestPoint: vi.fn((p: Point) => (p.x >= 1440 ? external : primary)),
        getAllDisplays: vi.fn(() => [primary, external]),
        getPrimaryDisplay: vi.fn(() => primary),
      });
    });

    it("converts DIP to physical pixels without calling unavailable APIs", () => {
      expect(dipToScreenPoint({ x: 100, y: 50 })).toEqual({ x: 200, y: 100 });
      expect(dipToScreenPoint({ x: 1500, y: 50 })).toEqual({ x: 1500, y: 50 });
    });

    it("converts physical pixels back to DIP", () => {
      expect(screenToDipPoint({ x: 200, y: 100 })).toEqual({ x: 100, y: 50 });
      expect(screenToDipPoint({ x: 3000, y: 50 })).toEqual({ x: 3000, y: 50 });
    });

    it("falls back to the primary display for off-screen points", () => {
      expect(screenToDipPoint({ x: -400, y: -400 })).toEqual({ x: -200, y: -200 });
    });
  });

  describe("Windows/Linux screen API shape", () => {
    it("delegates to Electron's native conversions", () => {
      const native = {
        dipToScreenPoint: vi.fn(() => ({ x: 1, y: 2 })),
        screenToDipPoint: vi.fn(() => ({ x: 3, y: 4 })),
      };
      setScreen(native);

      expect(dipToScreenPoint({ x: 10, y: 20 })).toEqual({ x: 1, y: 2 });
      expect(screenToDipPoint({ x: 30, y: 40 })).toEqual({ x: 3, y: 4 });
      expect(native.dipToScreenPoint).toHaveBeenCalledWith({ x: 10, y: 20 });
      expect(native.screenToDipPoint).toHaveBeenCalledWith({ x: 30, y: 40 });
    });
  });
});
