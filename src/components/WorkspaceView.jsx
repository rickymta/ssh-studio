import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  KeyRound,
  LayoutGrid,
  List,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Server,
  SquareArrowOutUpRight,
  Terminal,
  Trash2,
  Wand2,
  Briefcase,
} from "lucide-react";
import { WORKSPACE_COLORS, writeClipboard } from "../lib.js";
import * as F from "../folders.js";
import { agoLabel, togglePin } from "../launchpad.js";
import {
  acceptDrop,
  applyDrop,
  folderMenu,
  groupIntoFolders,
  moveTargets,
  newFolder,
  placeHosts,
  toggleFolder,
} from "./folderActions.jsx";
import { DROP_ATTR, DragGhost, beginDrag, useFolderDrag } from "./folderDrag.jsx";
import { usePrefs, updatePrefs } from "./launchpadStore.js";
import { Dropdown, contextMenu, openMenu } from "./menu.jsx";
import { Button, IconButton } from "./ui.jsx";

export const authLabels = {
  password: "Password",
  key: "SSH key",
  agent: "SSH agent",
  interactive: "MFA / OTP",
};

/** Per-server state shown in the list, the cards and the filters. */
function hostState(host, sessions, prefs) {
  const own = sessions.filter((s) => s.host.id === host.id);
  const connected = own.filter((s) => s.status === "connected").length;
  const connecting = own.some((s) => s.status === "connecting");
  const broken = own.find((s) => s.status === "error");
  const entry = prefs.history[host.id] || null;
  const failed = !!entry && !entry.ok && !entry.dismissed && !connected;
  return {
    sessions: own,
    connected,
    connecting,
    error: broken?.error || (failed ? entry.error : ""),
    attention: !!broken || failed,
    entry,
    pinned: prefs.pinned.includes(host.id),
  };
}

const FILTERS = [
  ["all", "Tất cả", () => true],
  ["connected", "Đang kết nối", (s) => s.connected > 0 || s.connecting],
  ["idle", "Chưa mở", (s) => s.sessions.length === 0],
  ["forwards", "Có port forward", (s, h) => (h.forwards || []).length > 0],
  ["attention", "Cần chú ý", (s) => s.attention],
];

const VIEW_KEY = "ssh-studio.serverView";
const readMode = () => {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
};

/**
 * The overview of the active workspace: servers grouped by folder (list or cards), filters,
 * search and bulk connect. The folder shown is picked in the sidebar tree or the breadcrumb.
 */
export function WorkspaceView({
  ctx,
  view,
  folder,
  setFolder,
  sessions,
  search,
  setSearch,
  group,
  setGroup,
  searchBox,
  connect,
  connectMany,
  openSession,
  addHost,
  editHost,
  deleteHost,
  editWorkspace,
  saveWorkspace,
  notify,
  notices,
}) {
  const { ws } = ctx;
  const prefs = usePrefs();
  const [filter, setFilter] = useState("all");
  const [mode, setModeState] = useState(readMode);
  const setMode = (m) => {
    setModeState(m);
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {}
  };
  const folders = ws.folders || [];
  const color = WORKSPACE_COLORS[ws.color] || WORKSPACE_COLORS.mint;
  const hosts = view.hosts;
  const selected = folders.some((f) => f.id === folder) ? folder : F.ROOT;
  const trail = F.pathTo(folders, selected);
  const here = trail.at(-1);
  const scope = F.hostsIn(folders, hosts, selected, true);
  const groups = [...new Set(hosts.map((h) => h.group).filter(Boolean))];
  const rootGroups = F.rootGroups(folders, hosts);
  const states = useMemo(
    () => new Map(hosts.map((h) => [h.id, hostState(h, sessions, prefs)])),
    [hosts, sessions, prefs],
  );
  const counts = Object.fromEntries(
    FILTERS.map(([key, , test]) => [
      key,
      scope.filter((h) => test(states.get(h.id), h)).length,
    ]),
  );
  const filtering = search.trim() !== "" || filter !== "all" || group !== "all";
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const test = FILTERS.find(([key]) => key === filter)[2];
    return new Set(
      scope
        .filter((h) => test(states.get(h.id), h))
        .filter((h) => group === "all" || h.group === group)
        .filter(
          (h) =>
            !q ||
            `${h.name} ${h.host} ${h.username} ${h.group}`.toLowerCase().includes(q),
        )
        .map((h) => h.id),
    );
  }, [scope, search, filter, group, states]);
  const visible = scope.filter((h) => matches.has(h.id));
  const connectedHere = scope.filter((h) => states.get(h.id).connected > 0).length;

  // Esc in the search box clears it.
  useEffect(() => {
    const box = searchBox.current;
    if (!box) return;
    const key = (e) => e.key === "Escape" && search && setSearch("");
    box.addEventListener("keydown", key);
    return () => box.removeEventListener("keydown", key);
  }, [search]);

  const drag = (e, item) =>
    beginDrag(
      e,
      item,
      (it, to) => acceptDrop(ws, it, to),
      (it, to) => applyDrop(ctx, it, to),
    );

  const hostMenu = (host, at) => {
    const state = states.get(host.id);
    const open = state.sessions[0];
    const others = view.workspaces.filter((w) => w.id !== ws.id);
    return [
      open
        ? { label: "Mở phiên đang chạy", icon: SquareArrowOutUpRight, onSelect: () => openSession(open.id) }
        : null,
      {
        label: open ? "Kết nối phiên mới" : "Kết nối",
        icon: Terminal,
        onSelect: () => connect(host),
      },
      "sep",
      { label: "Sửa server…", icon: Pencil, onSelect: () => editHost(host) },
      {
        label: "Sao chép lệnh ssh",
        icon: Copy,
        onSelect: async () => {
          await writeClipboard(
            `ssh ${host.username}@${host.host}${Number(host.port) !== 22 ? ` -p ${host.port}` : ""}`,
          );
          notify("Đã sao chép lệnh ssh.");
        },
      },
      {
        label: state.pinned ? "Bỏ ghim khỏi Launchpad" : "Ghim vào Launchpad",
        icon: state.pinned ? PinOff : Pin,
        onSelect: () => updatePrefs((p) => togglePin(p, host.id)),
      },
      "sep",
      {
        label: "Chuyển tới thư mục",
        icon: FolderInput,
        items: moveTargets(ws, at, (to) => placeHosts(ctx, [host], to)),
      },
      {
        label: "Thư mục mới chứa server này…",
        icon: FolderPlus,
        disabled: !F.canNest(folders, at),
        onSelect: async () => {
          const id = await newFolder(ctx, at);
          if (id) placeHosts(ctx, [host], id);
        },
      },
      others.length
        ? {
            label: "Chuyển sang workspace",
            icon: Briefcase,
            items: others.map((w) => ({
              label: w.name,
              onSelect: async () => {
                if (await placeHosts(ctx, [host], F.ROOT, w.id))
                  notify(`Đã chuyển ${host.name} sang “${w.name}”.`);
              },
            })),
          }
        : null,
      "sep",
      { label: "Xóa server", icon: Trash2, danger: true, onSelect: () => deleteHost(host) },
    ];
  };

  const connectAll = (list) => {
    const idle = list.filter((h) => states.get(h.id).sessions.length === 0);
    if (!idle.length) return notify("Mọi server trong danh sách đều đã có phiên đang mở.");
    connectMany(idle);
  };

  const addMenu = [
    { label: "Thêm server…", icon: Plus, onSelect: () => addHost(selected) },
    {
      label: here ? `Thư mục con trong “${here.name}”…` : "Thư mục mới…",
      icon: FolderPlus,
      disabled: !F.canNest(folders, selected),
      onSelect: async () => {
        const id = await newFolder(ctx, selected);
        if (id) setFolder(id);
      },
    },
    rootGroups.length
      ? {
          label: `Tạo thư mục từ ${rootGroups.length} nhóm server…`,
          icon: Wand2,
          onSelect: async () => {
            const placed = await groupIntoFolders(ctx, rootGroups);
            if (placed !== undefined) notify(`Đã xếp ${placed} server vào thư mục theo nhóm.`);
          },
        }
      : null,
  ];

  const moreMenu = [
    { label: "Sửa workspace…", icon: Pencil, onSelect: () => editWorkspace(ws) },
    {
      label: "Màu",
      icon: Palette,
      items: Object.keys(WORKSPACE_COLORS).map((key) => ({
        label: key[0].toUpperCase() + key.slice(1),
        checked: ws.color === key,
        icon: () => <i className="menu-swatch" style={{ background: WORKSPACE_COLORS[key] }} />,
        onSelect: () => saveWorkspace({ id: ws.id, name: ws.name, color: key }),
      })),
    },
    "sep",
    {
      label: "Xóa workspace…",
      icon: Trash2,
      danger: true,
      onSelect: () => editWorkspace(ws),
    },
  ];

  const row = (host, depth, at) => (
    <HostRow
      key={host.id}
      host={host}
      depth={depth}
      at={at}
      state={states.get(host.id)}
      menu={() => hostMenu(host, at)}
      connect={() => connect(host)}
      open={(id) => openSession(id)}
      edit={() => editHost(host)}
      drag={(e) => drag(e, { kind: "hosts", hosts: [host], label: host.name })}
    />
  );

  /** What `parent` holds — subfolders, then servers — at `depth` in the list. */
  const contents = (parent, depth) => {
    const out = [];
    for (const f of F.childrenOf(folders, parent)) {
      const inside = F.hostsIn(folders, hosts, f.id, true);
      const hits = inside.filter((h) => matches.has(h.id));
      if (filtering && !hits.length) continue;
      const expanded = filtering || !f.collapsed;
      out.push(
        <FolderRow
          key={`f:${f.id}`}
          folder={f}
          depth={depth}
          color={color}
          expanded={expanded}
          hosts={hits}
          total={inside.length}
          states={states}
          toggle={() => toggleFolder(ctx, f)}
          show={() => setFolder(f.id)}
          connectAll={() => connectAll(hits)}
          menu={() =>
            folderMenu(ctx, f, inside.length, [
              { label: "Chỉ xem thư mục này", icon: FolderOpen, onSelect: () => setFolder(f.id) },
              {
                label: `Kết nối tất cả (${hits.length})`,
                icon: Terminal,
                disabled: !hits.length,
                onSelect: () => connectAll(hits),
              },
              { label: "Thêm server vào đây…", icon: Plus, onSelect: () => addHost(f.id) },
            ])
          }
          drag={(e) => drag(e, { kind: "folder", id: f.id, label: f.name })}
        />,
      );
      if (expanded) {
        const inner = contents(f.id, depth + 1);
        out.push(
          ...(inner.length
            ? inner
            : [
                <div
                  key={`e:${f.id}`}
                  {...{ [DROP_ATTR]: f.id }}
                  className="server-list-empty"
                  style={{ paddingLeft: 18 + (depth + 1) * 22 }}
                >
                  Thư mục trống: kéo server vào đây, hoặc dùng “Chuyển tới thư mục”.
                </div>,
              ]),
        );
      }
    }
    for (const h of F.hostsIn(folders, hosts, parent))
      if (matches.has(h.id)) out.push(row(h, depth, parent));
    return out;
  };

  /** Card sections: the folder shown, then each folder under it (tree order). */
  const sections = () => {
    const list = [{ folder: here || null, depth: 0, hosts: F.hostsIn(folders, hosts, selected) }];
    const walk = (parent, depth) => {
      for (const f of F.childrenOf(folders, parent)) {
        list.push({ folder: f, depth, hosts: F.hostsIn(folders, hosts, f.id) });
        walk(f.id, depth + 1);
      }
    };
    walk(selected, 1);
    return list
      .map((s) => ({ ...s, hosts: s.hosts.filter((h) => matches.has(h.id)) }))
      .filter((s, i) => s.hosts.length || (!filtering && i > 0));
  };

  const list = mode === "list" ? contents(selected, 0) : null;
  const cards = mode === "grid" ? sections() : null;

  return (
    <section className="page workspace-page">
      <DragGhost />
      <div className="page-heading">
        <div>
          <div className="eyebrow">WORKSPACE</div>
          <h1>
            <i className="workspace-dot" style={{ background: color }} />
            {ws.name}
            <span>{hosts.length}</span>
          </h1>
          <p>
            {hosts.length} server
            {folders.length > 0 && ` · ${folders.length} thư mục`}
            {connectedHere > 0 && ` · ${connectedHere} đang kết nối`}. Kéo server hoặc thư
            mục để sắp xếp.
          </p>
        </div>
        <div className="actions">
          <Button
            icon={Terminal}
            disabled={!visible.length}
            title="Mở phiên cho mọi server trong danh sách chưa có phiên"
            onClick={() => connectAll(visible)}
          >
            Kết nối tất cả
          </Button>
          <div className="split-button">
            <Button icon={Plus} variant="primary" onClick={() => addHost(selected)}>
              Thêm server
            </Button>
            <Dropdown items={addMenu} align="end">
              <button
                type="button"
                className="button primary split-toggle"
                title="Thêm thư mục…"
                aria-label="Thêm khác"
              >
                <ChevronDown size={15} />
              </button>
            </Dropdown>
          </div>
          <Dropdown items={moreMenu} align="end">
            <button type="button" className="button square" aria-label="Tùy chọn workspace">
              <MoreHorizontal size={16} />
            </button>
          </Dropdown>
        </div>
      </div>
      {notices}
      {hosts.length === 0 ? (
        <Welcome addHost={() => addHost(F.ROOT)} />
      ) : (
        <>
          <div className="folder-crumbs">
            <button
              type="button"
              {...{ [DROP_ATTR]: F.ROOT }}
              className={here ? "" : "current"}
              onClick={() => setFolder(F.ROOT)}
            >
              Tất cả server
            </button>
            {trail.map((f, i) => (
              <React.Fragment key={f.id}>
                <ChevronRight size={14} />
                <button
                  type="button"
                  {...{ [DROP_ATTR]: f.id }}
                  className={i === trail.length - 1 ? "current" : ""}
                  onClick={() => setFolder(f.id)}
                >
                  <Folder size={14} style={{ color }} />
                  {f.name}
                </button>
              </React.Fragment>
            ))}
            {here && (
              <Dropdown items={() => folderMenu(ctx, here, scope.length)}>
                <button type="button" className="icon-button" aria-label="Tùy chọn thư mục">
                  <MoreHorizontal size={16} />
                </button>
              </Dropdown>
            )}
            <span className="crumb-count">
              {scope.length} server
              {filtering && visible.length !== scope.length && ` · ${visible.length} khớp`}
            </span>
          </div>
          <div className="toolbar workspace-toolbar">
            <div className="search-box">
              <Search size={18} />
              <input
                ref={searchBox}
                aria-label="Tìm server"
                title="Ctrl+K"
                placeholder="Tìm theo tên, IP, username hoặc nhóm…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </div>
            <div className="filter-chips" role="group" aria-label="Lọc server">
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={filter === key}
                  className={`${filter === key ? "selected" : ""} ${key === "attention" && counts[key] ? "warn" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                  <b>{counts[key]}</b>
                </button>
              ))}
            </div>
            {groups.length > 0 && (
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
            )}
            <div className="segmented view-toggle" role="group" aria-label="Kiểu hiển thị">
              <button
                type="button"
                title="Danh sách theo thư mục"
                aria-pressed={mode === "list"}
                className={mode === "list" ? "selected" : ""}
                onClick={() => setMode("list")}
              >
                <List size={16} />
              </button>
              <button
                type="button"
                title="Thẻ"
                aria-pressed={mode === "grid"}
                className={mode === "grid" ? "selected" : ""}
                onClick={() => setMode("grid")}
              >
                <LayoutGrid size={16} />
              </button>
            </div>
          </div>
          {mode === "list" ? (
            <div className="server-list" {...{ [DROP_ATTR]: selected }}>
              <div className="server-list-row server-list-head">
                <span>Server</span>
                <span>Nhóm</span>
                <span>Xác thực</span>
                <span>Trạng thái</span>
                <span>Kết nối gần nhất</span>
                <span />
              </div>
              {list}
              {!list.length && (
                <div className="empty-inline">
                  {filtering
                    ? "Không có server phù hợp."
                    : "Thư mục trống: kéo server vào đây, hoặc dùng “Chuyển tới thư mục” trên một server."}
                </div>
              )}
            </div>
          ) : (
            <div className="card-sections">
              {cards.map((s, i) => (
                <CardSection
                  key={s.folder?.id || "root"}
                  section={s}
                  first={i === 0}
                  folders={folders}
                  selected={selected}
                  color={color}
                  showFolder={setFolder}
                >
                  {s.hosts.map((host) => (
                    <ServerCard
                      key={host.id}
                      host={host}
                      state={states.get(host.id)}
                      at={F.folderOf(folders, host)}
                      menu={() => hostMenu(host, F.folderOf(folders, host))}
                      connect={() => connect(host)}
                      open={openSession}
                      edit={() => editHost(host)}
                      remove={() => deleteHost(host)}
                      drag={(e) => drag(e, { kind: "hosts", hosts: [host], label: host.name })}
                    />
                  ))}
                </CardSection>
              ))}
              {!cards.length && (
                <div className="empty-inline">
                  {filtering ? "Không có server phù hợp." : "Thư mục trống."}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StatusCell({ state }) {
  if (state.connected)
    return (
      <span className="online">
        <i className="status-dot connected" />
        {state.connected} phiên hoạt động
      </span>
    );
  if (state.connecting)
    return (
      <span className="muted">
        <i className="status-dot connecting" /> Đang kết nối
      </span>
    );
  if (state.attention)
    return (
      <span className="danger-text" title={state.error}>
        <AlertTriangle size={14} />
        <span className="ellipsis">{state.error || "Lỗi kết nối"}</span>
      </span>
    );
  return <span className="muted">Sẵn sàng</span>;
}

function LastCell({ entry }) {
  if (!entry) return <span className="muted">Chưa kết nối</span>;
  return (
    <span className="last-cell" title={new Date(entry.at).toLocaleString("vi-VN")}>
      <i className={`status-dot ${entry.ok ? "connected" : "error"}`} />
      {agoLabel(entry.at)}
      {entry.count > 1 && <small>· {entry.count} lần</small>}
    </span>
  );
}

function AuthCell({ host }) {
  const Icon = host.auth === "key" ? KeyRound : LockKeyhole;
  const forwards = (host.forwards || []).length;
  return (
    <span className="auth-cell">
      <Icon size={14} />
      {authLabels[host.auth] || "Password"}
      {host.jumpHostId && " · Jump"}
      {host.proxy?.kind && host.proxy.kind !== "none" && ` · ${host.proxy.kind.toUpperCase()}`}
      {forwards > 0 && ` · ${forwards} forward`}
    </span>
  );
}

function HostActions({ state, connect, open, edit, menu }) {
  const live = state.sessions[0];
  return (
    <div className="row-actions">
      {live ? (
        <Button icon={SquareArrowOutUpRight} className="button compact" onClick={() => open(live.id)}>
          Mở
        </Button>
      ) : (
        <Button icon={Terminal} className="button compact connect" onClick={connect}>
          Kết nối
        </Button>
      )}
      <IconButton icon={Pencil} title="Sửa server" onClick={edit} />
      <Dropdown items={menu} align="end">
        <button type="button" className="icon-button" aria-label="Thêm thao tác">
          <MoreHorizontal size={17} />
        </button>
      </Dropdown>
    </div>
  );
}

function HostRow({ host, depth, at, state, menu, connect, open, edit, drag }) {
  const { over, item } = useFolderDrag();
  const live = state.sessions[0];
  return (
    <div
      role="row"
      tabIndex={0}
      {...{ [DROP_ATTR]: at }}
      className={`server-list-row host-row ${item && over === at ? "drop-sibling" : ""}`}
      style={{ paddingLeft: 18 + depth * 22 }}
      onDoubleClick={(e) => !e.target.closest("button") && (live ? open(live.id) : connect())}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") live ? open(live.id) : connect();
        else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          openMenu(box.left + 40, box.bottom, menu);
        }
      }}
      onContextMenu={contextMenu(menu)}
      onPointerDown={drag}
      title="Nhấp đúp để kết nối"
    >
      <div className="host-cell">
        <span className="host-icon">
          <Server size={16} />
          {state.connected > 0 && <i className="status-dot connected" />}
        </span>
        <div>
          <strong>
            {host.name}
            {state.pinned && <Pin size={12} className="pin-mark" />}
          </strong>
          <small className="mono">
            {host.username}@{host.host}
            <span>:{host.port}</span>
          </small>
        </div>
      </div>
      <div>{host.group ? <span className="tag">{host.group}</span> : <span className="muted">—</span>}</div>
      <AuthCell host={host} />
      <StatusCell state={state} />
      <LastCell entry={state.entry} />
      <HostActions state={state} connect={connect} open={open} edit={edit} menu={menu} />
    </div>
  );
}

function FolderRow({
  folder,
  depth,
  color,
  expanded,
  hosts,
  total,
  states,
  toggle,
  show,
  connectAll,
  menu,
  drag,
}) {
  const { over } = useFolderDrag();
  const connected = hosts.filter((h) => states.get(h.id).connected > 0).length;
  const attention = hosts.filter((h) => states.get(h.id).attention).length;
  const latest = hosts
    .map((h) => states.get(h.id).entry?.at)
    .filter(Boolean)
    .sort((a, b) => b - a)[0];
  return (
    <div
      role="row"
      tabIndex={0}
      aria-expanded={expanded}
      {...{ [DROP_ATTR]: folder.id }}
      className={`server-list-row folder-row ${over === folder.id ? "drop" : ""}`}
      style={{ paddingLeft: 18 + depth * 22 }}
      onClick={toggle}
      onDoubleClick={(e) => !e.target.closest("button") && show()}
      onKeyDown={(e) => e.target === e.currentTarget && e.key === "Enter" && toggle()}
      onContextMenu={contextMenu(menu)}
      onPointerDown={drag}
    >
      <div className="host-cell folder-cell">
        <ChevronRight size={14} className={`chevron ${expanded ? "turned" : ""}`} />
        {expanded ? <FolderOpen size={17} style={{ color }} /> : <Folder size={17} style={{ color }} />}
        <strong>{folder.name}</strong>
        <span className="count">{hosts.length === total ? total : `${hosts.length}/${total}`}</span>
      </div>
      <div />
      <div />
      <div className="folder-summary">
        {connected > 0 && (
          <span className="online">
            <i className="status-dot connected" /> {connected} đang kết nối
          </span>
        )}
        {attention > 0 && (
          <span className="danger-text">
            <AlertTriangle size={13} /> {attention}
          </span>
        )}
      </div>
      <div className="muted small">{latest ? agoLabel(latest) : ""}</div>
      <div className="row-actions hover-only">
        <IconButton
          icon={Terminal}
          title="Kết nối tất cả trong thư mục"
          disabled={!hosts.length}
          onClick={(e) => {
            e.stopPropagation();
            connectAll();
          }}
        />
        <Dropdown items={menu} align="end">
          <button type="button" className="icon-button" aria-label="Tùy chọn thư mục">
            <MoreHorizontal size={17} />
          </button>
        </Dropdown>
      </div>
    </div>
  );
}

function CardSection({ section, first, folders, selected, color, showFolder, children }) {
  const { over } = useFolderDrag();
  const id = section.folder?.id ?? selected;
  // The folder shown is named as is; the ones under it by their path from it.
  const label = !section.folder
    ? folders.length
      ? "Chưa xếp vào thư mục"
      : ""
    : first
      ? section.folder.name
      : F.pathTo(folders, section.folder.id)
          .slice(F.pathTo(folders, selected).length)
          .map((f) => f.name)
          .join(" / ");
  return (
    <div className={`card-section ${over === id ? "drop" : ""}`} {...{ [DROP_ATTR]: id }}>
      {label && (
        <button type="button" className="card-section-title" onClick={() => showFolder(id)}>
          {section.folder ? <Folder size={15} style={{ color }} /> : <Server size={15} />}
          {label}
          <span className="count">{section.hosts.length}</span>
        </button>
      )}
      {section.hosts.length ? (
        <div className="server-grid">{children}</div>
      ) : (
        <div className="server-list-empty">Thư mục trống: kéo server vào đây.</div>
      )}
    </div>
  );
}

function ServerCard({ host, state, menu, connect, open, edit, remove, drag }) {
  const live = state.sessions[0];
  return (
    <article
      className="server-card"
      onContextMenu={contextMenu(menu)}
      onPointerDown={drag}
      onDoubleClick={(e) => !e.target.closest("button") && (live ? open(live.id) : connect())}
    >
      <div className="server-card-top">
        <span className="server-icon">
          <Server size={23} />
        </span>
        {state.pinned && <Pin size={14} className="pin-mark" />}
        {host.group && <span className="tag">{host.group}</span>}
        <IconButton title="Sửa server" icon={Pencil} onClick={edit} />
        <IconButton title="Xóa server" icon={Trash2} onClick={remove} />
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
        <AuthCell host={host} />
      </div>
      <div className="server-card-bottom">
        <StatusCell state={state} />
        {live ? (
          <Button icon={SquareArrowOutUpRight} onClick={() => open(live.id)}>
            Mở
          </Button>
        ) : (
          <Button icon={Terminal} onClick={connect}>
            Kết nối
          </Button>
        )}
      </div>
    </article>
  );
}

function Welcome({ addHost }) {
  return (
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
      <Button variant="primary" icon={Plus} onClick={addHost}>
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
  );
}
