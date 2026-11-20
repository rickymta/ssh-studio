import React, { useRef } from "react";
import { TerminalView } from "./TerminalView.jsx";
import { FileManager } from "./FileManager.jsx";
import { PortsPanel } from "./PortsPanel.jsx";
import {
  Terminal,
  FolderOpen,
  RefreshCw,
  LayoutGrid,
  Columns2,
  Cable,
} from "lucide-react";
import { statuses } from "../lib.js";
import { Button } from "./ui.jsx";
import { Splitter, useLayout } from "./layout.jsx";

const views = [
  ["terminal", "Terminal", Terminal],
  ["files", "Files", FolderOpen],
  ["split", "Chia đôi", LayoutGrid, "Terminal ở trên, file ở dưới"],
  ["side", "Song song", Columns2, "Terminal bên trái, file bên phải"],
];
/** Views showing both the terminal and the file manager, and the layout field sizing them. */
const paired = { split: "split", side: "side" };

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
  const layout = useLayout();
  const pair = paired[session.view];
  const showTerminal = !["files", "ports"].includes(session.view);
  return (
    <section
      className="session-pane"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div className="session-toolbar">
        <div className="segmented">
          {views.map(([value, label, Icon, title]) => (
            <button
              key={value}
              title={title}
              className={session.view === value ? "selected" : ""}
              onClick={() => setView(value)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
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
            display: showTerminal ? "flex" : "none",
            flex: pair ? `0 0 ${layout[pair] * 100}%` : undefined,
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
            visible={visible && showTerminal}
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
        {pair && (
          <Splitter
            field={pair}
            vertical={pair === "side"}
            label={pair === "side" ? "Độ rộng terminal" : "Chiều cao terminal"}
          />
        )}
        {["files", "split", "side"].includes(session.view) && (
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
