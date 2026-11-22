// Dragging servers and folders onto folders (sidebar tree, overview list and breadcrumb).
// Pointer events, not HTML5 drag and drop: the desktop WebView takes HTML5 drags for its own
// file drops (FilePane uses them for files from Explorer).
import React, { useSyncExternalStore } from "react";
import { Folder, Server } from "lucide-react";

/** Attribute marking a drop target; its value is the folder id ('' for the root). */
export const DROP_ATTR = "data-drop-folder";
const THRESHOLD = 5;

let state = { item: null, x: 0, y: 0, over: null };
const listeners = new Set();
const set = (patch) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Current drag: `{item, x, y, over}`; `over` is the accepting folder id or null. */
export const useFolderDrag = () => useSyncExternalStore(subscribe, () => state);

/**
 * Starts tracking a possible drag from a pointerdown. Nothing happens until the pointer moves
 * a few pixels, so a click still works; after a drag the click that follows is swallowed.
 * item: `{kind: "hosts", hosts, label}` or `{kind: "folder", id, label}`.
 */
export function beginDrag(e, item, accept, drop) {
  if (e.button !== 0) return;
  // Buttons and fields inside the row keep their own click.
  if (e.target.closest("button, input, select, a")) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  const targetAt = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest(`[${DROP_ATTR}]`);
    if (!el) return null;
    const folder = el.getAttribute(DROP_ATTR) || "";
    return accept(item, folder) ? folder : null;
  };
  const move = (ev) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
      dragging = true;
      document.body.classList.add("dragging-item");
      window.getSelection?.()?.removeAllRanges();
    }
    set({ item, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY) });
  };
  const end = (commit) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    document.body.classList.remove("dragging-item");
    const { over } = state;
    set({ item: null, over: null });
    if (!dragging) return;
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (commit && over !== null) drop(item, over);
  };
  const up = () => end(true);
  const key = (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      end(false);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key, true);
}

/** The label following the pointer while dragging. */
export function DragGhost() {
  const { item, x, y, over } = useFolderDrag();
  if (!item) return null;
  const Icon = item.kind === "folder" ? Folder : Server;
  return (
    <div
      className="folder-drag-ghost"
      style={{ left: x + 12, top: y + 8, opacity: over === null ? 0.65 : 1 }}
    >
      <Icon size={14} />
      {item.label}
    </div>
  );
}
