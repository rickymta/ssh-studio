import React from "react";
import { TerminalView } from "./TerminalView.jsx";
import { FileManager } from "./FileManager.jsx";
import { Terminal, FolderOpen, RefreshCw, LayoutGrid } from "lucide-react";
import { statuses } from "../lib.js";
import { Button } from "./ui.jsx";

export function SessionPane({
  session,
  visible,
  home,
  notify,
  transfers,
  showQueue,
  reconnect,
  setView,
}) {
  return (
    <section
      className="session-pane"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div className="session-toolbar">
        <div className="segmented">
          <button
            className={session.view === "terminal" ? "selected" : ""}
            onClick={() => setView("terminal")}
          >
            <Terminal size={16} />
            Terminal
          </button>
          <button
            className={session.view === "files" ? "selected" : ""}
            onClick={() => setView("files")}
          >
            <FolderOpen size={16} />
            Files
          </button>
          <button
            className={session.view === "split" ? "selected" : ""}
            onClick={() => setView("split")}
          >
            <LayoutGrid size={16} />
            Chia đôi
          </button>
        </div>
        <span className="session-address mono">
          {session.host.username}@{session.host.host}:{session.host.port}
        </span>
        <span className={`session-state ${session.status}`}>
          <i className={`status-dot ${session.status}`} />
          {statuses[session.status]}
        </span>
      </div>
      {session.status === "error" && (
        <div className="notice error">
          {session.error}
          <Button icon={RefreshCw} onClick={reconnect}>
            Kết nối lại
          </Button>
        </div>
      )}
      {session.status === "closed" && (
        <div className="notice">
          Phiên đã kết thúc.
          <Button icon={RefreshCw} onClick={reconnect}>
            Kết nối lại
          </Button>
        </div>
      )}
      <div className={`session-body ${session.view}`}>
        <div
          className="terminal-wrap"
          style={{ display: session.view === "files" ? "none" : "flex" }}
        >
          <div className="terminal-caption">
            <Terminal size={13} />
            {session.host.name}
            <span>SSH · xterm-256color</span>
          </div>
          <TerminalView
            id={session.id}
            visible={visible && session.view !== "files"}
            status={session.status}
          />
        </div>
        {session.view !== "terminal" && (
          <FileManager
            session={session}
            home={home}
            notify={notify}
            transfers={transfers}
            showQueue={showQueue}
          />
        )}
      </div>
    </section>
  );
}
