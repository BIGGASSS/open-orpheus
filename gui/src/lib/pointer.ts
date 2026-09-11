import type { Attachment } from "svelte/attachments";

const THRESHOLD = 2; // pixels
const THRESHOLD_SQ = THRESHOLD * THRESHOLD;

export function onpointerdrag(callback: (e: PointerEvent) => void): Attachment {
  return (el) => {
    if (!(el instanceof HTMLElement)) return;

    let pointerId: number | null = null;
    let sx = 0,
      sy = 0;

    const onpointerdown = (e: PointerEvent) => {
      if (pointerId !== null) return;
      if (e.pointerType === "mouse" && e.button !== 0) return; // For mouse, only track left button

      e.preventDefault();

      pointerId = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;

      window.addEventListener("pointermove", onpointermove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      window.addEventListener("blur", stop);
    };

    const onpointermove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - sx,
        dy = e.clientY - sy;
      if (dx * dx + dy * dy >= THRESHOLD_SQ) {
        stop();
        callback(e);
      }
    };

    const stop = (e?: PointerEvent | FocusEvent) => {
      if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
      pointerId = null;
      window.removeEventListener("pointermove", onpointermove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };

    el.addEventListener("pointerdown", onpointerdown);

    return () => {
      el.removeEventListener("pointerdown", onpointerdown);
      stop();
    };
  };
}
