import { createRoot } from "react-dom/client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { confirm } from "@tauri-apps/plugin-dialog";
import appIcon from "../assets/logo.svg";
import statusbarIcon from "../assets/statusbar.svg";
import { HostModal } from "./components/HostModal.jsx";
import { HelpModal } from "./components/HelpModal.jsx";
import { ActivityModal } from "./components/ActivityModal.jsx";
import { logActivity, useActivity } from "./activity.js";
import {
  WorkspaceModal,
  WorkspaceSwitcher,
} from "./components/WorkspaceSwitcher.jsx";
import { AuthPromptModal } from "./components/AuthPromptModal.jsx";
import { KeyModal } from "./components/KeyModal.jsx";
import { SessionPane } from "./components/SessionPane.jsx";
import { TransferPanel } from "./components/TransferPanel.jsx";
import { SettingsPage } from "./components/SettingsPage.jsx";
import {
  BackupModal,
  ExportKeyModal,
  RestoreModal,
} from "./components/BackupModals.jsx";
import {
  ArchiveRestore,
  DatabaseBackup,
  FileKey,
  Terminal,
  Server,
  KeyRound,
  Plus,
  Search,
  Folder,
  FolderOpen,
  Upload,
  Download,
  X,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  Copy,
  ShieldCheck,
  Monitor,
  Check,
  Unplug,
  LayoutGrid,
  LockKeyhole,
  ScrollText,
  CircleHelp,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  APP_VERSION,
  desktop,
  call,
  uid,
  cleanError,
  osLabel,
  restoreSummary,
  retryRequest,
  withDefaults,
  shortcut,
  browserKey,
  cycleTab,
  zoomFont,
  workspaceView,
} from "./lib.js";
import { Button, IconButton, Modal } from "./components/ui.jsx";

import "@xterm/xterm/css/xterm.css";
import "./style.css";

const authLabels = {
  password: "Password",
  key: "SSH key",
  agent: "SSH agent",
  interactive: "MFA / OTP",
};

function App() {
  const [data, setData] = useState({
    hosts: [],
    keys: [],
    knownHosts: {},
    home: "",
  });
  const [page, setPage] = useState("hosts");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState("");
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [transfers, setTransfers] = useState([]);
  const [showTransfers, setShowTransfers] = useState(false);
  const [verification, setVerification] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const [forwards, setForwards] = useState({});
  const [ready, setReady] = useState(false);
  const [recoveredSeen, setRecoveredSeen] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  const settings = withDefaults(data.settings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Servers of recently closed sessions, newest last (Ctrl+Shift+T).
  const closedHosts = useRef([]);
  const searchBox = useRef();
  const [trayReady, setTrayReady] = useState(false);
  const trayRef = useRef(false);
  trayRef.current = trayReady;
  const notify = useCallback((message, error = false, source = "") => {
    const text = cleanError(message);
    setToast({ message: text, error });
    logActivity(text, { level: error ? "error" : "info", source });
  }, []);
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      notify(e, true);
    }
  };
  const saveSettings = async (next, quiet = false) => {
    const previous = settingsRef.current;
    // Applied at once (fast repeated zoom keys); the backend's normalised copy follows.
    setData((old) => ({ ...old, settings: next }));
    if (!desktop) return;
    try {
      setData(await call("save_settings", { settings: next }));
      if (!quiet) notify("Đã lưu cài đặt.");
    } catch (e) {
      setData((old) => ({ ...old, settings: previous }));
      notify(e, true);
    }
  };
  // Work that closing the window or quitting would interrupt.
  const busy = () =>
    sessionsRef.current.some((s) =>
      ["connected", "connecting"].includes(s.status),
    ) ||
    transfersRef.current.some((t) => ["queued", "running"].includes(t.status));
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 6500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (!desktop) return;
    const removers = [];
    let disposed = false;
    const register = async (event, callback) => {
      const off = await listen(event, ({ payload }) => callback(payload));
      if (disposed) off();
      else removers.push(off);
    };
    Promise.all([
      call("snapshot").then(setData),
      register("session", (payload) => {
        const session = sessionsRef.current.find((s) => s.id === payload.id);
        if (session && session.status !== payload.status) {
          const source = session.host.name;
          if (payload.status === "connected")
            logActivity(
              `Đã kết nối ${session.host.username}@${session.host.host}`,
              { level: "success", source },
            );
          else if (payload.status === "closed")
            logActivity("Phiên đã đóng", { source });
        }
        setSessions((old) =>
          old.map((s) => (s.id === payload.id ? { ...s, ...payload } : s)),
        );
      }),
      register("host-verification", (payload) =>
        setVerification((old) => [...old, payload]),
      ),
      register("host-verification-finished", (payload) =>
        setVerification((old) => old.filter((item) => item.id !== payload.id)),
      ),
      register("forward", (payload) =>
        setForwards((old) => ({ ...old, [payload.id]: payload })),
      ),
      call("tray_available").then(setTrayReady),
      call("list_forwards").then((list) =>
        setForwards(Object.fromEntries(list.map((f) => [f.id, f]))),
      ),
      register("auth-prompt", (payload) =>
        setPrompts((old) => [...old, payload]),
      ),
      register("auth-prompt-finished", (payload) =>
        setPrompts((old) => old.filter((item) => item.id !== payload.id)),
      ),
      // A password was remembered (or a stale one dropped) after a login.
      register("host-password", ({ hostId, saved }) =>
        setData((old) => ({
          ...old,
          hosts: old.hosts.map((h) =>
            h.id === hostId ? { ...h, hasSavedPassword: saved } : h,
          ),
        })),
      ),
      register("transfer", (payload) => {
        logTransfer(payload);
        setTransfers((old) => {
          const index = old.findIndex((t) => t.id === payload.id);
          return index < 0
            ? [payload, ...old]
            : old.map((t) =>
                t.id === payload.id
                  ? {
                      ...t,
                      ...payload,
                      // Final events do not repeat progress; keep the last known numbers.
                      bytes: payload.bytes || t.bytes,
                      total: payload.total || t.total,
                      error: payload.error,
                      resumable: payload.resumable,
                    }
                  : t,
              );
        });
      }),
    ])
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((e) => notify(e, true));
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (settingsRef.current.closeToTray && trayRef.current) {
          // Sessions keep running; the tray icon shows the window again.
          event.preventDefault();
          await getCurrentWindow().hide();
          return;
        }
        if (settingsRef.current.confirmClose && busy()) {
          event.preventDefault();
          if (
            await confirm(
              "Các phiên terminal sẽ đóng và file đang truyền sẽ bị hủy. Bạn muốn thoát?",
              { title: "Đóng SSH Studio", kind: "warning" },
            )
          )
            await getCurrentWindow().destroy();
        }
      })
      .then((off) => (disposed ? off() : removers.push(off)));
    // "Thoát SSH Studio" in the tray menu.
    register("quit-requested", async () => {
      if (
        settingsRef.current.confirmClose &&
        busy() &&
        !(await confirm(
          "Các phiên terminal sẽ đóng và file đang truyền sẽ bị hủy. Bạn muốn thoát?",
          { title: "Thoát SSH Studio", kind: "warning" },
        ))
      )
        return;
      await call("quit_app");
    });
    return () => {
      disposed = true;
      removers.forEach((off) => off());
    };
  }, []);
  // Finished transfers go to the activity log once (no contents, only names).
  const logTransfer = (t) => {
    const before = transfersRef.current.find((x) => x.id === t.id);
    if (before?.status === t.status) return;
    const source = sessionsRef.current.find((s) => s.id === t.sessionId)?.host
      .name;
    const upload = t.direction === "upload";
    const messages = {
      completed: [
        `Đã ${upload ? "tải lên" : "tải xuống"} ${t.name}`,
        "success",
      ],
      failed: [
        `Truyền ${t.name} thất bại: ${cleanError(t.error || "")}`,
        "error",
      ],
      cancelled: [`Đã hủy truyền ${t.name}`, "info"],
      skipped: [`Bỏ qua ${t.name} (đích đã tồn tại)`, "info"],
    };
    const [message, level] = messages[t.status] || [];
    if (message) logActivity(message, { level, source });
  };
  // Interface zoom: the WebView's own zoom in the app, CSS zoom in the browser preview.
  useEffect(() => {
    const scale = (settings.uiScale || 100) / 100;
    if (desktop)
      getCurrentWebview()
        .setZoom(scale)
        .catch(() => {});
    else document.documentElement.style.zoom = scale;
  }, [settings.uiScale]);
  const activity = useActivity();
  const activityErrors = activity.filter((e) => e.level === "error").length;
  const connected = sessions.filter((s) => s.status === "connected").length;
  const current = sessions.find((s) => s.id === active);
  const selectSession = (id) => {
    setActive(id);
    setPage("session");
  };
  const begin = async (host, reuseId = null) => {
    const id = reuseId || uid();
    // Reconnect keeps the existing tab (and its terminal scrollback) instead of opening a new one.
    setSessions((old) =>
      reuseId && old.some((s) => s.id === reuseId)
        ? old.map((s) =>
            s.id === reuseId
              ? { ...s, host, status: "connecting", error: undefined }
              : s,
          )
        : [
            ...old,
            {
              id,
              host,
              status: "connecting",
              view: settingsRef.current.defaultView,
            },
          ],
    );
    setActive(id);
    setPage("session");
    setModal(null);
    try {
      // Passwords / OTP are asked for through "auth-prompt" events while connecting.
      await call("connect", { id, hostId: host.id });
      setData(await call("snapshot"));
    } catch (e) {
      setSessions((old) =>
        old.map((s) =>
          s.id === id ? { ...s, status: "error", error: cleanError(e) } : s,
        ),
      );
      notify(e, true, host.name);
    }
  };
  const connectHost = (host, reuseId = null) => {
    if (!ready) return notify("Backend chưa sẵn sàng.", true);
    // Use the latest saved settings of the server when reconnecting.
    host = data.hosts.find((h) => h.id === host.id) || host;
    begin(host, reuseId);
  };
  const closeSession = async (id) => {
    const item = sessions.find((s) => s.id === id);
    if (item?.status === "connecting")
      return notify("Chờ kết nối hoàn tất hoặc từ chối xác nhận fingerprint.");
    if (
      item?.status === "connected" &&
      settings.confirmClose &&
      !(await confirm(
        "Đóng phiên terminal này? Các lệnh đang chạy có thể dừng.",
        { title: "Ngắt kết nối", kind: "warning" },
      ))
    )
      return;
    await run(async () => {
      await call("disconnect", { id });
      if (item) closedHosts.current.push(item.host.id);
      setSessions((old) => old.filter((s) => s.id !== id));
      if (active === id) {
        const next = sessions.find((s) => s.id !== id);
        if (next) setActive(next.id);
        else setPage("hosts");
      }
    });
  };
  useEffect(() => {
    if (desktop) call("set_tray_sessions", { connected }).catch(() => {});
  }, [connected]);
  const onShortcut = useRef();
  onShortcut.current = (e) => {
    if (document.querySelector(".modal-backdrop")) return;
    const hit = shortcut(e, !!e.target.closest?.(".xterm"));
    if (!hit) return;
    const { action } = hit;
    const onSession = page === "session" && current;
    if (action === "nextTab" || action === "prevTab") {
      const next = cycleTab(
        sessions.map((s) => s.id),
        onSession ? active : null,
        action === "nextTab" ? 1 : -1,
      );
      if (next) selectSession(next);
    } else if (action === "tab") {
      if (sessions[hit.index]) selectSession(sessions[hit.index].id);
    } else if (action === "closeSession") {
      if (onSession) closeSession(active);
    } else if (action === "reopen") {
      let host;
      while (!host && closedHosts.current.length) {
        const id = closedHosts.current.pop();
        host = data.hosts.find((h) => h.id === id);
      }
      if (host) connectHost(host);
      else notify("Chưa có phiên nào vừa đóng để mở lại.");
    } else if (action.startsWith("zoom")) {
      const fontSize = zoomFont(settings.fontSize, action);
      if (fontSize !== settings.fontSize)
        saveSettings({ ...settings, fontSize }, true);
    } else if (action === "help") {
      setModal({ type: "help" });
    } else if (action === "activity") {
      setModal({ type: "activity" });
    } else if (action === "findServer") {
      setPage("hosts");
      requestAnimationFrame(() => searchBox.current?.select());
    } else if (action === "search") {
      if (onSession && !["files", "ports"].includes(current.view))
        window.dispatchEvent(
          new CustomEvent("terminal-search", { detail: active }),
        );
      else return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e) => onShortcut.current(e);
    // Capture phase, before the terminal and inputs: F5 & co. must never reload the app.
    const browser = (e) => browserKey(e) && e.preventDefault();
    window.addEventListener("keydown", browser, true);
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", browser, true);
      window.removeEventListener("keydown", handler);
    };
  }, []);
  const view = workspaceView(data);
  const filtered = view.hosts.filter(
    (h) =>
      (group === "all" || h.group === group) &&
      `${h.name} ${h.host} ${h.username}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = [...new Set(view.hosts.map((h) => h.group))];
  // A group filter whose last server was deleted or moved falls back to "all".
  useEffect(() => {
    if (group !== "all" && !groups.includes(group)) setGroup("all");
  }, [data.hosts, data.activeWorkspace, group]);
  const activateWorkspace = (id) =>
    run(async () => {
      setData(await call("activate_workspace", { id }));
      setPage("hosts");
    });
  const onDeleteHost = (host) =>
    run(async () => {
      if (
        await confirm(`Xóa cấu hình “${host.name}”?`, {
          title: "Xóa server",
          kind: "warning",
        })
      )
        setData(await call("delete_host", { id: host.id }));
    });
  const pending = transfers.filter((t) =>
    ["queued", "running"].includes(t.status),
  ).length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src={appIcon} width="39" height="39" alt="" />
          </span>
          <div>
            SSH Studio<small>YOUR SERVER WORKSPACE</small>
          </div>
        </div>
        <WorkspaceSwitcher
          view={view}
          activate={activateWorkspace}
          edit={(workspace) => setModal({ type: "workspace", workspace })}
        />
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${page === "hosts" ? "active" : ""}`}
          onClick={() => {
            setPage("hosts");
            setGroup("all");
          }}
        >
          <Server size={18} />
          Servers<span className="count">{view.hosts.length}</span>
        </button>
        <button
          className={`nav-item ${page === "keys" ? "active" : ""}`}
          onClick={() => setPage("keys")}
        >
          <KeyRound size={18} />
          SSH Keys<span className="count">{data.keys.length}</span>
        </button>
        <button
          className={`nav-item ${page === "known" ? "active" : ""}`}
          onClick={() => setPage("known")}
        >
          <ShieldCheck size={18} />
          Known Hosts
        </button>
        <button
          className={`nav-item ${page === "settings" ? "active" : ""}`}
          onClick={() => setPage("settings")}
        >
          <SettingsIcon size={18} />
          Cài đặt
        </button>
        <div className="nav-label group-label">NHÓM SERVER</div>
        {groups.length ? (
          groups.map((g) => (
            <button
              key={g}
              className={`nav-item subtle ${group === g && page === "hosts" ? "active" : ""}`}
              onClick={() => {
                setGroup(g);
                setPage("hosts");
              }}
            >
              <Folder size={17} />
              {g}
              <span className="count">
                {view.hosts.filter((h) => h.group === g).length}
              </span>
            </button>
          ))
        ) : (
          <p className="sidebar-hint">
            Thêm server để tạo nhóm
            <br />
            theo dự án hoặc môi trường.
          </p>
        )}
        <div className="nav-label group-label">
          PHIÊN ĐANG MỞ <span>{sessions.length}</span>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`nav-item session-nav ${page === "session" && active === s.id ? "active" : ""}`}
              onClick={() => selectSession(s.id)}
            >
              <i className={`status-dot ${s.status}`} />
              <div>
                {s.host.name}
                <small>
                  {s.host.username}@{s.host.host}
                </small>
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <ShieldCheck size={16} />
          <div>
            Local-first. Riêng tư.<small>Phiên bản {APP_VERSION}</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <span>{view.active.name}</span>
            <ChevronRight size={14} />
            <strong>
              {page === "hosts"
                ? "Servers"
                : page === "keys"
                  ? "SSH Keys"
                  : page === "known"
                    ? "Known Hosts"
                    : page === "settings"
                      ? "Cài đặt"
                      : current?.host.name || "Terminal"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="connection-count">
              <i className={`status-dot ${connected ? "connected" : ""}`} />
              {connected} kết nối
            </span>
            <span className="os-label">
              <Monitor size={14} /> {osLabel(data.os)}
            </span>
          </div>
        </header>
        {sessions.length > 0 && (
          <div className="tabs">
            <button
              className={page !== "session" ? "selected" : ""}
              onClick={() => setPage("hosts")}
            >
              <LayoutGrid size={15} />
              Workspace
            </button>
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`tab ${page === "session" && active === s.id ? "selected" : ""}`}
              >
                <button onClick={() => selectSession(s.id)}>
                  <i className={`status-dot ${s.status}`} />
                  {s.host.name}
                </button>
                <IconButton
                  icon={X}
                  title="Đóng phiên"
                  onClick={() => closeSession(s.id)}
                />
              </div>
            ))}
            <IconButton
              icon={Plus}
              title="Mở kết nối khác"
              onClick={() => setPage("hosts")}
            />
          </div>
        )}
        <div className="main-content">
          {page === "hosts" && (
            <section className="page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">KẾT NỐI. LÀM VIỆC. QUẢN LÝ.</div>
                  <h1>
                    {group === "all" ? "Servers" : group}
                    <span>
                      {group === "all" ? view.hosts.length : filtered.length}
                    </span>
                  </h1>
                  <p>
                    Terminal và file của mọi server, trong một không gian làm
                    việc.
                  </p>
                </div>
                <Button
                  icon={Plus}
                  variant="primary"
                  onClick={() => setModal({ type: "host" })}
                >
                  Thêm server
                </Button>
              </div>
              {!desktop && (
                <div className="notice">
                  Bạn đang xem giao diện web. Chạy <code>npm start</code> để kết
                  nối SSH qua ứng dụng Tauri.
                </div>
              )}
              {data.recovered && !recoveredSeen && (
                <div className="notice error">
                  <span>
                    File cấu hình bị hỏng nên SSH Studio đã khởi động với
                    workspace trống. Bản cũ được giữ lại tại{" "}
                    <code>{data.recovered}</code> trong thư mục dữ liệu ứng dụng
                    để khôi phục thủ công.
                  </span>
                  <Button onClick={() => setRecoveredSeen(true)}>
                    Đã hiểu
                  </Button>
                </div>
              )}
              <div className="toolbar">
                <div className="search-box">
                  <Search size={18} />
                  <input
                    ref={searchBox}
                    aria-label="Tìm server"
                    title="Ctrl+K"
                    placeholder="Tìm theo tên, IP hoặc username…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <kbd>⌕</kbd>
                </div>
                <select
                  aria-label="Lọc nhóm"
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="all">Tất cả nhóm</option>
                  {groups.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
                <div className="view-indicator">
                  <LayoutGrid size={17} />
                </div>
              </div>
              {view.hosts.length === 0 ? (
                <div className="welcome">
                  <div className="welcome-art">
                    <span className="orbit orbit-one" />
                    <span className="orbit orbit-two" />
                    <div className="floating-key">
                      <KeyRound size={23} />
                    </div>
                    <div className="terminal-symbol">
                      <Terminal size={50} />
                    </div>
                    <div className="floating-folder">
                      <FolderOpen size={25} />
                    </div>
                  </div>
                  <span className="pill">MỘT WORKSPACE, MỌI SERVER</span>
                  <h2>Server đầu tiên của bạn bắt đầu ở đây.</h2>
                  <p>
                    Lưu kết nối một lần. Mở nhiều terminal, duyệt file
                    <br />
                    và chuyển đổi giữa các server chỉ với một cú nhấp.
                  </p>
                  <Button
                    variant="primary"
                    icon={Plus}
                    onClick={() => setModal({ type: "host" })}
                  >
                    Thêm server đầu tiên
                  </Button>
                  <div className="onboarding">
                    <div>
                      <span>
                        <Terminal size={20} />
                      </span>
                      <strong>Terminal đa phiên</strong>
                      <p>Mỗi server một tab riêng.</p>
                    </div>
                    <div>
                      <span>
                        <FolderOpen size={20} />
                      </span>
                      <strong>Files qua SFTP</strong>
                      <p>Hai khung local và remote.</p>
                    </div>
                    <div>
                      <span>
                        <KeyRound size={20} />
                      </span>
                      <strong>Key được bảo vệ</strong>
                      <p>Mã hóa ngay trên máy bạn.</p>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="section-heading">
                    <span>
                      {filtered.length} server
                      {group === "all" ? " trong workspace" : ""}
                    </span>
                    <span>Nhấp Kết nối để mở phiên mới</span>
                  </div>
                  <div className="server-grid">
                    {filtered.map((host) => {
                      const count = sessions.filter(
                        (s) =>
                          s.host.id === host.id && s.status === "connected",
                      ).length;
                      return (
                        <article className="server-card" key={host.id}>
                          <div className="server-card-top">
                            <span className="server-icon">
                              <Server size={23} />
                            </span>
                            <span className="tag">{host.group}</span>
                            <IconButton
                              title="Sửa server"
                              icon={Pencil}
                              onClick={() => setModal({ type: "host", host })}
                            />
                            <IconButton
                              title="Xóa server"
                              icon={Trash2}
                              onClick={() => onDeleteHost(host)}
                            />
                          </div>
                          <h3>{host.name}</h3>
                          <p className="mono">
                            {host.host}
                            <span>:{host.port}</span>
                          </p>
                          <div className="server-meta">
                            <span>
                              <Monitor size={14} />
                              {host.username}
                            </span>
                            <span>
                              {host.auth === "key" ? (
                                <KeyRound size={14} />
                              ) : (
                                <LockKeyhole size={14} />
                              )}{" "}
                              {authLabels[host.auth] || "Password"}
                              {host.jumpHostId && " · Jump"}
                              {host.proxy?.kind &&
                                host.proxy.kind !== "none" &&
                                ` · ${host.proxy.kind.toUpperCase()}`}
                            </span>
                          </div>
                          <div className="server-card-bottom">
                            <span className={count ? "online" : "muted"}>
                              {count ? (
                                <>
                                  <i className="status-dot connected" />
                                  {count} phiên hoạt động
                                </>
                              ) : (
                                "Sẵn sàng kết nối"
                              )}
                            </span>
                            <Button
                              icon={Terminal}
                              onClick={() => connectHost(host)}
                            >
                              Kết nối
                            </Button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {!filtered.length && (
                    <div className="empty-inline">
                      Không tìm thấy server phù hợp.
                    </div>
                  )}
                </>
              )}
            </section>
          )}
          {page === "keys" && (
            <section className="page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">MỘT KEY, NHIỀU KẾT NỐI</div>
                  <h1>
                    SSH Keys <span>{data.keys.length}</span>
                  </h1>
                  <p>Thư viện key dùng chung cho các server trong workspace.</p>
                </div>
                <div className="actions">
                  <Button
                    icon={ArchiveRestore}
                    onClick={() => setModal({ type: "restore" })}
                  >
                    Khôi phục
                  </Button>
                  <Button
                    icon={DatabaseBackup}
                    onClick={() => setModal({ type: "backup" })}
                  >
                    Sao lưu
                  </Button>
                  <Button
                    icon={Upload}
                    onClick={() => setModal({ type: "key", mode: "import" })}
                  >
                    Nhập key
                  </Button>
                  <Button
                    icon={Plus}
                    variant="primary"
                    onClick={() => setModal({ type: "key", mode: "generate" })}
                  >
                    Tạo key mới
                  </Button>
                </div>
              </div>
              <div className="security-banner">
                <ShieldCheck size={22} />
                <div>
                  <strong>Private key được mã hóa trên máy</strong>
                  <p>
                    Khóa bảo vệ nằm trong Windows Credential Manager. Chỉ public
                    key được hiển thị; private key chỉ rời vault khi bạn chủ
                    động xuất hoặc sao lưu (có mật khẩu).
                  </p>
                </div>
              </div>
              {data.keys.length ? (
                <div className="key-list">
                  {data.keys.map((key) => (
                    <article className="key-card" key={key.id}>
                      <div className="key-icon">
                        <KeyRound size={24} />
                      </div>
                      <div className="key-detail">
                        <h3>
                          {key.name}
                          <span className="tag">{key.algorithm}</span>
                        </h3>
                        <p className="mono">{key.fingerprint}</p>
                        <small>
                          {data.hosts.filter((h) => h.keyId === key.id).length}{" "}
                          server sử dụng
                        </small>
                      </div>
                      <Button
                        icon={Copy}
                        onClick={() =>
                          run(async () => {
                            await navigator.clipboard.writeText(
                              key.publicKey + " " + key.name,
                            );
                            notify("Đã sao chép public key.");
                          })
                        }
                      >
                        Public key
                      </Button>
                      <IconButton
                        icon={FileKey}
                        title="Xuất private key"
                        onClick={() => setModal({ type: "export", key })}
                      />
                      <IconButton
                        icon={Trash2}
                        title="Xóa key"
                        onClick={() =>
                          run(async () => {
                            if (
                              await confirm(
                                `Xóa key “${key.name}” khỏi thư viện?`,
                                { kind: "warning", title: "Xóa SSH key" },
                              )
                            )
                              setData(await call("delete_key", { id: key.id }));
                          })
                        }
                      />
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <KeyRound size={44} />
                  <h2>Chìa khóa cho những kết nối của bạn</h2>
                  <p>
                    Nhập private key OpenSSH / PEM / PuTTY .ppk đang dùng hoặc
                    tạo key Ed25519 mới.
                  </p>
                  <Button
                    icon={Upload}
                    onClick={() => setModal({ type: "key", mode: "import" })}
                  >
                    Nhập SSH key
                  </Button>
                </div>
              )}
            </section>
          )}
          {page === "known" && (
            <section className="page">
              <div className="page-heading">
                <div>
                  <div className="eyebrow">DANH TÍNH SERVER</div>
                  <h1>Known Hosts</h1>
                  <p>
                    Fingerprint đã xác nhận. Kết nối sẽ bị chặn nếu host key
                    thay đổi.
                  </p>
                </div>
                <ShieldCheck size={36} className="mint" />
              </div>
              {Object.entries(data.knownHosts).length ? (
                Object.entries(data.knownHosts).map(([address, fp]) => (
                  <article className="key-card" key={address}>
                    <ShieldCheck className="mint" size={24} />
                    <div className="key-detail">
                      <h3>{address}</h3>
                      <p className="mono">{fp}</p>
                    </div>
                    <Button
                      icon={Trash2}
                      onClick={() =>
                        run(async () => {
                          if (
                            await confirm(
                              `Quên fingerprint của ${address}? Chỉ thực hiện sau khi xác minh thay đổi với quản trị viên.`,
                              { kind: "warning", title: "Quên host key" },
                            )
                          )
                            setData(await call("forget_host", { address }));
                        })
                      }
                    >
                      Quên host
                    </Button>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <ShieldCheck size={44} />
                  <h2>Chưa có server được tin cậy</h2>
                  <p>
                    Fingerprint xuất hiện ở đây sau khi bạn xác nhận kết nối đầu
                    tiên.
                  </p>
                </div>
              )}
            </section>
          )}
          {page === "settings" && (
            <SettingsPage
              settings={settings}
              save={saveSettings}
              trayReady={trayReady || !desktop}
              openHelp={() => setModal({ type: "help" })}
            />
          )}
          {sessions.map((session) => (
            <SessionPane
              key={session.id}
              session={session}
              visible={page === "session" && active === session.id}
              home={data.home}
              notify={notify}
              transfers={transfers}
              showQueue={() => setShowTransfers(true)}
              reconnect={() => connectHost(session.host, session.id)}
              forwards={forwards}
              settings={settings}
              savedHost={data.hosts.find((h) => h.id === session.host.id)}
              saveForwards={async (list) => {
                const host = data.hosts.find((h) => h.id === session.host.id);
                if (!host) throw "Server đã bị xóa khỏi danh sách.";
                setData(
                  await call("save_host", {
                    host: { ...host, forwards: list },
                  }),
                );
              }}
              setView={(view) =>
                setSessions((old) =>
                  old.map((s) => (s.id === session.id ? { ...s, view } : s)),
                )
              }
            />
          ))}
        </div>
        {showTransfers && (
          <TransferPanel
            transfers={transfers}
            close={() => setShowTransfers(false)}
            clear={() =>
              setTransfers((old) =>
                old.filter((t) => ["running", "queued"].includes(t.status)),
              )
            }
            cancel={(t) => run(() => call("cancel_transfer", { id: t.id }))}
            retry={(t) => {
              if (
                !sessions.some(
                  (s) => s.id === t.sessionId && s.status === "connected",
                )
              )
                return notify("Phiên của tác vụ này chưa kết nối lại.", true);
              run(() => call("transfer", { request: retryRequest(t) }));
            }}
          />
        )}
        <footer className="statusbar">
          <span>
            <img src={statusbarIcon} width="16" height="16" alt="" /> SSH / SFTP
            · Mã hóa đầu cuối
          </span>
          <button onClick={() => setShowTransfers(!showTransfers)}>
            <Upload size={13} />
            <Download size={13} />
            Truyền file{pending > 0 && <b>{pending}</b>}
            <ChevronDown size={13} className={!showTransfers ? "rotate" : ""} />
          </button>
          <span className="statusbar-tools">
            <button
              title="Nhật ký hoạt động (Ctrl+Shift+L)"
              onClick={() => setModal({ type: "activity" })}
            >
              <ScrollText size={13} />
              Hoạt động
              {activityErrors > 0 && <b className="error">{activityErrors}</b>}
            </button>
            <button
              title="Phím tắt và trợ giúp (F1)"
              onClick={() => setModal({ type: "help" })}
            >
              <CircleHelp size={13} />
              Trợ giúp
            </button>
            <button
              className="statusbar-version"
              title="Giới thiệu SSH Studio"
              onClick={() => setModal({ type: "help", tab: "about" })}
            >
              v{APP_VERSION}
            </button>
          </span>
        </footer>
      </main>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <Unplug size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <IconButton
            icon={X}
            title="Đóng thông báo"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {modal?.type === "host" && (
        <HostModal
          host={modal.host}
          hosts={data.hosts}
          keys={data.keys}
          workspaces={view.workspaces}
          workspaceId={view.active.id}
          close={() => setModal(null)}
          save={(host) =>
            run(async () => {
              setData(await call("save_host", { host }));
              setModal(null);
              notify("Đã lưu server.");
            })
          }
        />
      )}
      {prompts.length > 0 && verification.length === 0 && (
        <AuthPromptModal
          prompt={prompts[0]}
          label={(() => {
            const host = sessions.find(
              (s) => s.id === prompts[0].sessionId,
            )?.host;
            return host
              ? `Phiên ${host.name} · ${host.username}@${host.host}:${host.port}`
              : "";
          })()}
          respond={(answers, remember = false) =>
            run(async () => {
              const id = prompts[0].id;
              setPrompts((old) => old.filter((item) => item.id !== id));
              await call("auth_respond", { id, answers, remember });
            })
          }
        />
      )}
      {modal?.type === "workspace" && (
        <WorkspaceModal
          workspace={modal.workspace}
          view={view}
          close={() => setModal(null)}
          save={async (workspace) => {
            setData(await call("save_workspace", { workspace }));
            setModal(null);
            setPage("hosts");
            notify(
              workspace.id
                ? "Đã lưu workspace."
                : `Đã tạo và chuyển sang workspace “${workspace.name.trim()}”.`,
            );
          }}
          remove={async (workspace, moveTo) => {
            if (
              !(await confirm(`Xóa workspace “${workspace.name}”?`, {
                title: "Xóa workspace",
                kind: "warning",
              }))
            )
              return;
            setData(
              await call("delete_workspace", { id: workspace.id, moveTo }),
            );
            setModal(null);
            notify("Đã xóa workspace.");
          }}
        />
      )}
      {modal?.type === "help" && (
        <HelpModal tab={modal.tab} close={() => setModal(null)} />
      )}
      {modal?.type === "activity" && (
        <ActivityModal close={() => setModal(null)} confirm={confirm} />
      )}
      {modal?.type === "key" && (
        <KeyModal
          mode={modal.mode}
          close={() => setModal(null)}
          save={async (args) => {
            const result = await call(
              modal.mode === "generate" ? "generate_key" : "import_key",
              args,
            );
            setData(result);
            setModal(null);
            notify("SSH key đã được lưu vào thư viện.");
          }}
        />
      )}
      {modal?.type === "export" && (
        <ExportKeyModal
          keyItem={modal.key}
          close={() => setModal(null)}
          done={(path) => {
            setModal(null);
            notify(`Đã xuất private key ra ${path}.`);
          }}
        />
      )}
      {modal?.type === "backup" && (
        <BackupModal
          close={() => setModal(null)}
          done={(counts, path) => {
            setModal(null);
            notify(
              `Đã sao lưu ${counts.hosts} server, ${counts.keys} key, ${counts.knownHosts} known host vào ${path}.`,
            );
          }}
        />
      )}
      {modal?.type === "restore" && (
        <RestoreModal
          close={() => setModal(null)}
          done={(result) => {
            setData(result.snapshot);
            setModal(null);
            notify(`Đã khôi phục: ${restoreSummary(result.report)}.`);
          }}
        />
      )}
      {verification.length > 0 && (
        <Modal
          title="Xác nhận danh tính server"
          subtitle="Kết nối lần đầu · kiểm tra fingerprint trước khi tiếp tục"
          close={() =>
            run(async () => {
              await call("verify_host", {
                id: verification[0].id,
                accepted: false,
              });
              setVerification((old) =>
                old.filter((item) => item.id !== verification[0].id),
              );
            })
          }
        >
          <div className="verification">
            <ShieldCheck size={36} />
            <h3>{verification[0].address}</h3>
            <code>{verification[0].fingerprint}</code>
            <p>
              Đối chiếu fingerprint này với quản trị viên hoặc console của
              server. Chỉ tin cậy khi thông tin trùng khớp.
            </p>
          </div>
          <div className="modal-footer">
            <Button
              onClick={() =>
                run(async () => {
                  await call("verify_host", {
                    id: verification[0].id,
                    accepted: false,
                  });
                  setVerification((old) =>
                    old.filter((item) => item.id !== verification[0].id),
                  );
                })
              }
            >
              Hủy kết nối
            </Button>
            <Button
              variant="primary"
              icon={ShieldCheck}
              onClick={() =>
                run(async () => {
                  await call("verify_host", {
                    id: verification[0].id,
                    accepted: true,
                  });
                  setVerification((old) =>
                    old.filter((item) => item.id !== verification[0].id),
                  );
                })
              }
            >
              Tin cậy và kết nối
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
