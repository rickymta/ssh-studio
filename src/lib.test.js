import { describe, expect, it } from "vitest";
import {
  backupFileName,
  binaryBytes,
  clipboardChord,
  cycleTab,
  defaultSettings,
  shortcut,
  terminalOptions,
  withDefaults,
  zoomFont,
  keyFileName,
  passwordProblem,
  restoreSummary,
  deleteSummary,
  forwardLabel,
  forwardRows,
  fromBase64,
  isFolder,
  isLoopback,
  lineEnding,
  modeString,
  parseMode,
  withLineEnding,
  nextSelection,
  osLabel,
  planConflicts,
  retryRequest,
  splitPath,
  syncDefaults,
  syncRequest,
  syncSelectable,
  size,
  textBytes,
  toBase64,
} from "./lib.js";

describe("terminal byte transport (B4/B5)", () => {
  it("round-trips arbitrary bytes through base64", () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
  it("encodes typed text as UTF-8 and binary mouse reports byte-for-byte", () => {
    expect([...textBytes("ă")]).toEqual([0xc4, 0x83]);
    expect([...binaryBytes("\x1b[M \xff\xa0")]).toEqual([
      0x1b, 0x5b, 0x4d, 0x20, 0xff, 0xa0,
    ]);
  });
});

describe("clipboard chords (B6)", () => {
  const key = (k, mods = {}) => ({ type: "keydown", key: k, ...mods });
  it("keeps Ctrl+C and Ctrl+V for the shell", () => {
    expect(clipboardChord(key("c", { ctrlKey: true }))).toBe(null);
    expect(clipboardChord(key("v", { ctrlKey: true }))).toBe(null);
  });
  it("maps Ctrl+Shift+C/V and Insert chords", () => {
    expect(clipboardChord(key("C", { ctrlKey: true, shiftKey: true }))).toBe(
      "copy",
    );
    expect(clipboardChord(key("V", { ctrlKey: true, shiftKey: true }))).toBe(
      "paste",
    );
    expect(clipboardChord(key("Insert", { ctrlKey: true }))).toBe("copy");
    expect(clipboardChord(key("Insert", { shiftKey: true }))).toBe("paste");
    expect(
      clipboardChord({
        type: "keyup",
        key: "v",
        ctrlKey: true,
        shiftKey: true,
      }),
    ).toBe(null);
  });
});

describe("listing entries (B9)", () => {
  it("opens only directories and links to directories", () => {
    expect(isFolder({ directory: true })).toBe(true);
    expect(isFolder({ link: true, targetDirectory: true })).toBe(true);
    expect(isFolder({ link: true, targetDirectory: false })).toBe(false);
    expect(isFolder({ name: "a.txt" })).toBe(false);
  });
});

describe("multi-select (F1)", () => {
  const names = ["a", "b", "c", "d", "e"];
  it("selects, toggles and extends like Explorer", () => {
    let s = nextSelection(names, [], null, "b");
    expect(s).toEqual({ selection: ["b"], anchor: "b" });
    s = nextSelection(names, s.selection, s.anchor, "d", { shift: true });
    expect(s.selection).toEqual(["b", "c", "d"]);
    s = nextSelection(names, s.selection, s.anchor, "c", { ctrl: true });
    expect(s.selection).toEqual(["b", "d"]);
    s = nextSelection(names, s.selection, "e", "a", {
      ctrl: true,
      shift: true,
    });
    expect(s.selection.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(nextSelection(names, ["a", "b"], "a", "e").selection).toEqual(["e"]);
  });
});

describe("dropped paths (F1)", () => {
  it("splits Windows and POSIX paths", () => {
    expect(splitPath("C:\\Users\\me\\report.pdf")).toEqual({
      directory: "C:\\Users\\me",
      name: "report.pdf",
    });
    expect(splitPath("D:\\photos\\")).toEqual({
      directory: "D:\\",
      name: "photos",
    });
    expect(splitPath("/home/me/a.txt")).toEqual({
      directory: "/home/me",
      name: "a.txt",
    });
    expect(splitPath("/top")).toEqual({ directory: "/", name: "top" });
  });
});

describe("conflict planning (F1)", () => {
  it("asks only for existing names and honours 'apply to all'", async () => {
    const asked = [];
    const plan = await planConflicts(
      ["new.txt", "a.txt", "b.txt", "c.txt"],
      ["a.txt", "b.txt", "c.txt"],
      async (name) => {
        asked.push(name);
        return name === "a.txt"
          ? { choice: "skip", all: false }
          : { choice: "rename", all: true };
      },
    );
    expect(asked).toEqual(["a.txt", "b.txt"]);
    expect(plan).toEqual([
      { name: "new.txt", conflict: "fail" },
      { name: "b.txt", conflict: "rename" },
      { name: "c.txt", conflict: "rename" },
    ]);
  });
  it("cancels the whole batch", async () => {
    expect(
      await planConflicts(["a"], ["a"], async () => ({ choice: "cancel" })),
    ).toBe(null);
  });
  it("retries failed transfers as resume and cancelled ones from scratch", () => {
    const row = {
      id: "t",
      sessionId: "s",
      direction: "upload",
      localDirectory: "C:\\x",
      remoteDirectory: "/srv",
      name: "a",
      conflict: "rename",
      targetName: "a (1)",
    };
    expect(
      retryRequest({ ...row, status: "failed", resumable: true }),
    ).toMatchObject({ resume: true, targetName: "a (1)", conflict: "rename" });
    expect(retryRequest({ ...row, status: "cancelled" }).resume).toBe(false);
  });
});

describe("remote editing (F2)", () => {
  it("restores CRLF line endings after the textarea normalises them", () => {
    const original = "a\r\nb\r\n";
    const eol = lineEnding(original);
    expect(eol).toBe("\r\n");
    expect(withLineEnding("a\nb\nc\n", eol)).toBe("a\r\nb\r\nc\r\n");
    expect(lineEnding("a\nb")).toBe("\n");
    expect(withLineEnding("a\nb", "\n")).toBe("a\nb");
  });
  it("parses and prints permissions", () => {
    expect(parseMode("755")).toBe(0o755);
    expect(parseMode("0640")).toBe(0o640);
    expect(parseMode("789")).toBe(null);
    expect(parseMode("rwx")).toBe(null);
    expect(modeString(0o100755)).toBe("rwxr-xr-x");
    expect(modeString(0o640)).toBe("rw-r-----");
  });
  it("summarises a recursive delete", () => {
    expect(deleteSummary({ files: 12, folders: 3 })).toBe(
      "3 thư mục và 12 file",
    );
    expect(deleteSummary({ files: 1, folders: 0 })).toBe("1 file");
  });
});

describe("sync planning (F3)", () => {
  const entries = [
    { path: "a.txt", folder: false, state: "localOnly" },
    { path: "b.txt", folder: false, state: "localNewer" },
    { path: "c.txt", folder: false, state: "remoteNewer" },
    { path: "d.txt", folder: false, state: "same" },
    { path: "e.txt", folder: false, state: "changed" },
    { path: "old", folder: true, state: "remoteOnly" },
    { path: "old/x.php", folder: false, state: "remoteOnly" },
    { path: "robots.txt", folder: false, state: "remoteOnly" },
    { path: "kind", folder: true, state: "typeMismatch" },
  ];
  it("pre-checks only safe copies for each direction", () => {
    expect(syncDefaults(entries, "upload")).toEqual(["a.txt", "b.txt"]);
    expect(syncDefaults(entries, "download")).toEqual([
      "c.txt",
      "old",
      "old/x.php",
      "robots.txt",
    ]);
    expect(
      entries.filter((e) => syncSelectable(e, "upload")).map((e) => e.path),
    ).toEqual(["a.txt", "b.txt", "c.txt", "e.txt"]);
  });
  it("deletes only when mirror is on, top-level destination-only entries", () => {
    const preview = {
      localDirectory: "C:\\site",
      remoteDirectory: "/site",
      entries,
    };
    const checked = new Set(["a.txt", "c.txt", "d.txt", "kind"]);
    const plain = syncRequest(preview, "s", "upload", checked, false);
    expect(plain.items).toEqual([
      { path: "a.txt", folder: false },
      { path: "c.txt", folder: false },
    ]);
    expect(plain.delete).toEqual([]);
    expect(syncRequest(preview, "s", "upload", checked, true).delete).toEqual([
      "old",
      "robots.txt",
    ]);
  });
});

describe("port forwarding (F5)", () => {
  const web = {
    id: "web",
    kind: "local",
    bindHost: "127.0.0.1",
    bindPort: 8080,
    targetHost: "db",
    targetPort: 5432,
  };
  const socks = { ...web, id: "socks", kind: "dynamic", bindPort: 0 };
  it("labels forwards with the port actually bound", () => {
    expect(forwardLabel(web)).toBe("127.0.0.1:8080 → db:5432");
    expect(forwardLabel(socks, 50123)).toBe("SOCKS5 127.0.0.1:50123");
  });
  it("warns only for non-loopback listeners", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
  });
  it("merges saved specs with live state of this session", () => {
    const live = {
      "s:web": { sessionId: "s", spec: web, status: "running", active: 1 },
      "s:socks": { sessionId: "s", spec: socks, status: "running" },
      "t:socks": { sessionId: "t", spec: socks, status: "running" },
      "s:old": {
        sessionId: "s",
        spec: { ...web, id: "old" },
        status: "stopped",
      },
    };
    const rows = forwardRows([web], live, "s");
    expect(rows.map((r) => [r.spec.id, r.saved, r.state?.status])).toEqual([
      ["web", true, "running"],
      ["socks", false, "running"],
    ]);
  });
});

describe("key export and backups (F6)", () => {
  it("checks backup passwords", () => {
    expect(passwordProblem("short", "short")).toMatch(/8/);
    expect(passwordProblem("long enough", "long enougH")).toMatch(/khớp/);
    expect(passwordProblem("long enough", "long enough")).toBe(null);
    expect(passwordProblem("", "", 0)).toBe(null);
  });
  it("suggests file names", () => {
    expect(backupFileName(new Date("2026-03-05T10:00:00Z"))).toBe(
      "ssh-studio-2026-03-05.sshstudio-backup",
    );
    expect(
      keyFileName({ algorithm: "ssh-ed25519", name: "Work Laptop!" }),
    ).toBe("id_ed25519_work-laptop");
  });
  it("summarises a restore", () => {
    expect(
      restoreSummary({
        hostsAdded: 2,
        hostsSkipped: 1,
        keysAdded: 1,
        keysSkipped: 0,
        knownAdded: 3,
        knownReplaced: 1,
        knownKept: 0,
      }),
    ).toBe(
      "2 server mới, 1 key mới, 3 known host mới, bỏ qua 1 mục đã có, thay 1 fingerprint",
    );
  });
});

describe("shortcuts and settings (F7)", () => {
  const key = (k, mods = {}) => ({
    type: "keydown",
    key: k,
    ctrlKey: true,
    ...mods,
  });
  it("maps the application shortcuts", () => {
    expect(shortcut(key("Tab"))).toEqual({ action: "nextTab" });
    expect(shortcut(key("Tab", { shiftKey: true }))).toEqual({
      action: "prevTab",
    });
    expect(shortcut(key("W", { shiftKey: true }))).toEqual({
      action: "closeSession",
    });
    expect(shortcut(key("T", { shiftKey: true }))).toEqual({
      action: "reopen",
    });
    expect(shortcut(key("F", { shiftKey: true }))).toEqual({
      action: "search",
    });
    expect(shortcut(key("3", { code: "Digit3" }))).toEqual({
      action: "tab",
      index: 2,
    });
    // French AZERTY: Ctrl+1 reports "&" but the physical code is still Digit1.
    expect(shortcut(key("&", { code: "Digit1" }))).toEqual({
      action: "tab",
      index: 0,
    });
    expect(shortcut(key("="))).toEqual({ action: "zoomIn" });
    expect(shortcut(key("+", { shiftKey: true }))).toEqual({
      action: "zoomIn",
    });
    expect(shortcut(key("-"))).toEqual({ action: "zoomOut" });
    expect(shortcut(key("0", { code: "Digit0" }))).toEqual({
      action: "zoomReset",
    });
  });
  it("leaves shell chords alone", () => {
    for (const k of ["c", "v", "w", "d", "r", "l", "a", "e", "u"])
      expect(shortcut(key(k), true)).toBe(null);
    expect(shortcut(key("k"), true)).toBe(null);
    expect(shortcut(key("k"), false)).toEqual({ action: "findServer" });
    expect(shortcut(key("K", { shiftKey: true }), true)).toEqual({
      action: "findServer",
    });
    expect(shortcut({ type: "keydown", key: "Tab" })).toBe(null);
    expect(shortcut(key("Tab", { altKey: true }))).toBe(null);
    expect(shortcut({ ...key("Tab"), type: "keyup" })).toBe(null);
  });
  it("cycles tabs and zooms within bounds", () => {
    expect(cycleTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycleTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(cycleTab(["a", "b"], "none", -1)).toBe("b");
    expect(cycleTab([], "a", 1)).toBe(null);
    expect(zoomFont(14, "zoomIn")).toBe(15);
    expect(zoomFont(8, "zoomOut")).toBe(8);
    expect(zoomFont(32, "zoomIn")).toBe(32);
    expect(zoomFont(20, "zoomReset")).toBe(14);
  });
  it("fills missing settings with the defaults", () => {
    const s = withDefaults({ fontSize: 18 });
    expect(s.fontSize).toBe(18);
    expect(s.confirmClose).toBe(true);
    expect(terminalOptions(s)).toMatchObject({
      fontSize: 18,
      cursorStyle: "block",
      scrollback: 10000,
    });
    expect(withDefaults(undefined)).toEqual(defaultSettings);
  });
});

describe("labels", () => {
  it("names the platform from the backend (B12)", () => {
    expect(osLabel("windows")).toBe("Windows");
    expect(osLabel("macos")).toBe("macOS");
    expect(osLabel("linux")).toBe("Linux");
    expect(osLabel("")).toBe("Desktop");
  });
  it("formats sizes", () => {
    expect(size(512)).toBe("512 B");
    expect(size(2048)).toBe("2.0 KB");
    expect(size(3 * 1073741824)).toBe("3.00 GB");
  });
});
