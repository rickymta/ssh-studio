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

/** Key export / vault backups (F6). */
export function passwordProblem(password, confirmation, min = 8) {
  if (password.length < min) return `Cần ít nhất ${min} ký tự.`;
  if (password !== confirmation) return "Hai lần nhập không khớp.";
  return null;
}
export const backupFileName = (date = new Date()) =>
  `ssh-studio-${date.toISOString().slice(0, 10)}.sshstudio-backup`;
/** "id_ed25519_work-laptop" style default name for an exported key. */
export const keyFileName = (key) =>
  `id_${String(key.algorithm || "key")
    .toLowerCase()
    .replace(/^ssh-/, "")}_${String(key.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`.replace(/_$/, "");
export function restoreSummary(r) {
  const parts = [
    `${r.hostsAdded} server mới`,
    `${r.keysAdded} key mới`,
    `${r.knownAdded} known host mới`,
  ];
  const skipped = r.hostsSkipped + r.keysSkipped;
  if (skipped) parts.push(`bỏ qua ${skipped} mục đã có`);
  if (r.knownReplaced) parts.push(`thay ${r.knownReplaced} fingerprint`);
  if (r.knownKept) parts.push(`giữ ${r.knownKept} fingerprint hiện tại`);
  return parts.join(", ");
}

/** Preferences (F7); mirrors `store::Settings::default` for the web preview. */
export const defaultSettings = {
  fontFamily: "Cascadia Code, Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.3,
  scrollback: 10000,
  cursorStyle: "block",
  cursorBlink: true,
  copyOnSelect: false,
  defaultView: "terminal",
  confirmClose: true,
  closeToTray: false,
};
export const withDefaults = (settings) => ({
  ...defaultSettings,
  ...(settings || {}),
});
/** Font size after a zoom shortcut, kept within the backend range (8–32). */
export function zoomFont(size, action) {
  if (action === "zoomReset") return defaultSettings.fontSize;
  const next = size + (action === "zoomIn" ? 1 : action === "zoomOut" ? -1 : 0);
  return Math.min(32, Math.max(8, next));
}
/** xterm options derived from the settings. */
/**
 * Resizable layout, kept per machine: `split` (terminal height in Chia đôi), `side`
 * (terminal width in Song song) and `panes` (local pane width) are fractions; `nameWidth`
 * (0 = automatic) and `sizeWidth` are file table column widths in pixels.
 */
export const layoutDefaults = {
  split: 0.45,
  side: 0.5,
  panes: 0.5,
  nameWidth: 0,
  sizeWidth: 90,
};
export const RATIO_MIN = 0.15;
export const RATIO_MAX = 0.85;
export function normalizeLayout(raw = {}) {
  const ratio = (v, d) =>
    typeof v === "number" && v >= RATIO_MIN && v <= RATIO_MAX ? v : d;
  const px = (v, d, min, max) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  const d = layoutDefaults;
  return {
    split: ratio(raw.split, d.split),
    side: ratio(raw.side, d.side),
    panes: ratio(raw.panes, d.panes),
    nameWidth: raw.nameWidth ? px(raw.nameWidth, 0, 120, 1600) : 0,
    sizeWidth: px(raw.sizeWidth, d.sizeWidth, 60, 400),
  };
}
/** The fraction of a `size`-long box (starting at `start`) left of / above `pos`. */
export const dragRatio = (start, size, pos) =>
  size > 0
    ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, (pos - start) / size))
    : 0.5;

export const terminalOptions = (s) => ({
  fontFamily: s.fontFamily,
  fontSize: s.fontSize,
  lineHeight: s.lineHeight,
  scrollback: s.scrollback,
  cursorStyle: s.cursorStyle,
  cursorBlink: s.cursorBlink,
});

/**
 * Application shortcuts (F7). Returns `{action, index?}` or null. Ctrl+W/C/V and the other
 * shell chords are never taken; inside the terminal plain Ctrl+K stays with readline (kill
 * line), so the server search is Ctrl+Shift+K there.
 */
export function shortcut(e, inTerminal = false) {
  if (e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const code = e.code || "";
  if (key === "Tab") return { action: e.shiftKey ? "prevTab" : "nextTab" };
  if (e.shiftKey) {
    if (key === "w") return { action: "closeSession" };
    if (key === "t") return { action: "reopen" };
    if (key === "f") return { action: "search" };
    if (key === "k") return { action: "findServer" };
  }
  if (key === "k" && !e.shiftKey && !inTerminal)
    return { action: "findServer" };
  const digit = /^Digit([1-9])$/.exec(code);
  if (!e.shiftKey && (digit || /^[1-9]$/.test(key)))
    return { action: "tab", index: Number(digit ? digit[1] : key) - 1 };
  if (key === "=" || key === "+" || code === "NumpadAdd")
    return { action: "zoomIn" };
  if (key === "-" || key === "_" || code === "NumpadSubtract")
    return { action: "zoomOut" };
  if (!e.shiftKey && (key === "0" || code === "Digit0" || code === "Numpad0"))
    return { action: "zoomReset" };
  return null;
}
/** Index of the tab after `active` when cycling with Ctrl+Tab / Ctrl+Shift+Tab. */
export function cycleTab(ids, active, step) {
  if (!ids.length) return null;
  const i = ids.indexOf(active);
  if (i < 0) return ids[step > 0 ? 0 : ids.length - 1];
  return ids[(i + step + ids.length) % ids.length];
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
