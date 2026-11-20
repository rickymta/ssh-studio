import React, { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { ChevronDown, ChevronUp, X } from "lucide-react";
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
  defaultSettings,
  shortcut,
  terminalOptions,
  echoMeter,
} from "../lib.js";

/**
 * GPU renderer: echoed characters are drawn without DOM layout. Falls back to xterm's DOM
 * renderer when WebGL2 is unavailable or the GPU context is lost.
 */
function useWebgl(terminal) {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    terminal.loadAddon(webgl);
  } catch {}
}

const searchDecorations = {
  matchBackground: "#3a4a2a",
  matchBorder: "#6f8a4a",
  matchOverviewRuler: "#a8c47a",
  activeMatchBackground: "#7a5d1e",
  activeMatchBorder: "#edcc87",
  activeMatchColorOverviewRuler: "#edcc87",
};

export function TerminalView({
  id,
  visible,
  status,
  settings = defaultSettings,
  notify = () => {},
  latencyLabel,
}) {
  const container = useRef();
  const meter = useRef(echoMeter());
  const term = useRef();
  const fit = useRef();
  const finder = useRef();
  const searchInput = useRef();
  const statusRef = useRef(status);
  statusRef.current = status;
  const options = useRef({ settings, notify, latencyLabel });
  options.current = { settings, notify, latencyLabel };
  const previous = useRef(status);
  const [search, setSearch] = useState(null);
  const [results, setResults] = useState(null);
  const openSearch = useRef();
  openSearch.current = () => {
    setSearch(
      (old) => old || { query: "", caseSensitive: false, regex: false },
    );
    requestAnimationFrame(() => searchInput.current?.select());
  };
  useEffect(() => {
    let disposed = false;
    let off;
    const terminal = new XTerminal({
      ...terminalOptions(options.current.settings),
      // Search highlights are terminal decorations.
      allowProposedApi: true,
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
    const searchAddon = new SearchAddon();
    terminal.loadAddon(addon);
    terminal.loadAddon(searchAddon);
    terminal.open(container.current);
    useWebgl(terminal);
    term.current = terminal;
    // The label lives in the session caption; it is written directly (no React render on
    // every keystroke) and at most twice a second.
    let shown = null;
    let labelTimer;
    const showLatency = (ms) => {
      shown = ms;
      labelTimer ??= setTimeout(() => {
        labelTimer = undefined;
        const label = options.current.latencyLabel?.current;
        if (label) label.textContent = `phản hồi ~${Math.round(shown)} ms`;
      }, 500);
    };
    fit.current = addon;
    finder.current = searchAddon;
    const found = searchAddon.onDidChangeResults((r) => setResults(r));
    terminal.writeln(
      "\x1b[38;2;112;217;190mSSH Studio\x1b[0m  ·  Đang mở phiên kết nối…\r\n",
    );
    if (desktop)
      listen("terminal", ({ payload }) => {
        if (payload.id !== id) return;
        const ms = meter.current.output(performance.now());
        if (ms !== null) showLatency(ms);
        terminal.write(fromBase64(payload.data));
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
      if (chord) {
        e.preventDefault();
        if (chord === "copy") copy();
        else paste();
        return false;
      }
      const action = shortcut(e, true);
      if (action) {
        // Not sent to the shell; the window handler (App) acts on it.
        if (action.action === "search") {
          e.preventDefault();
          e.stopPropagation();
          openSearch.current();
        }
        return false;
      }
      return true;
    });
    const input = terminal.onData((data) => {
      const bytes = textBytes(data);
      if (statusRef.current === "connected")
        meter.current.input(performance.now(), bytes.length);
      send(bytes);
    });
    const binary = terminal.onBinary((data) => send(binaryBytes(data)));
    const selection = terminal.onSelectionChange(() => {
      if (options.current.settings.copyOnSelect && terminal.hasSelection())
        copy();
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
    // Ctrl+Shift+F pressed outside the terminal (e.g. in the file pane of a split view).
    const searchRequest = (e) => {
      if (e.detail === id) openSearch.current();
    };
    window.addEventListener("terminal-search", searchRequest);
    return () => {
      disposed = true;
      clearTimeout(labelTimer);
      off?.();
      observer.disconnect();
      window.removeEventListener("terminal-search", searchRequest);
      element.removeEventListener("contextmenu", contextMenu);
      input.dispose();
      binary.dispose();
      selection.dispose();
      resize.dispose();
      found.dispose();
      terminal.dispose();
    };
  }, [id]);
  // Settings apply to open terminals without reconnecting.
  useEffect(() => {
    const terminal = term.current;
    if (!terminal) return;
    const next = terminalOptions(settings);
    for (const [key, value] of Object.entries(next))
      if (terminal.options[key] !== value) terminal.options[key] = value;
    try {
      if (container.current?.offsetWidth) fit.current.fit();
    } catch {}
  }, [
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.scrollback,
    settings.cursorStyle,
    settings.cursorBlink,
  ]);
  useEffect(() => {
    if (status !== "connected") {
      meter.current.reset();
      const label = latencyLabel?.current;
      if (label) label.textContent = "";
    }
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
          if (!search) term.current.focus();
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

  // Typing refines the current match (incremental); Enter / arrows move to the next one.
  const find = (backwards = false, next = search, incremental = false) => {
    if (!next?.query) {
      finder.current?.clearDecorations();
      setResults(null);
      return;
    }
    const opts = {
      caseSensitive: next.caseSensitive,
      regex: next.regex,
      decorations: searchDecorations,
    };
    try {
      if (backwards) finder.current.findPrevious(next.query, opts);
      else finder.current.findNext(next.query, { ...opts, incremental });
    } catch {
      // Incomplete regular expression while typing.
      setResults({ resultIndex: -1, resultCount: 0 });
    }
  };
  const update = (patch) => {
    const next = { ...search, ...patch };
    setSearch(next);
    find(false, next, true);
  };
  const closeSearch = () => {
    finder.current?.clearDecorations();
    term.current?.clearSelection();
    setSearch(null);
    setResults(null);
    term.current?.focus();
  };
  return (
    <div className="terminal-view">
      {search && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            autoFocus
            aria-label="Tìm trong terminal"
            placeholder="Tìm trong terminal"
            value={search.query}
            onChange={(e) => update({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find(e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }
            }}
          />
          <span className="terminal-search-count">
            {search.query
              ? results?.resultCount
                ? results.resultIndex < 0
                  ? `${results.resultCount}+ kết quả`
                  : `${results.resultIndex + 1}/${results.resultCount}`
                : "0 kết quả"
              : ""}
          </span>
          <button
            className={`terminal-search-toggle ${search.caseSensitive ? "on" : ""}`}
            title="Phân biệt hoa thường"
            aria-pressed={search.caseSensitive}
            onClick={() => update({ caseSensitive: !search.caseSensitive })}
          >
            Aa
          </button>
          <button
            className={`terminal-search-toggle ${search.regex ? "on" : ""}`}
            title="Biểu thức chính quy"
            aria-pressed={search.regex}
            onClick={() => update({ regex: !search.regex })}
          >
            .*
          </button>
          <button
            title="Kết quả trước (Shift+Enter)"
            onClick={() => find(true)}
          >
            <ChevronUp size={15} />
          </button>
          <button title="Kết quả sau (Enter)" onClick={() => find(false)}>
            <ChevronDown size={15} />
          </button>
          <button title="Đóng (Esc)" onClick={closeSearch}>
            <X size={15} />
          </button>
        </div>
      )}
      {/* FitAddon sizes the terminal from its parent's computed height, which includes
          padding under border-box: keep the padding outside the measured element. */}
      <div className="terminal-container">
        <div className="terminal-host" ref={container} />
      </div>
    </div>
  );
}
