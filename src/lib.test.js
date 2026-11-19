import { describe, expect, it } from "vitest";
import {
  binaryBytes,
  clipboardChord,
  fromBase64,
  isFolder,
  osLabel,
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
