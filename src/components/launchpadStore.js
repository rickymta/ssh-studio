// Launchpad preferences: pins, the connection history (time and result of the last attempt per
// server, never a secret), the scope and the open tab. Per machine, like the layout, so they
// live in the WebView's storage rather than in workspace.json.
import { useSyncExternalStore } from "react";
import { parsePrefs } from "../launchpad.js";

const KEY = "ssh-studio.launchpad";
let prefs = (() => {
  try {
    return parsePrefs(localStorage.getItem(KEY));
  } catch {
    return parsePrefs(null);
  }
})();
const listeners = new Set();

/** Applies `change(prefs) → prefs` and saves. */
export function updatePrefs(change) {
  const next = change(prefs);
  if (next === prefs) return;
  prefs = next;
  listeners.forEach((l) => l());
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}

export const getPrefs = () => prefs;

export function usePrefs() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}
