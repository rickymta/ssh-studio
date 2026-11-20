import React, { useRef } from "react";
import { TerminalView } from "./TerminalView.jsx";
import { FileManager } from "./FileManager.jsx";
import { PortsPanel } from "./PortsPanel.jsx";
import {
  Terminal,
  FolderOpen,
  RefreshCw,
  LayoutGrid,
  Cable,
} from "lucide-react";
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
  forwards,
  savedHost,
  saveForwards,
  settings,
}) {
  const latencyLabel = useRef();
  const running = Object.values(forwards || {}).filter(
    (f) => f.sessionId === session.id && f.status === "running",
  ).length;
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
          <button
            className={session.view === "ports" ? "selected" : ""}
            onClick={() => setView("ports")}
          >
            <Cable size={16} />
            Ports{running > 0 && <b className="count-badge">{running}</b>}
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
          style={{
            display: ["files", "ports"].includes(session.view)
              ? "none"
              : "flex",
          }}
        >
          <div className="terminal-caption">
            <Terminal size={13} />
            {session.host.name}
            <span>
              <i
                ref={latencyLabel}
                className="terminal-latency"
                title="Thời gian từ lúc gõ phím tới khi server phản hồi: đường mạng hai chiều + xử lý trên server + ứng dụng."
              />
              SSH · xterm-256color
            </span>
          </div>
          <TerminalView
            latencyLabel={latencyLabel}
            id={session.id}
            visible={visible && !["files", "ports"].includes(session.view)}
            status={session.status}
            settings={settings}
            notify={notify}
          />
        </div>
        {session.view === "ports" && (
          <PortsPanel
            session={session}
            savedHost={savedHost}
            forwards={forwards || {}}
            notify={notify}
            saveForwards={saveForwards}
          />
        )}
        {["files", "split"].includes(session.view) && (
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
