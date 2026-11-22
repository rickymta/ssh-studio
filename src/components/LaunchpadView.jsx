import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BellOff,
  Briefcase,
  Cable,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eraser,
  History,
  ListChecks,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Rocket,
  RotateCcw,
  Search,
  Server,
  Square,
  SquareArrowOutUpRight,
  Terminal,
  X,
} from "lucide-react";
import { WORKSPACE_COLORS, forwardLabel, size, statuses } from "../lib.js";
import {
  RECENT_GROUPS,
  TABS,
  agoLabel,
  dismissFailure,
  forgetHost,
  matches,
  recentGroup,
  rowText,
  togglePin,
} from "../launchpad.js";
import { confirm } from "./dialogs.jsx";
import { updatePrefs } from "./launchpadStore.js";
import { Dropdown, contextMenu } from "./menu.jsx";
import { Button, IconButton } from "./ui.jsx";

const viewLabels = {
  terminal: "Terminal",
  files: "Files",
  split: "Chia đôi",
  side: "Song song",
  ports: "Ports",
};

/** The time, updated every 30 s (ages). */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function WorkspaceBadge({ workspace, onClick }) {
  if (!workspace) return <span className="muted">—</span>;
  const color = WORKSPACE_COLORS[workspace.color] || WORKSPACE_COLORS.mint;
  return (
    <button
      type="button"
      className="ws-badge"
      title={`Mở workspace “${workspace.name}”`}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <i style={{ background: color }} />
      <span>{workspace.name}</span>
    </button>
  );
}

function HostName({ host, pinned, sub }) {
  return (
    <div className="lp-host">
      <strong>
        {host.name}
        {pinned && <Pin size={12} className="pin-mark" />}
      </strong>
      <small className="mono">{sub || `${host.username}@${host.host}:${host.port}`}</small>
    </div>
  );
}

/**
 * Launchpad: open sessions, recent servers, port forwards, transfers and what needs attention
 * across every workspace (or only the active one), with search and keyboard navigation.
 */
export function LaunchpadView({
  visible,
  prefs,
  rows,
  view,
  workspacesById,
  connect,
  openSession,
  closeSession,
  reconnect,
  editHost,
  showWorkspace,
  stopForward,
  cancelTransfer,
  retryTransfer,
  showQueue,
}) {
  const tab = prefs.tab;
  const setTab = (id) => updatePrefs((p) => ({ ...p, tab: id }));
  const scope = prefs.scope;
  const now = useNow();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [collapsed, setCollapsed] = useState(new Set());
  const searchRef = useRef();
  const listRef = useRef();
  const pinned = new Set(prefs.pinned);
  const ws = (id) => workspacesById.get(id);

  const filtered = useMemo(() => {
    const out = {};
    for (const [id] of TABS)
      out[id] = rows[id].filter((row) =>
        matches(query, ...rowText(id, row, view.workspaces)),
      );
    return out;
  }, [rows, query, view.workspaces]);

  /** Grouped tabs: [{key, label, color?, rows}]; others: one group without a heading. */
  const groups = useMemo(() => {
    const list = filtered[tab];
    if (tab === "recent") {
      const by = new Map();
      for (const r of list) {
        const g = recentGroup(r.entry?.at || 0, r.pinned, now);
        by.set(g, [...(by.get(g) || []), r]);
      }
      return RECENT_GROUPS.filter(([g]) => by.has(g)).map(([key, label]) => ({
        key,
        label,
        rows: by.get(key),
      }));
    }
    if (tab === "all") {
      const pins = list.filter((h) => pinned.has(h.id));
      const out = pins.length ? [{ key: "pinned", label: "Đã ghim", rows: pins }] : [];
      for (const w of view.workspaces) {
        const inWs = list.filter((h) => h.workspaceId === w.id && !pinned.has(h.id));
        if (inWs.length)
          out.push({
            key: `ws:${w.id}`,
            label: w.name,
            color: WORKSPACE_COLORS[w.color] || WORKSPACE_COLORS.mint,
            rows: inWs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
          });
      }
      return out;
    }
    return [{ key: "", label: "", rows: list }];
  }, [filtered, tab, now, view.workspaces, prefs.pinned]);

  const flat = groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows));
  const cur = Math.min(cursor, Math.max(0, flat.length - 1));
  useEffect(() => setCursor(0), [tab, query, scope]);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-row="${cur}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  /** Host behind a row of any tab (for pin / connect keys). */
  const hostOf = (row) =>
    tab === "all"
      ? row
      : row.host ||
        row.session?.host ||
        row.forward?.session.host ||
        row.transfer?.session?.host ||
        null;

  /** Enter: the main action of the row. */
  const primary = (row) => {
    if (!row) return;
    if (tab === "sessions") return openSession(row.id);
    if (tab === "forwards") return openSession(row.sessionId);
    if (tab === "transfers") return showQueue();
    if (tab === "attention") {
      if (row.kind === "session") return openSession(row.session.id);
      if (row.kind === "forward") return openSession(row.forward.sessionId);
      if (row.kind === "transfer") return showQueue();
    }
    const host = hostOf(row);
    if (host) connect(host);
  };

  const onKey = useRef();
  onKey.current = (e) => {
    if (!visible) return;
    const target = e.target;
    if (target?.closest?.("input, textarea, select, .xterm")) {
      if (e.key === "Escape" && target === searchRef.current) {
        if (query) setQuery("");
        else target.blur();
        e.preventDefault();
      } else if (target === searchRef.current && (e.key === "ArrowDown" || e.key === "Enter")) {
        target.blur();
        listRef.current?.focus();
        if (e.key === "Enter") primary(flat[cur]);
        e.preventDefault();
      }
      return;
    }
    if (
      document.querySelector(".modal-backdrop, .confirm-backdrop, .menu-layer") ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey
    )
      return;
    const row = flat[cur];
    const host = row && hostOf(row);
    const k = e.key;
    if (k === "j" || k === "ArrowDown") setCursor(Math.min(flat.length - 1, cur + 1));
    else if (k === "k" || k === "ArrowUp") setCursor(Math.max(0, cur - 1));
    else if (k === "Home") setCursor(0);
    else if (k === "End") setCursor(flat.length - 1);
    else if (k === "/") searchRef.current?.focus();
    else if (k === "Enter" && row) primary(row);
    else if (k === "c" && host) connect(host);
    else if (k === "p" && host) updatePrefs((p) => togglePin(p, host.id));
    else if (/^[1-6]$/.test(k)) setTab(TABS[Number(k) - 1][0]);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const handler = (e) => onKey.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (visible) listRef.current?.focus({ preventScroll: true });
  }, [visible]);

  const activeWs = view.active;
  const scopeMenu = [
    {
      label: "Mọi workspace",
      checked: scope === "all",
      icon: Briefcase,
      onSelect: () => updatePrefs((p) => ({ ...p, scope: "all" })),
    },
    {
      label: `Workspace “${activeWs.name}”`,
      checked: scope === "workspace",
      icon: Briefcase,
      onSelect: () => updatePrefs((p) => ({ ...p, scope: "workspace" })),
    },
  ];
  const historyCount = Object.keys(prefs.history).length;
  const moreMenu = [
    {
      label: "Xóa lịch sử kết nối…",
      icon: Eraser,
      disabled: !historyCount,
      onSelect: async () => {
        if (
          await confirm(
            `Xóa lịch sử kết nối của ${historyCount} server trên máy này? Server, ghim và cài đặt không bị ảnh hưởng.`,
            { title: "Xóa lịch sử kết nối", kind: "danger" },
          )
        )
          updatePrefs((p) => ({ ...p, history: {} }));
      },
    },
    {
      label: "Bỏ mọi ghim",
      icon: PinOff,
      disabled: !prefs.pinned.length,
      onSelect: () => updatePrefs((p) => ({ ...p, pinned: [] })),
    },
  ];

  const hostMenu = (host) => {
    const isPinned = pinned.has(host.id);
    return [
      { label: "Kết nối", icon: Terminal, onSelect: () => connect(host) },
      { label: "Sửa server…", icon: Pencil, onSelect: () => editHost(host) },
      {
        label: isPinned ? "Bỏ ghim" : "Ghim",
        icon: isPinned ? PinOff : Pin,
        onSelect: () => updatePrefs((p) => togglePin(p, host.id)),
      },
      {
        label: "Mở trong workspace",
        icon: Briefcase,
        onSelect: () => showWorkspace(host),
      },
      prefs.history[host.id]
        ? "sep"
        : null,
      prefs.history[host.id]
        ? {
            label: "Xóa khỏi lịch sử",
            icon: X,
            onSelect: () => updatePrefs((p) => forgetHost(p, host.id)),
          }
        : null,
    ];
  };

  const pinButton = (host) => {
    const isPinned = pinned.has(host.id);
    return (
      <IconButton
        icon={isPinned ? PinOff : Pin}
        title={isPinned ? "Bỏ ghim (P)" : "Ghim (P)"}
        onClick={(e) => {
          e.stopPropagation();
          updatePrefs((p) => togglePin(p, host.id));
        }}
      />
    );
  };

  /** One row's cells for the current tab. */
  const cells = (row) => {
    if (tab === "sessions") {
      const s = row;
      return (
        <>
          <span className="lp-status">
            <i className={`status-dot ${s.status}`} />
          </span>
          <HostName host={s.host} pinned={pinned.has(s.host.id)} />
          <WorkspaceBadge workspace={ws(s.host.workspaceId)} onClick={() => showWorkspace(s.host)} />
          <span className={s.status === "error" ? "danger-text ellipsis" : "muted"} title={s.error}>
            {s.status === "error" ? s.error || statuses.error : statuses[s.status] || s.status}
          </span>
          <span className="muted">{viewLabels[s.view] || ""}</span>
          <span className="lp-actions">
            {["error", "closed"].includes(s.status) && (
              <IconButton icon={RotateCcw} title="Kết nối lại" onClick={(e) => (e.stopPropagation(), reconnect(s))} />
            )}
            <IconButton icon={SquareArrowOutUpRight} title="Mở (Enter)" onClick={(e) => (e.stopPropagation(), openSession(s.id))} />
            <IconButton icon={X} title="Đóng phiên" onClick={(e) => (e.stopPropagation(), closeSession(s.id))} />
          </span>
        </>
      );
    }
    if (tab === "recent") {
      const { host, entry } = row;
      return (
        <>
          <span className="lp-status">
            <i className={`status-dot ${entry ? (entry.ok ? "connected" : "error") : ""}`} />
          </span>
          <HostName host={host} pinned={row.pinned} />
          <WorkspaceBadge workspace={ws(host.workspaceId)} onClick={() => showWorkspace(host)} />
          <span className={entry && !entry.ok ? "danger-text ellipsis" : "muted"} title={entry?.error}>
            {!entry ? "Chưa kết nối" : entry.ok ? "Thành công" : entry.error || "Thất bại"}
          </span>
          <span className="muted" title={entry ? new Date(entry.at).toLocaleString("vi-VN") : ""}>
            {entry ? agoLabel(entry.at, now) : ""}
            {entry?.count > 1 && ` · ${entry.count} lần`}
          </span>
          <span className="lp-actions">
            {pinButton(host)}
            <Button icon={Terminal} className="button compact connect" onClick={(e) => (e.stopPropagation(), connect(host))}>
              Kết nối
            </Button>
          </span>
        </>
      );
    }
    if (tab === "forwards") {
      const f = row;
      return (
        <>
          <span className="lp-status">
            <i className={`status-dot ${f.status === "running" ? "connected" : "error"}`} />
          </span>
          <div className="lp-host">
            <strong className="mono">{forwardLabel(f.spec, f.boundPort)}</strong>
            <small>{f.spec?.kind === "remote" ? "Remote (-R)" : f.spec?.kind === "dynamic" ? "Dynamic SOCKS5 (-D)" : "Local (-L)"}</small>
          </div>
          <HostName host={f.session.host} sub={`${f.session.host.username}@${f.session.host.host}`} />
          <span className={f.status === "error" || f.error ? "danger-text ellipsis" : "muted"} title={f.error || ""}>
            {f.status === "error" ? f.error || "Lỗi" : `${f.active || 0} kết nối · ${f.total || 0} tổng`}
          </span>
          <span />
          <span className="lp-actions">
            <IconButton icon={SquareArrowOutUpRight} title="Tới phiên" onClick={(e) => (e.stopPropagation(), openSession(f.sessionId))} />
            {f.status === "running" && (
              <IconButton icon={Square} title="Dừng forward" onClick={(e) => (e.stopPropagation(), stopForward(f))} />
            )}
          </span>
        </>
      );
    }
    if (tab === "transfers") {
      const t = row;
      const upload = t.direction === "upload";
      const pct = t.total ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : 0;
      return (
        <>
          <span className="lp-status">
            {upload ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}
          </span>
          <div className="lp-host">
            <strong>{t.name}</strong>
            <small className="mono">{upload ? t.remoteDirectory : t.localDirectory}</small>
          </div>
          <span className="muted">{t.session?.host.name || "Phiên đã đóng"}</span>
          {t.status === "failed" ? (
            <span className="danger-text ellipsis" title={t.error}>{t.error || statuses.failed}</span>
          ) : (
            <div className="lp-progress">
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
              <small>{statuses[t.status]}{t.total ? ` · ${size(t.bytes || 0)} / ${size(t.total)}` : ""}</small>
            </div>
          )}
          <span />
          <span className="lp-actions">
            {t.status === "failed" ? (
              <IconButton icon={RotateCcw} title="Thử lại" onClick={(e) => (e.stopPropagation(), retryTransfer(t))} />
            ) : (
              <IconButton icon={X} title="Hủy" onClick={(e) => (e.stopPropagation(), cancelTransfer(t))} />
            )}
          </span>
        </>
      );
    }
    if (tab === "attention") {
      const host = hostOf(row);
      const label = {
        session: "Phiên bị ngắt",
        forward: "Port forward lỗi",
        transfer: "Truyền file thất bại",
        host: "Lần kết nối trước thất bại",
      }[row.kind];
      const message =
        row.kind === "session"
          ? row.session.error || statuses[row.session.status]
          : row.kind === "forward"
            ? row.forward.error
            : row.kind === "transfer"
              ? `${row.transfer.name}: ${row.transfer.error || ""}`
              : row.entry.error;
      return (
        <>
          <span className="lp-status">
            <AlertTriangle size={15} className="danger-text" />
          </span>
          {host ? <HostName host={host} pinned={pinned.has(host.id)} /> : <span className="muted">—</span>}
          <span className="lp-kind">{label}</span>
          <span className="danger-text ellipsis" title={message}>{message}</span>
          <span className="muted">
            {row.kind === "host" ? agoLabel(row.entry.at, now) : ""}
          </span>
          <span className="lp-actions">
            {row.kind === "session" && (
              <>
                <IconButton icon={RotateCcw} title="Kết nối lại" onClick={(e) => (e.stopPropagation(), reconnect(row.session))} />
                <IconButton icon={X} title="Đóng phiên" onClick={(e) => (e.stopPropagation(), closeSession(row.session.id))} />
              </>
            )}
            {row.kind === "forward" && (
              <IconButton icon={SquareArrowOutUpRight} title="Tới tab Ports của phiên" onClick={(e) => (e.stopPropagation(), openSession(row.forward.sessionId, "ports"))} />
            )}
            {row.kind === "transfer" && (
              <IconButton icon={RotateCcw} title="Thử lại" onClick={(e) => (e.stopPropagation(), retryTransfer(row.transfer))} />
            )}
            {row.kind === "host" && (
              <>
                <IconButton
                  icon={BellOff}
                  title="Bỏ qua tới lần kết nối sau"
                  onClick={(e) => (e.stopPropagation(), updatePrefs((p) => dismissFailure(p, row.host.id)))}
                />
                <Button icon={Terminal} className="button compact connect" onClick={(e) => (e.stopPropagation(), connect(row.host))}>
                  Thử lại
                </Button>
              </>
            )}
          </span>
        </>
      );
    }
    // all
    const host = row;
    const entry = prefs.history[host.id];
    return (
      <>
        <span className="lp-status">
          <Server size={15} className="muted" />
        </span>
        <HostName host={host} pinned={pinned.has(host.id)} />
        <WorkspaceBadge workspace={ws(host.workspaceId)} onClick={() => showWorkspace(host)} />
        <span className="muted">{host.group || "—"}</span>
        <span className="muted">{entry ? agoLabel(entry.at, now) : "Chưa kết nối"}</span>
        <span className="lp-actions">
          {pinButton(host)}
          <Button icon={Terminal} className="button compact connect" onClick={(e) => (e.stopPropagation(), connect(host))}>
            Kết nối
          </Button>
        </span>
      </>
    );
  };

  const headers = {
    sessions: ["", "Server", "Workspace", "Trạng thái", "Chế độ", ""],
    recent: ["", "Server", "Workspace", "Kết quả", "Lần cuối", ""],
    forwards: ["", "Forward", "Server", "Kết nối", "", ""],
    transfers: ["", "File", "Server", "Tiến độ", "", ""],
    attention: ["", "Server", "Vấn đề", "Chi tiết", "Lúc", ""],
    all: ["", "Server", "Workspace", "Nhóm", "Lần cuối", ""],
  }[tab];

  const empty = {
    sessions: "Chưa có phiên nào đang mở. Kết nối một server ở tab Gần đây hoặc Tất cả server.",
    recent: "Chưa có lịch sử kết nối. Server bạn kết nối hoặc ghim sẽ xuất hiện ở đây.",
    forwards: "Không có port forward nào đang chạy.",
    transfers: "Không có tác vụ truyền file đang chạy hoặc lỗi.",
    attention: "Không có gì cần xử lý. Mọi thứ đều ổn.",
    all: "Chưa có server nào.",
  }[tab];

  const grouped = tab === "recent" || tab === "all";
  let index = -1;

  return (
    <section className="page launchpad-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">MỌI WORKSPACE · MỘT NƠI</div>
          <h1>
            <Rocket size={28} className="mint" />
            Launchpad
          </h1>
          <p>Phiên, port forward, truyền file và server của các workspace ở một nơi.</p>
        </div>
        <div className="actions">
          <Dropdown items={scopeMenu} align="end">
            <button type="button" className="button" title="Phạm vi Launchpad">
              <Briefcase size={16} />
              {scope === "all" ? "Mọi workspace" : `Workspace “${activeWs.name}”`}
              <ChevronDown size={14} />
            </button>
          </Dropdown>
          <Dropdown items={moreMenu} align="end">
            <button type="button" className="button square" aria-label="Tùy chọn Launchpad">
              <History size={16} />
            </button>
          </Dropdown>
        </div>
      </div>
      <div className="lp-tabs" role="tablist">
        {TABS.map(([id, label], i) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            title={`${label} (${i + 1})`}
            className={`${tab === id ? "selected" : ""} ${id === "attention" && rows.attention.length ? "warn" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            <b>{rows[id].length > 99 ? "99+" : rows[id].length}</b>
          </button>
        ))}
      </div>
      <div className="toolbar lp-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            ref={searchRef}
            aria-label="Tìm trong Launchpad"
            placeholder="Tìm server, workspace, file, lỗi…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>/</kbd>
        </div>
        {grouped && (
          <>
            <Button icon={ChevronsDownUp} onClick={() => setCollapsed(new Set(groups.map((g) => g.key)))}>
              Thu gọn
            </Button>
            <Button icon={ChevronsUpDown} onClick={() => setCollapsed(new Set())}>
              Mở rộng
            </Button>
          </>
        )}
        <span className="lp-keys">
          <kbd>J</kbd>
          <kbd>K</kbd> chọn · <kbd>Enter</kbd> mở · <kbd>C</kbd> kết nối · <kbd>P</kbd> ghim
        </span>
      </div>
      <div
        className={`lp-list lp-${tab}`}
        ref={listRef}
        tabIndex={-1}
        role="grid"
        aria-label={TABS.find(([id]) => id === tab)[1]}
      >
        <div className="lp-row lp-head" role="row">
          {headers.map((h, i) => (
            <span key={i}>{h}</span>
          ))}
        </div>
        {!filtered[tab].length ? (
          <div className="empty-inline">
            {query ? "Không có kết quả phù hợp." : tab === "attention" ? (
              <>
                <ListChecks size={18} className="mint" /> {empty}
              </>
            ) : (
              empty
            )}
          </div>
        ) : (
          groups.map((g) => {
            const closed = collapsed.has(g.key);
            return (
              <div key={g.key || "all"} role="rowgroup">
                {g.label && (
                  <button
                    type="button"
                    className="lp-group"
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        n.has(g.key) ? n.delete(g.key) : n.add(g.key);
                        return n;
                      })
                    }
                  >
                    {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {g.color && <i className="workspace-dot small" style={{ background: g.color }} />}
                    {g.key === "pinned" && <Pin size={13} />}
                    {g.label}
                    <b>{g.rows.length}</b>
                  </button>
                )}
                {!closed &&
                  g.rows.map((row) => {
                    index++;
                    const i = index;
                    const host = hostOf(row);
                    return (
                      <div
                        key={row.id || row.host?.id}
                        role="row"
                        data-row={i}
                        aria-selected={i === cur}
                        className={`lp-row ${i === cur ? "cursor" : ""}`}
                        onClick={() => setCursor(i)}
                        onDoubleClick={(e) => !e.target.closest("button") && primary(row)}
                        onContextMenu={host ? contextMenu(() => hostMenu(host)) : undefined}
                      >
                        {cells(row)}
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
      {tab === "transfers" && rows.transfers.length > 0 && (
        <div className="lp-footer">
          <Button icon={RefreshCw} onClick={showQueue}>
            Mở hàng đợi truyền file
          </Button>
        </div>
      )}
      {tab === "forwards" && (
        <p className="lp-note">
          <Cable size={14} /> Thêm hoặc lưu forward trong tab Ports của từng phiên.
        </p>
      )}
    </section>
  );
}
