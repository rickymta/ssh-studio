// Launchpad's pure logic: which rows each tab shows across workspaces, pins, the connection
// history, the "needs attention" list and its badge count. Rendering is in LaunchpadView.jsx.

export const TABS = [
  ["sessions", "Phiên đang mở"],
  ["recent", "Gần đây"],
  ["forwards", "Port forward"],
  ["transfers", "Truyền file"],
  ["attention", "Cần chú ý"],
  ["all", "Tất cả server"],
];

const DAY = 86_400_000;
/** Connection history entries kept (newest first). */
export const HISTORY_LIMIT = 200;

export const EMPTY_PREFS = {
  pinned: [],
  history: {},
  scope: "all",
  tab: "sessions",
};

/** Stored prefs, dropping anything malformed. */
export function parsePrefs(raw) {
  let value;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object") return EMPTY_PREFS;
  const history = {};
  if (value.history && typeof value.history === "object")
    for (const [id, entry] of Object.entries(value.history))
      if (entry && Number.isFinite(entry.at))
        history[id] = {
          at: entry.at,
          ok: !!entry.ok,
          error: typeof entry.error === "string" ? entry.error : "",
          count: Number.isFinite(entry.count) ? entry.count : 1,
          dismissed: !!entry.dismissed,
        };
  return {
    pinned: Array.isArray(value.pinned)
      ? value.pinned.filter((x) => typeof x === "string")
      : [],
    history,
    scope: value.scope === "workspace" ? "workspace" : "all",
    tab: TABS.some(([id]) => id === value.tab) ? value.tab : "sessions",
  };
}

/** Remembers the outcome of a connection attempt (no secrets: only time, result, message). */
export function recordConnection(prefs, hostId, ok, error = "", now = Date.now()) {
  const before = prefs.history[hostId];
  const history = {
    ...prefs.history,
    [hostId]: {
      at: now,
      ok,
      error: ok ? "" : String(error || "").slice(0, 300),
      count: (before?.count || 0) + 1,
      dismissed: false,
    },
  };
  const ids = Object.keys(history);
  if (ids.length > HISTORY_LIMIT)
    ids
      .sort((a, b) => history[a].at - history[b].at)
      .slice(0, ids.length - HISTORY_LIMIT)
      .forEach((id) => delete history[id]);
  return { ...prefs, history };
}

export const togglePin = (prefs, id) => ({
  ...prefs,
  pinned: prefs.pinned.includes(id)
    ? prefs.pinned.filter((x) => x !== id)
    : [...prefs.pinned, id],
});

/** Drops a server from the history (and pins). */
export function forgetHost(prefs, id) {
  const history = { ...prefs.history };
  delete history[id];
  return { ...prefs, history, pinned: prefs.pinned.filter((x) => x !== id) };
}

/** Hides a failed connection from "Cần chú ý" until the next attempt. */
export function dismissFailure(prefs, id) {
  const entry = prefs.history[id];
  if (!entry) return prefs;
  return {
    ...prefs,
    history: { ...prefs.history, [id]: { ...entry, dismissed: true } },
  };
}

/** Every word of `query` appears in one of `fields` (case-insensitive). */
export function matches(query, ...fields) {
  const words = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = fields.filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const hostText = (h) =>
  [h.name, h.host, h.username, `${h.username}@${h.host}`, h.group];

/** "vừa xong", "5 phút", "3 giờ", "2 ngày", "4 tháng", "1 năm". */
export function ageLabel(at, now = Date.now()) {
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} ngày`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))} tháng`;
  return `${Math.floor(s / (86400 * 365))} năm`;
}

/** "Vừa xong", "5 phút trước"… */
export function agoLabel(at, now = Date.now()) {
  const age = ageLabel(at, now);
  return age === "vừa xong" ? "Vừa xong" : age && `${age} trước`;
}

/** Section of a recent server: pinned first, then by when it was last used. */
export function recentGroup(at, pinned, now = Date.now()) {
  if (pinned) return "pinned";
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  if (at >= midnight) return "today";
  if (at >= midnight - 6 * DAY) return "week";
  return "older";
}
export const RECENT_GROUPS = [
  ["pinned", "Đã ghim"],
  ["today", "Hôm nay"],
  ["week", "7 ngày qua"],
  ["older", "Cũ hơn"],
];

/** Servers Launchpad looks at: every workspace, or only the active one. */
export function scopeHosts(hosts, scope, activeWorkspace) {
  return scope === "workspace"
    ? hosts.filter((h) => h.workspaceId === activeWorkspace)
    : hosts;
}

/**
 * Everything Launchpad lists, already limited to the servers in scope (`hosts`). Sessions
 * of servers deleted since keep showing (they are still open) in the "all workspaces" scope.
 */
export function buildRows(
  { hosts, sessions, forwards, transfers, prefs, scope },
  now = Date.now(),
) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const inScope = (hostId) => scope !== "workspace" || byId.has(hostId);
  const pinned = new Set(prefs.pinned);
  const sessionRows = sessions.filter((s) => inScope(s.host.id));
  const sessionOf = new Map(sessions.map((s) => [s.id, s]));
  const forwardRows = Object.values(forwards || {})
    .filter((f) => {
      const s = sessionOf.get(f.sessionId);
      return (
        s && inScope(s.host.id) && ["running", "error"].includes(f.status)
      );
    })
    .map((f) => ({ ...f, session: sessionOf.get(f.sessionId) }));
  const transferRows = transfers
    .filter((t) => ["queued", "running", "failed"].includes(t.status))
    .map((t) => ({ ...t, session: sessionOf.get(t.sessionId) }))
    .filter((t) => !t.session || inScope(t.session.host.id));
  const recentRows = hosts
    .filter((h) => prefs.history[h.id] || pinned.has(h.id))
    .map((h) => ({
      host: h,
      entry: prefs.history[h.id] || null,
      pinned: pinned.has(h.id),
    }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.entry?.at || 0) - (a.entry?.at || 0),
    );
  const connected = new Set(
    sessions.filter((s) => s.status === "connected").map((s) => s.host.id),
  );
  const attention = [
    ...sessionRows
      .filter((s) => ["error", "closed"].includes(s.status))
      .map((s) => ({ id: `session:${s.id}`, kind: "session", session: s })),
    ...forwardRows
      .filter((f) => f.status === "error")
      .map((f) => ({ id: `forward:${f.id}`, kind: "forward", forward: f })),
    ...transferRows
      .filter((t) => t.status === "failed")
      .map((t) => ({ id: `transfer:${t.id}`, kind: "transfer", transfer: t })),
    ...hosts
      .filter((h) => {
        const e = prefs.history[h.id];
        return (
          e &&
          !e.ok &&
          !e.dismissed &&
          !connected.has(h.id) &&
          // An open session already reports its own error.
          !sessionRows.some((s) => s.host.id === h.id && s.status !== "closed")
        );
      })
      .map((h) => ({
        id: `host:${h.id}`,
        kind: "host",
        host: h,
        entry: prefs.history[h.id],
      })),
  ];
  return {
    sessions: sessionRows,
    recent: recentRows,
    forwards: forwardRows,
    transfers: transferRows,
    attention,
    all: hosts,
    now,
  };
}

/** What waits for the user: the "Cần chú ý" count (shown on the Launchpad button). */
export const badgeCount = (rows) => rows.attention.length;

/** Text a row is searched by, for each tab. */
export function rowText(tab, row, workspaces = []) {
  const wsName = (id) => workspaces.find((w) => w.id === id)?.name || "";
  if (tab === "sessions") return [...hostText(row.host), wsName(row.host.workspaceId)];
  if (tab === "recent")
    return [...hostText(row.host), wsName(row.host.workspaceId), row.entry?.error];
  if (tab === "forwards")
    return [
      row.spec?.bindHost,
      String(row.boundPort || row.spec?.bindPort || ""),
      row.spec?.targetHost,
      String(row.spec?.targetPort || ""),
      ...hostText(row.session.host),
    ];
  if (tab === "transfers")
    return [row.name, row.remoteDirectory, row.localDirectory, row.session?.host.name];
  if (tab === "attention") {
    const host =
      row.host || row.session?.host || row.forward?.session.host || row.transfer?.session?.host;
    return [
      ...(host ? hostText(host) : []),
      row.transfer?.name,
      row.entry?.error,
      row.session?.error,
      row.forward?.error,
      row.transfer?.error,
    ];
  }
  return [...hostText(row), wsName(row.workspaceId)];
}
