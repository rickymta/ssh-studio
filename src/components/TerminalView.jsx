import React, { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  desktop,
  call,
  toBase64,
  fromBase64,
  textBytes,
  binaryBytes,
  clipboardChord,
  readClipboard,
  writeClipboard,
  cleanError,
} from "../lib.js";

export function TerminalView({
  id,
  visible,
  status,
  copyOnSelect = false,
  notify = () => {},
}) {
  const container = useRef();
  const term = useRef();
  const fit = useRef();
  const statusRef = useRef(status);
  statusRef.current = status;
  const options = useRef({ copyOnSelect, notify });
  options.current = { copyOnSelect, notify };
  const previous = useRef(status);
  useEffect(() => {
    let disposed = false;
    let off;
    const terminal = new XTerminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 10000,
      theme: {
        background: "#0b1016",
        foreground: "#dce5ed",
        cursor: "#7fe4cb",
        selectionBackground: "#284b4f",
        black: "#1d2631",
        red: "#ee8087",
        green: "#80dbb4",
        yellow: "#edcc87",
        blue: "#89b8ef",
        magenta: "#ba9ff0",
        cyan: "#7cd8de",
        white: "#dce5ed",
      },
    });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(container.current);
    term.current = terminal;
    fit.current = addon;
    terminal.writeln(
      "\x1b[38;2;112;217;190mSSH Studio\x1b[0m  ·  Đang mở phiên kết nối…\r\n",
    );
    if (desktop)
      listen("terminal", ({ payload }) => {
        if (payload.id === id) terminal.write(fromBase64(payload.data));
      }).then((fn) => {
        if (disposed) fn();
        else off = fn;
      });
    const send = (bytes) => {
      if (statusRef.current === "connected")
        call("terminal_input", { id, data: toBase64(bytes) }).catch(() => {});
    };
    const copy = () => {
      const text = terminal.getSelection();
      if (text)
        writeClipboard(text).catch((e) => options.current.notify(e, true));
    };
    const paste = () =>
      readClipboard()
        .then((text) => text && terminal.paste(text))
        .catch((e) =>
          options.current.notify(
            `Không đọc được clipboard: ${cleanError(e)}`,
            true,
          ),
        );
    terminal.attachCustomKeyEventHandler((e) => {
      const chord = clipboardChord(e);
      if (!chord) return true;
      e.preventDefault();
      if (chord === "copy") copy();
      else paste();
      return false;
    });
    const input = terminal.onData((data) => send(textBytes(data)));
    const binary = terminal.onBinary((data) => send(binaryBytes(data)));
    const selection = terminal.onSelectionChange(() => {
      if (options.current.copyOnSelect && terminal.hasSelection()) copy();
    });
    const contextMenu = (e) => {
      e.preventDefault();
      if (terminal.hasSelection()) {
        copy();
        terminal.clearSelection();
      } else paste();
    };
    container.current.addEventListener("contextmenu", contextMenu);
    const resize = terminal.onResize(({ cols, rows }) => {
      if (statusRef.current === "connected")
        call("terminal_resize", { id, cols, rows }).catch(() => {});
    });
    const element = container.current;
    const observer = new ResizeObserver(() => {
      if (element?.offsetWidth)
        try {
          addon.fit();
        } catch {}
    });
    observer.observe(element);
    return () => {
      disposed = true;
      off?.();
      observer.disconnect();
      element.removeEventListener("contextmenu", contextMenu);
      input.dispose();
      binary.dispose();
      selection.dispose();
      resize.dispose();
      terminal.dispose();
    };
  }, [id]);
  useEffect(() => {
    // Reconnecting keeps the same tab and scrollback; mark where the new session starts.
    if (
      status === "connecting" &&
      ["closed", "error"].includes(previous.current)
    )
      term.current?.writeln(
        "\r\n\x1b[38;2;112;217;190m── Đang kết nối lại…\x1b[0m\r\n",
      );
    previous.current = status;
  }, [status]);
  useEffect(() => {
    if (visible && term.current) {
      requestAnimationFrame(() => {
        try {
          fit.current.fit();
          term.current.focus();
          if (status === "connected")
            call("terminal_resize", {
              id,
              cols: term.current.cols,
              rows: term.current.rows,
            }).catch(() => {});
        } catch {}
      });
    }
  }, [visible, status]);
  return <div className="terminal-container" ref={container} />;
}
