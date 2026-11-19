import React, { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { desktop, call } from "../lib.js";

export function TerminalView({ id, visible, status }) {
  const container = useRef();
  const term = useRef();
  const fit = useRef();
  const statusRef = useRef(status);
  statusRef.current = status;
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
        if (payload.id === id) terminal.write(new Uint8Array(payload.data));
      }).then((fn) => {
        if (disposed) fn();
        else off = fn;
      });
    const input = terminal.onData((data) => {
      if (statusRef.current === "connected")
        call("terminal_input", { id, data }).catch(() => {});
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (statusRef.current === "connected")
        call("terminal_resize", { id, cols, rows }).catch(() => {});
    });
    const observer = new ResizeObserver(() => {
      if (container.current?.offsetWidth)
        try {
          addon.fit();
        } catch {}
    });
    observer.observe(container.current);
    return () => {
      disposed = true;
      off?.();
      observer.disconnect();
      input.dispose();
      resize.dispose();
      terminal.dispose();
    };
  }, [id]);
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
