import React, { useEffect, useState } from "react";
import { dragRatio, layoutDefaults, normalizeLayout } from "../lib.js";

// Divider positions and column widths are a per-machine view preference (like window
// size), so they live in the WebView's storage rather than in workspace.json.
const KEY = "ssh-studio.layout";
let current = (() => {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(KEY) || "{}"));
  } catch {
    return normalizeLayout();
  }
})();
const listeners = new Set();

/** Updates the shared layout; `persist` saves it (at the end of a drag). */
export function setLayout(patch, persist = false) {
  current = normalizeLayout({ ...current, ...patch });
  listeners.forEach((listener) => listener(current));
  if (persist)
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {}
}

export function useLayout() {
  const [layout, set] = useState(current);
  useEffect(() => {
    listeners.add(set);
    set(current);
    return () => listeners.delete(set);
  }, []);
  return layout;
}

/** Pointer drag with capture: `move(event)` while dragging, then saves the layout. */
function drag(e, cursor, move) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add(cursor);
  const onMove = (event) => move(event);
  const done = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", done);
    handle.removeEventListener("pointercancel", done);
    document.body.classList.remove(cursor);
    setLayout({}, true);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", done);
  handle.addEventListener("pointercancel", done);
}

/**
 * Divider between two flex children; `field` is the fraction given to the first one.
 * `vertical` = a vertical bar between left and right. Arrow keys nudge it, double click
 * resets it.
 */
export function Splitter({ field, vertical = false, label }) {
  const layout = useLayout();
  const nudge = (step) => setLayout({ [field]: layout[field] + step }, true);
  return (
    <div
      className={`splitter ${vertical ? "vertical" : "horizontal"}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(layout[field] * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      title={`${label} · kéo để đổi kích thước, nhấp đúp để đặt lại`}
      tabIndex={0}
      onPointerDown={(e) => {
        const box = e.currentTarget.parentElement.getBoundingClientRect();
        drag(e, vertical ? "resizing-x" : "resizing-y", (event) =>
          setLayout({
            [field]: vertical
              ? dragRatio(box.left, box.width, event.clientX)
              : dragRatio(box.top, box.height, event.clientY),
          }),
        );
      }}
      onDoubleClick={() => setLayout({ [field]: layoutDefaults[field] }, true)}
      onKeyDown={(e) => {
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";
        if (e.key === back || e.key === forward) {
          e.preventDefault();
          nudge(e.key === back ? -0.02 : 0.02);
        }
      }}
    />
  );
}

/** Drag handle on a table header's right edge; `field` is a pixel width in the layout. */
export function ColumnResizer({ field, label }) {
  return (
    <span
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={`${label} · kéo để đổi độ rộng, nhấp đúp để đặt lại`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        const start = e.clientX;
        const width =
          e.currentTarget.parentElement.getBoundingClientRect().width;
        drag(e, "resizing-x", (event) =>
          setLayout({ [field]: width + event.clientX - start }),
        );
      }}
      onDoubleClick={() => setLayout({ [field]: layoutDefaults[field] }, true)}
    />
  );
}
