import { invoke } from "@tauri-apps/api/core";

export const desktop =
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
export const call = (name, args = {}) =>
  desktop
    ? invoke(name, args)
    : Promise.reject("Chạy bằng npm start để sử dụng backend Tauri.");
export const uid = () => crypto.randomUUID();
export const cleanError = (e) => String(e).replace(/^Error: /, "");
export const size = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1073741824
        ? `${(bytes / 1048576).toFixed(1)} MB`
        : `${(bytes / 1073741824).toFixed(2)} GB`;
export const statuses = {
  connecting: "Đang kết nối",
  connected: "Đã kết nối",
  closed: "Đã ngắt",
  error: "Lỗi kết nối",
  queued: "Đang chờ",
  running: "Đang truyền",
  completed: "Hoàn tất",
  failed: "Thất bại",
  cancelled: "Đã hủy",
  skipped: "Bỏ qua",
};

/** Bytes → base64 (chunked so large terminal pastes do not overflow the call stack). */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
/** Text typed or pasted in xterm (onData) is UTF-8 encoded. */
export const textBytes = (text) => new TextEncoder().encode(text);
/** xterm onBinary strings carry one byte per character (e.g. X10 mouse reports). */
export const binaryBytes = (text) =>
  Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

/** A listing entry that opens as a folder: a directory or a symlink to one (B9). */
export const isFolder = (file) =>
  !!(file && (file.directory || (file.link && file.targetDirectory)));

/**
 * Explorer-style selection: click selects one item, Ctrl toggles, Shift extends from the
 * anchor (Ctrl+Shift adds the range to the current selection).
 */
export function nextSelection(names, selection, anchor, name, mods = {}) {
  if (mods.shift && anchor && names.includes(anchor)) {
    const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort(
      (x, y) => x - y,
    );
    const range = names.slice(a, b + 1);
    return {
      selection: mods.ctrl ? [...new Set([...selection, ...range])] : range,
      anchor,
    };
  }
  if (mods.ctrl)
    return {
      selection: selection.includes(name)
        ? selection.filter((n) => n !== name)
        : [...selection, name],
      anchor: name,
    };
  return { selection: [name], anchor: name };
}

/** Splits a dropped local path (Windows or POSIX) into its folder and name. */
export function splitPath(path) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return { directory: "", name: trimmed };
  let directory = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(directory)) directory += "\\";
  if (directory === "") directory = "/";
  return { directory, name: trimmed.slice(i + 1) };
}

/**
 * Decides the conflict policy of each name in a batch. `ask(name)` resolves to
 * `{choice: "overwrite" | "rename" | "skip" | "cancel", all}`; "all" reuses the answer for
 * the remaining conflicts. Skipped names are left out; `null` means the batch was cancelled.
 */
export async function planConflicts(names, existing, ask) {
  const taken = new Set(existing);
  let always = null;
  const plan = [];
  for (const name of names) {
    if (!taken.has(name)) {
      plan.push({ name, conflict: "fail" });
      continue;
    }
    let choice = always;
    if (!choice) {
      const answer = await ask(name);
      if (!answer || answer.choice === "cancel") return null;
      choice = answer.choice;
      if (answer.all) always = choice;
    }
    if (choice !== "skip") plan.push({ name, conflict: choice });
  }
  return plan;
}

/** Request to retry a finished transfer row: resume failed ones, restart cancelled ones. */
export function retryRequest(t) {
  return {
    id: t.id,
    sessionId: t.sessionId,
    direction: t.direction,
    localDirectory: t.localDirectory,
    remoteDirectory: t.remoteDirectory,
    name: t.name,
    conflict: t.conflict || "fail",
    targetName: t.targetName || null,
    resume: t.status === "failed" && !!t.resumable,
  };
}

/** Human label for the backend's `std::env::consts::OS`. */
export function osLabel(os) {
  return (
    { windows: "Windows", macos: "macOS", linux: "Linux" }[os] ||
    (os ? os[0].toUpperCase() + os.slice(1) : "Desktop")
  );
}

/**
 * Terminal clipboard chords. Plain Ctrl+C / Ctrl+V stay with the shell (SIGINT, ^V);
 * Ctrl+Shift+C/V and Ctrl/Shift+Insert copy and paste like other terminals.
 */
export function clipboardChord(e) {
  if (e.type !== "keydown" || e.altKey || e.metaKey) return null;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey && key === "c") return "copy";
  if (e.ctrlKey && e.shiftKey && key === "v") return "paste";
  if (e.ctrlKey && !e.shiftKey && key === "insert") return "copy";
  if (e.shiftKey && !e.ctrlKey && key === "insert") return "paste";
  return null;
}

export async function writeClipboard(text) {
  if (desktop) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    return writeText(text);
  }
  return navigator.clipboard.writeText(text);
}
export async function readClipboard() {
  if (desktop) {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) || "";
  }
  return navigator.clipboard.readText();
}
