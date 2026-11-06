import { screen, type Point } from "electron";

/**
 * Electron only implements `screen.dipToScreenPoint` / `screen.screenToDipPoint`
 * on Windows and Linux; on macOS they are absent and calling them throws. These
 * wrappers use the native conversion when available and otherwise scale by the
 * display's `scaleFactor`, which is what physical pixels mean on macOS.
 */
export function dipToScreenPoint(point: Point): Point {
  if (typeof screen.dipToScreenPoint === "function") {
    return screen.dipToScreenPoint(point);
  }
  const { scaleFactor } = screen.getDisplayNearestPoint(point);
  return { x: Math.round(point.x * scaleFactor), y: Math.round(point.y * scaleFactor) };
}

export function screenToDipPoint(point: Point): Point {
  if (typeof screen.screenToDipPoint === "function") {
    return screen.screenToDipPoint(point);
  }
  // macOS has no global physical-pixel space, so scaled display ranges can
  // overlap; the first display containing the scaled-back point wins.
  const displays = screen.getAllDisplays();
  const display =
    displays.find(({ bounds, scaleFactor }) => {
      const x = point.x / scaleFactor;
      const y = point.y / scaleFactor;
      return (
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height
      );
    }) ?? screen.getPrimaryDisplay();
  return { x: point.x / display.scaleFactor, y: point.y / display.scaleFactor };
}
