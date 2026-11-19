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

/**
 * Line endings of a file opened in the editor. A <textarea> normalises CRLF to LF, so the
 * original style is restored on save (F2).
 */
export const lineEnding = (text) => (/\r\n/.test(text) ? "\r\n" : "\n");
export const withLineEnding = (text, eol) =>
  eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;

/** "755" / "0644" → number, or null when not a valid octal permission. */
export function parseMode(text) {
  const value = String(text).trim();
  return /^[0-7]{3,4}$/.test(value) ? parseInt(value, 8) : null;
}
/** Permission bits → "rwxr-xr-x". */
export function modeString(mode) {
  return [6, 3, 0]
    .map((shift) => {
      const bits = (mode >> shift) & 7;
      return (
        (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-")
      );
    })
    .join("");
}
/** "3 thư mục và 12 file" — confirmation text for a recursive delete. */
export function deleteSummary({ files, folders }) {
  const parts = [];
  if (folders) parts.push(`${folders} thư mục`);
  if (files) parts.push(`${files} file`);
  return parts.join(" và ") || "0 mục";
}

/** Sync comparison states (F3). */
export const syncStates = {
  localOnly: "Chỉ có ở local",
  remoteOnly: "Chỉ có ở remote",
  localNewer: "Local mới hơn",
  remoteNewer: "Remote mới hơn",
  changed: "Khác kích thước",
  same: "Giống nhau",
  typeMismatch: "Khác loại (file / thư mục)",
};
const sourceOnly = { upload: "localOnly", download: "remoteOnly" };
const destOnly = { upload: "remoteOnly", download: "localOnly" };
const sourceNewer = { upload: "localNewer", download: "remoteNewer" };
/** Entries that can be copied in `direction` (newer-at-destination ones only on request). */
export const syncSelectable = (entry, direction) =>
  [sourceOnly[direction], "localNewer", "remoteNewer", "changed"].includes(
    entry.state,
  );
/** Pre-checked entries: missing at the destination or newer at the source. Never deletes. */
export const syncDefaults = (entries, direction) =>
  entries
    .filter((e) =>
      [sourceOnly[direction], sourceNewer[direction]].includes(e.state),
    )
    .map((e) => e.path);
/** Destination-only entries a mirror would delete, top level only. */
export function mirrorTargets(entries, direction) {
  const paths = entries
    .filter((e) => e.state === destOnly[direction])
    .map((e) => e.path)
    .sort();
  return paths.filter(
    (p) => !paths.some((q) => q !== p && p.startsWith(q + "/")),
  );
}
/** Request body for `sync_run` from the checked paths. */
export function syncRequest(preview, sessionId, direction, checked, mirror) {
  return {
    sessionId,
    localDirectory: preview.localDirectory,
    remoteDirectory: preview.remoteDirectory,
    direction,
    items: preview.entries
      .filter((e) => checked.has(e.path) && syncSelectable(e, direction))
      .map((e) => ({ path: e.path, folder: e.folder })),
    delete: mirror ? mirrorTargets(preview.entries, direction) : [],
  };
}

/** Port forwarding (F5). */
export const forwardKinds = {
  local: "Local (-L)",
  remote: "Remote (-R)",
  dynamic: "Dynamic SOCKS5 (-D)",
};
export const isLoopback = (host) =>
  /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i.test(String(host).trim());
export function forwardLabel(spec, boundPort) {
  const bind = `${spec.bindHost}:${boundPort || spec.bindPort}`;
  return spec.kind === "dynamic"
    ? `SOCKS5 ${bind}`
    : `${bind} → ${spec.targetHost}:${spec.targetPort}`;
}
/** Saved forwards of a host plus forwards started only for this session. */
export function forwardRows(saved = [], live = {}, sessionId) {
  const rows = saved.map((spec) => ({
    spec,
    saved: true,
    state: live[`${sessionId}:${spec.id}`],
  }));
  for (const state of Object.values(live))
    if (
      state.sessionId === sessionId &&
      state.status !== "stopped" &&
      !saved.some((s) => s.id === state.spec.id)
    )
      rows.push({ spec: state.spec, saved: false, state });
  return rows;
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
