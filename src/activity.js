import { useSyncExternalStore } from "react";

/**
 * Activity log: connections, transfers and the app's own notifications, kept in the
 * WebView's localStorage (this machine only). Entries are built from the app's own messages
 * and host names; passwords, OTP answers, passphrases and key material are never passed here.
 */
const KEY = "ssh-studio.activity";
export const ACTIVITY_MAX = 1000;
export const ACTIVITY_DAYS = 30;

/** Drops entries older than the retention window and keeps the newest `ACTIVITY_MAX`. */
export function pruneActivity(list, now = Date.now()) {
  const oldest = now - ACTIVITY_DAYS * 86_400_000;
  return list
    .filter(
      (e) =>
        e &&
        typeof e.message === "string" &&
        Number.isFinite(e.at) &&
        e.at >= oldest,
    )
    .slice(-ACTIVITY_MAX);
}

/** Entries matching a level filter (`all` | `error`) and a case-insensitive search. */
export function filterActivity(list, level, query) {
  const q = query.trim().toLowerCase();
  return list.filter(
    (e) =>
      (level === "all" || e.level === level) &&
      (!q || `${e.message} ${e.source || ""}`.toLowerCase().includes(q)),
  );
}

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? pruneActivity(list) : [];
  } catch {
    return [];
  }
}

let entries = load();
const listeners = new Set();
let saveTimer;
const emit = () => listeners.forEach((listener) => listener());
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable: the log stays in memory for this run.
    }
  }, 400);
};

/** Adds one entry. `level`: info | success | error; `source`: a host or file name. */
export function logActivity(message, { level = "info", source = "" } = {}) {
  entries = pruneActivity([
    ...entries,
    { id: crypto.randomUUID(), at: Date.now(), level, message, source },
  ]);
  persist();
  emit();
}

export function clearActivity() {
  entries = [];
  persist();
  emit();
}

export function useActivity() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries,
  );
}
