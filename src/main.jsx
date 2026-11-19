import React, { useState, useEffect, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, confirm } from "@tauri-apps/plugin-dialog";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import appIcon from "../assets/logo.svg";
import statusbarIcon from "../assets/statusbar.svg";
import {
  Terminal,
  Server,
  KeyRound,
  Plus,
  Search,
  Folder,
  FolderOpen,
  File,
  ArrowUp,
  ArrowDown,
  Upload,
  Download,
  X,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy,
  ShieldCheck,
  RefreshCw,
  Monitor,
  Network,
  Check,
  LoaderCircle,
  Unplug,
  LayoutGrid,
  ArrowLeft,
  FolderPlus,
  HardDrive,
  LockKeyhole,
  ExternalLink,
} from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const desktop = !!window.__TAURI_INTERNALS__;
const call = (name, args = {}) =>
  desktop
    ? invoke(name, args)
    : Promise.reject("Chạy bằng npm start để sử dụng backend Tauri.");
const uid = () => crypto.randomUUID();
const cleanError = (e) => String(e).replace(/^Error: /, "");
const size = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;
const statuses = {
  connecting: "Đang kết nối",
  connected: "Đã kết nối",
  closed: "Đã ngắt",
  error: "Lỗi kết nối",
  queued: "Đang chờ",
  running: "Đang truyền",
  completed: "Hoàn tất",
  failed: "Thất bại",
  cancelled: "Đã hủy",
};
function Button({ icon: Icon, children, variant = "", ...props }) {
  return (
    <button className={`button ${variant}`} {...props}>
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
function IconButton({ icon: Icon, title, ...props }) {
  return (
    <button className="icon-button" title={title} aria-label={title} {...props}>
      <Icon size={17} />
    </button>
  );
}
function Modal({ title, subtitle, children, close, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    const prior = document.activeElement;
    ref.current?.focus();
    const handler = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const list = ref.current?.querySelectorAll(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        );
        if (!list?.length) return;
        if (e.shiftKey && document.activeElement === list[0]) {
          e.preventDefault();
          list[list.length - 1].focus();
        } else if (
          !e.shiftKey &&
          document.activeElement === list[list.length - 1]
        ) {
          e.preventDefault();
          list[0].focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      prior?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <IconButton icon={X} title="Đóng" onClick={close} />
        </div>
        {children}
      </section>
    </div>
  );
}
function Field({ label, children, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children || <input {...props} />}
    </label>
  );
}

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
  const [ready, setReady] = useState(false);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;
  const notify = useCallback(
    (message, error = false) =>
      setToast({ message: cleanError(message), error }),
    [],
  );
  const run = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      notify(e, true);
    }
  };
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
      register("session", (payload) =>
        setSessions((old) =>
          old.map((s) => (s.id === payload.id ? { ...s, ...payload } : s)),
        ),
      ),
      register("host-verification", (payload) =>
        setVerification((old) => [...old, payload]),
      ),
      register("host-verification-finished", (payload) =>
        setVerification((old) => old.filter((item) => item.id !== payload.id)),
      ),
      register("transfer", (payload) =>
        setTransfers((old) => {
          const index = old.findIndex((t) => t.id === payload.id);
          return index < 0
            ? [payload, ...old]
            : old.map((t) => (t.id === payload.id ? payload : t));
        }),
      ),
    ])
      .then(() => {
        if (!disposed) setReady(true);
      })
      .catch((e) => notify(e, true));
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (
          sessionsRef.current.some((s) =>
            ["connected", "connecting"].includes(s.status),
          ) ||
          transfersRef.current.some((t) =>
            ["queued", "running"].includes(t.status),
          )
        ) {
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
    return () => {
      disposed = true;
      removers.forEach((off) => off());
    };
  }, []);
  const connected = sessions.filter((s) => s.status === "connected").length;
  const current = sessions.find((s) => s.id === active);
  const selectSession = (id) => {
    setActive(id);
    setPage("session");
  };
  const begin = async (host, password = "") => {
    const id = uid();
    setSessions((old) => [
      ...old,
      { id, host, status: "connecting", view: "terminal" },
    ]);
    setActive(id);
    setPage("session");
    setModal(null);
    try {
      await call("connect", { id, hostId: host.id, password });
      setData(await call("snapshot"));
    } catch (e) {
      setSessions((old) =>
        old.map((s) =>
          s.id === id ? { ...s, status: "error", error: cleanError(e) } : s,
        ),
      );
      notify(e, true);
    }
  };
  const connectHost = (host) => {
    if (!ready) return notify("Backend chưa sẵn sàng.", true);
    if (host.auth === "password") setModal({ type: "password", host });
    else begin(host);
  };
  const closeSession = async (id) => {
    const item = sessions.find((s) => s.id === id);
    if (item?.status === "connecting")
      return notify("Chờ kết nối hoàn tất hoặc từ chối xác nhận fingerprint.");
    if (
      item?.status === "connected" &&
      !(await confirm(
        "Đóng phiên terminal này? Các lệnh đang chạy có thể dừng.",
        { title: "Ngắt kết nối", kind: "warning" },
      ))
    )
      return;
    await run(async () => {
      await call("disconnect", { id });
      setSessions((old) => old.filter((s) => s.id !== id));
      if (active === id) {
        const next = sessions.find((s) => s.id !== id);
        if (next) setActive(next.id);
        else setPage("hosts");
      }
    });
  };
  const filtered = data.hosts.filter(
    (h) =>
      (group === "all" || h.group === group) &&
      `${h.name} ${h.host} ${h.username}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = [...new Set(data.hosts.map((h) => h.group))];
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
        <div className="workspace-label">
          <span className="avatar">P</span>
          <div>
            Personal workspace<small>Lưu trên máy của bạn</small>
          </div>
          <LockKeyhole size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${page === "hosts" ? "active" : ""}`}
          onClick={() => {
            setPage("hosts");
            setGroup("all");
          }}
        >
          <Server size={18} />
          Servers<span className="count">{data.hosts.length}</span>
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
                {data.hosts.filter((h) => h.group === g).length}
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
            Local-first. Riêng tư.<small>Rust + Tauri · v0.1.0</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {page === "hosts"
                ? "Servers"
                : page === "keys"
                  ? "SSH Keys"
                  : page === "known"
                    ? "Known Hosts"
                    : current?.host.name || "Terminal"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="connection-count">
              <i className={`status-dot ${connected ? "connected" : ""}`} />
              {connected} kết nối
            </span>
            <span className="os-label">
              <Monitor size={14} /> Windows
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
                      {group === "all" ? data.hosts.length : filtered.length}
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
              <div className="toolbar">
                <div className="search-box">
                  <Search size={18} />
                  <input
                    aria-label="Tìm server"
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
              {data.hosts.length === 0 ? (
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
                              {host.auth === "key" ? "SSH key" : "Password"}
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
                    key được hiển thị và sao chép.
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
                    Nhập private key OpenSSH / PEM đang dùng hoặc tạo key
                    Ed25519 mới.
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
          {sessions.map((session) => (
            <SessionPane
              key={session.id}
              session={session}
              visible={page === "session" && active === session.id}
              home={data.home}
              notify={notify}
              transfers={transfers}
              showQueue={() => setShowTransfers(true)}
              reconnect={() => connectHost(session.host)}
              setView={(view) =>
                setSessions((old) =>
                  old.map((s) => (s.id === session.id ? { ...s, view } : s)),
                )
              }
            />
          ))}
        </div>
        {showTransfers && (
          <section className="transfer-panel">
            <div className="transfer-heading">
              <strong>
                <ArrowUp size={15} />
                <ArrowDown size={15} />
                Truyền file <span>{pending} đang chờ / đang truyền</span>
              </strong>
              <div className="actions">
                <button
                  className="text-button"
                  onClick={() =>
                    setTransfers((old) =>
                      old.filter((t) =>
                        ["running", "queued"].includes(t.status),
                      ),
                    )
                  }
                >
                  Dọn lịch sử
                </button>
                <IconButton
                  title="Thu gọn"
                  icon={ChevronDown}
                  onClick={() => setShowTransfers(false)}
                />
              </div>
            </div>
            <div className="transfer-list">
              {transfers.length ? (
                transfers.map((t) => (
                  <div className="transfer-row" key={t.id}>
                    {t.direction === "upload" ? (
                      <Upload size={17} />
                    ) : (
                      <Download size={17} />
                    )}
                    <div className="transfer-name">
                      <strong>{t.name}</strong>
                      <small>
                        {t.error || `${size(t.bytes)} / ${size(t.total)}`}
                      </small>
                    </div>
                    <div className="progress">
                      <div
                        style={{
                          width: `${t.total ? Math.min(100, (t.bytes / t.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className={`transfer-status ${t.status}`}>
                      {statuses[t.status]}
                    </span>
                    {["running", "queued"].includes(t.status) ? (
                      <IconButton
                        icon={X}
                        title="Hủy truyền"
                        onClick={() =>
                          run(() => call("cancel_transfer", { id: t.id }))
                        }
                      />
                    ) : (
                      <span className="icon-placeholder" />
                    )}
                  </div>
                ))
              ) : (
                <div className="empty-inline">
                  Chưa có file nào được truyền trong phiên làm việc này.
                </div>
              )}
            </div>
          </section>
        )}
        <footer className="statusbar">
          <span>
            <img src={statusbarIcon} width="16" height="16" alt="" /> SSH / SFTP · Mã hóa đầu cuối
          </span>
          <button onClick={() => setShowTransfers(!showTransfers)}>
            <Upload size={13} />
            <Download size={13} />
            Truyền file{pending > 0 && <b>{pending}</b>}
            <ChevronDown size={13} className={!showTransfers ? "rotate" : ""} />
          </button>
          <span>Rust + Tauri</span>
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
          keys={data.keys}
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
      {modal?.type === "password" && (
        <PasswordModal
          host={modal.host}
          close={() => setModal(null)}
          connect={(password) => begin(modal.host, password)}
        />
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
              setVerification((old) => old.filter((item) => item.id !== verification[0].id));
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
                  setVerification((old) => old.filter((item) => item.id !== verification[0].id));
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
                  setVerification((old) => old.filter((item) => item.id !== verification[0].id));
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

function HostModal({ host, keys, close, save }) {
  const [form, setForm] = useState(
    host || {
      id: uid(),
      name: "",
      host: "",
      port: 22,
      username: "root",
      group: "Servers",
      auth: "password",
      keyId: "",
    },
  );
  const [busy, setBusy] = useState(false);
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <Modal
      title={host ? "Chỉnh sửa server" : "Thêm server"}
      subtitle="Lưu cấu hình và kết nối bất cứ khi nào bạn cần."
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await save({
            ...form,
            port: Number(form.port),
            group: form.group.trim() || "Servers",
          });
          setBusy(false);
        }}
      >
        <div className="form-body">
          <Field
            label="Tên hiển thị"
            placeholder="Ví dụ: Production API"
            required
            autoFocus
            {...field("name")}
          />
          <div className="form-row address-row">
            <Field
              label="Địa chỉ server"
              placeholder="192.168.1.10 hoặc server.example.com"
              required
              {...field("host")}
            />
            <Field
              label="Port"
              type="number"
              min="1"
              max="65535"
              required
              {...field("port")}
            />
          </div>
          <div className="form-row">
            <Field label="Username" required {...field("username")} />
            <Field
              label="Nhóm"
              placeholder="Production, Staging…"
              {...field("group")}
            />
          </div>
          <Field label="Phương thức xác thực">
            <div className="segmented">
              <button
                type="button"
                className={form.auth === "password" ? "selected" : ""}
                onClick={() => setForm({ ...form, auth: "password" })}
              >
                <LockKeyhole size={16} />
                Password
              </button>
              <button
                type="button"
                className={form.auth === "key" ? "selected" : ""}
                onClick={() => setForm({ ...form, auth: "key" })}
              >
                <KeyRound size={16} />
                SSH Key
              </button>
            </div>
          </Field>
          {form.auth === "key" ? (
            <Field label="SSH key">
              <select required {...field("keyId")}>
                <option value="">Chọn key từ thư viện</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.algorithm}
                  </option>
                ))}
              </select>
              {!keys.length && (
                <small>
                  Đóng hộp thoại và vào SSH Keys để nhập hoặc tạo key trước.
                </small>
              )}
            </Field>
          ) : (
            <p className="form-note">
              <LockKeyhole size={16} />
              Password được hỏi khi kết nối và không lưu xuống ổ đĩa.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={busy ? LoaderCircle : Check}
            disabled={busy}
          >
            Lưu server
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function PasswordModal({ host, close, connect }) {
  const [password, setPassword] = useState("");
  return (
    <Modal
      title={`Kết nối ${host.name}`}
      subtitle={`${host.username}@${host.host}:${host.port}`}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          connect(password);
          setPassword("");
        }}
      >
        <div className="form-body">
          <Field
            autoFocus
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          <p className="form-note">
            Password chỉ được dùng cho phiên kết nối này.
          </p>
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary" icon={Terminal}>
            Kết nối
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function KeyModal({ mode, close, save }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={mode === "generate" ? "Tạo SSH key" : "Nhập SSH key"}
      subtitle={
        mode === "generate"
          ? "Tạo key Ed25519 và bảo vệ bằng kho mã hóa của hệ điều hành."
          : "Hỗ trợ OpenSSH / PEM. Với .ppk, xuất OpenSSH bằng PuTTYgen."
      }
      close={busy ? () => {} : close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await save({ name, path, passphrase });
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          <Field
            label="Tên key"
            placeholder="Ví dụ: Work laptop"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {mode === "import" && (
            <>
              <Field label="Private key">
                <Button
                  type="button"
                  icon={FolderOpen}
                  onClick={async () => {
                    try {
                      const p = await open({
                        multiple: false,
                        directory: false,
                        title: "Chọn private key OpenSSH / PEM",
                      });
                      if (p) setPath(p);
                    } catch (e) {
                      setError(cleanError(e));
                    }
                  }}
                >
                  {path || "Chọn file private key"}
                </Button>
              </Field>
              <Field
                label="Passphrase (nếu có)"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
              />
            </>
          )}
          <p className="form-note">
            <ShieldCheck size={18} />
            Private key sẽ được mã hóa bằng AES-256-GCM, khóa bảo vệ lưu trong
            Windows Credential Manager.
          </p>
          {error && <div className="inline-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <Button type="button" disabled={busy} onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={busy ? LoaderCircle : KeyRound}
            disabled={busy || (mode === "import" && !path)}
          >
            {busy ? "Đang lưu…" : mode === "generate" ? "Tạo key" : "Nhập key"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SessionPane({
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
function TerminalView({ id, visible, status }) {
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

function FileManager({ session, home, notify, transfers, showQueue }) {
  const [local, setLocal] = useState({ path: home, parent: home, files: [] });
  const [remote, setRemote] = useState({ path: ".", parent: ".", files: [] });
  const [selected, setSelected] = useState({ local: null, remote: null });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [dialog, setDialog] = useState(null);
  const paths = useRef({ local: home, remote: "." });
  const revisions = useRef({ local: 0, remote: 0 });
  const load = useCallback(
    async (side, directory) => {
      const version = ++revisions.current[side];
      setLoading((old) => ({ ...old, [side]: true }));
      try {
        const result = await call("list_files", {
          sessionId: side === "remote" ? session.id : null,
          directory,
        });
        if (version !== revisions.current[side]) return;
        (side === "local" ? setLocal : setRemote)(result);
        paths.current[side] = result.path;
        setSelected((old) => ({ ...old, [side]: null }));
        setErrors((old) => ({ ...old, [side]: "" }));
      } catch (e) {
        if (version === revisions.current[side])
          setErrors((old) => ({ ...old, [side]: cleanError(e) }));
      } finally {
        if (version === revisions.current[side])
          setLoading((old) => ({ ...old, [side]: false }));
      }
    },
    [session.id],
  );
  useEffect(() => {
    load("local", home);
  }, [home]);
  useEffect(() => {
    if (session.status === "connected") load("remote", ".");
  }, [session.status]);
  const completed = transfers.filter(
    (t) => t.sessionId === session.id && t.status === "completed",
  ).length;
  useEffect(() => {
    if (completed) {
      load("local", paths.current.local);
      load("remote", paths.current.remote);
    }
  }, [completed]);
  const action = async (side, type, value) => {
    try {
      const entry = selected[side];
      await call("file_action", {
        sessionId: side === "remote" ? session.id : null,
        directory: paths.current[side],
        name: type === "mkdir" ? value : entry.name,
        newName: type === "rename" ? value : null,
        action: type,
        isDirectory: entry?.directory || false,
      });
      setDialog(null);
      await load(side, paths.current[side]);
    } catch (e) {
      notify(e, true);
    }
  };
  const transfer = async (side) => {
    const entry = selected[side];
    if (!entry || entry.directory || entry.link)
      return notify(
        "Chọn một file thường để truyền. Với thư mục, hãy nén trước.",
        true,
      );
    try {
      await call("transfer", {
        request: {
          id: uid(),
          sessionId: session.id,
          direction: side === "local" ? "upload" : "download",
          localDirectory: local.path,
          remoteDirectory: remote.path,
          name: entry.name,
        },
      });
      showQueue();
    } catch (e) {
      notify(e, true);
    }
  };
  return (
    <div className="file-manager">
      <div className="file-hint">
        <FolderOpen size={14} />
        Hai khung local / remote
        <span>Nhấp đúp thư mục để mở · Chọn file để truyền</span>
      </div>
      <div className="file-panes">
        {["local", "remote"].map((side) => {
          const listing = side === "local" ? local : remote;
          const entry = selected[side];
          const disabled = side === "remote" && session.status !== "connected";
          return (
            <FilePane
              key={side}
              side={side}
              listing={listing}
              selected={entry}
              loading={loading[side]}
              error={errors[side]}
              disabled={disabled}
              load={(directory) => load(side, directory)}
              select={(entry) =>
                setSelected((old) => ({ ...old, [side]: entry }))
              }
              create={() =>
                setDialog({
                  side,
                  type: "mkdir",
                  title: "Tạo thư mục",
                  value: "",
                })
              }
              rename={() =>
                setDialog({
                  side,
                  type: "rename",
                  title: "Đổi tên",
                  value: entry.name,
                })
              }
              remove={async () => {
                if (
                  await confirm(
                    `Xóa “${entry.name}”? Thư mục phải rỗng. Không thể hoàn tác.`,
                    { title: "Xóa file", kind: "warning" },
                  )
                )
                  action(side, "delete");
              }}
              transfer={() => transfer(side)}
              canTransfer={session.status === "connected" && !errors.remote}
            />
          );
        })}
      </div>
      {dialog && (
        <NameModal
          {...dialog}
          close={() => setDialog(null)}
          save={(value) => action(dialog.side, dialog.type, value)}
        />
      )}
    </div>
  );
}
function FilePane({
  side,
  listing,
  selected,
  loading,
  error,
  disabled,
  load,
  select,
  create,
  rename,
  remove,
  transfer,
  canTransfer,
}) {
  const [address, setAddress] = useState(listing.path);
  useEffect(() => setAddress(listing.path), [listing.path]);
  const join = (name) =>
    side === "remote"
      ? listing.path.replace(/\/$/, "") + "/" + name
      : listing.path.replace(/[\\/]$/, "") + "\\" + name;
  return (
    <section className="file-pane">
      <div className="file-pane-title">
        <span>
          {side === "local" ? <Monitor size={17} /> : <Server size={17} />}{" "}
          {side === "local" ? "Máy của bạn" : "Remote server"}
        </span>
        <Button
          disabled={
            !selected || selected.directory || selected.link || !canTransfer
          }
          icon={side === "local" ? Upload : Download}
          onClick={transfer}
        >
          {side === "local" ? "Upload" : "Download"}
        </Button>
      </div>
      <div className="pathbar">
        <IconButton
          icon={ArrowUp}
          title="Thư mục cha"
          disabled={disabled || loading}
          onClick={() => load(listing.parent)}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load(address);
          }}
        >
          <Folder size={14} />
          <input
            aria-label={
              side === "local" ? "Đường dẫn local" : "Đường dẫn remote"
            }
            value={address}
            disabled={disabled}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        {side === "local" && (
          <IconButton
            icon={FolderOpen}
            title="Chọn thư mục local"
            onClick={async () => {
              const directory = await open({
                directory: true,
                multiple: false,
              });
              if (directory) load(directory);
            }}
          />
        )}
        <IconButton
          icon={RefreshCw}
          title="Làm mới"
          disabled={disabled || loading}
          onClick={() => load(listing.path)}
        />
      </div>
      <div className="file-actions">
        <Button icon={FolderPlus} disabled={disabled} onClick={create}>
          Thư mục
        </Button>
        <IconButton
          icon={Pencil}
          title="Đổi tên"
          disabled={disabled || !selected}
          onClick={rename}
        />
        <IconButton
          icon={Trash2}
          title="Xóa"
          disabled={disabled || !selected}
          onClick={remove}
        />
        <span>{listing.files.length} mục</span>
      </div>
      <div className="file-table-wrap">
        {disabled ? (
          <div className="empty-inline">Kết nối server để duyệt file.</div>
        ) : loading ? (
          <div className="empty-inline">
            <LoaderCircle size={20} className="spin" />
            Đang tải thư mục…
          </div>
        ) : error ? (
          <div className="file-error">{error}</div>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th>Tên</th>
                <th>Kích thước</th>
                <th>Sửa đổi</th>
              </tr>
            </thead>
            <tbody>
              {listing.files.map((file) => (
                <tr
                  key={file.name}
                  tabIndex={0}
                  aria-selected={selected?.name === file.name}
                  className={selected?.name === file.name ? "selected" : ""}
                  onClick={() => select(file)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      select(file);
                      if (file.directory || file.link) load(join(file.name));
                    }
                  }}
                  onDoubleClick={() => {
                    if (file.directory || file.link) load(join(file.name));
                  }}
                >
                  <td>
                    {file.directory ? (
                      <Folder size={16} className="folder-icon" />
                    ) : file.link ? (
                      <ExternalLink size={16} />
                    ) : (
                      <File size={16} />
                    )}
                    <span>{file.name}</span>
                  </td>
                  <td>{file.directory ? "—" : size(file.size)}</td>
                  <td>
                    {file.modified
                      ? new Date(file.modified).toLocaleDateString("vi-VN")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!loading && !error && !disabled && !listing.files.length && (
          <div className="empty-inline">Thư mục trống</div>
        )}
      </div>
    </section>
  );
}
function NameModal({ title, value: initial, close, save }) {
  const [value, setValue] = useState(initial);
  return (
    <Modal
      title={title}
      subtitle="Nhập tên, không bao gồm đường dẫn."
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(value);
        }}
      >
        <div className="form-body">
          <Field
            label="Tên"
            autoFocus
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary">Lưu</Button>
        </div>
      </form>
    </Modal>
  );
}
createRoot(document.getElementById("root")).render(<App />);
