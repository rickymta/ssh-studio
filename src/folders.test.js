import { describe, expect, it } from "vitest";
import {
  acceptDrop,
  canMove,
  canNest,
  childrenOf,
  depthOf,
  flatFolders,
  folderCounts,
  folderOf,
  hostsIn,
  pathTo,
  rootGroups,
} from "./folders.js";
import {
  EMPTY_PREFS,
  HISTORY_LIMIT,
  ageLabel,
  badgeCount,
  buildRows,
  dismissFailure,
  forgetHost,
  matches,
  parsePrefs,
  recentGroup,
  recordConnection,
  scopeHosts,
  togglePin,
} from "./launchpad.js";

const folders = [
  { id: "a", name: "Khách A", parent: "" },
  { id: "b", name: "Prod", parent: "a" },
  { id: "c", name: "Web", parent: "b" },
  { id: "x", name: "10 Lab", parent: "" },
  { id: "y", name: "2 Lab", parent: "" },
];
const host = (id, folderId = "", extra = {}) => ({
  id,
  name: id,
  host: `${id}.example.com`,
  username: "root",
  group: "",
  workspaceId: "w1",
  folderId,
  ...extra,
});

describe("workspace folders", () => {
  it("knows depths, paths and where new folders fit", () => {
    expect(depthOf(folders, "")).toBe(0);
    expect(depthOf(folders, "c")).toBe(3);
    expect(pathTo(folders, "c").map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(canNest(folders, "b")).toBe(true);
    expect(canNest(folders, "c")).toBe(false);
  });
  it("sorts children by name, numbers naturally", () => {
    expect(childrenOf(folders, "").map((f) => f.name)).toEqual([
      "2 Lab",
      "10 Lab",
      "Khách A",
    ]);
    expect(flatFolders(folders).map((x) => [x.folder.id, x.depth])).toEqual([
      ["y", 1],
      ["x", 1],
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });
  it("refuses moves into itself, past three levels or to the same place", () => {
    expect(canMove(folders, "a", "c")).toBe(false);
    expect(canMove(folders, "b", "b")).toBe(false);
    expect(canMove(folders, "b", "a")).toBe(false);
    expect(canMove(folders, "b", "x")).toBe(true);
    expect(canMove(folders, "a", "x")).toBe(false);
    expect(canMove(folders, "x", "b")).toBe(true);
  });
  it("places servers, missing folders count as the root", () => {
    const hosts = [host("h1", "c"), host("h2", "a"), host("h3", "gone")];
    expect(folderOf(folders, hosts[2])).toBe("");
    expect(hostsIn(folders, hosts, "a").map((h) => h.id)).toEqual(["h2"]);
    expect(hostsIn(folders, hosts, "a", true).map((h) => h.id)).toEqual([
      "h1",
      "h2",
    ]);
    expect(hostsIn(folders, hosts, "").map((h) => h.id)).toEqual(["h3"]);
    expect(folderCounts(folders, hosts)).toMatchObject({ "": 3, a: 2, b: 1, x: 0 });
  });
  it("accepts drops that change something", () => {
    const h = host("h1", "a");
    expect(acceptDrop(folders, { kind: "hosts", hosts: [h] }, "a")).toBe(false);
    expect(acceptDrop(folders, { kind: "hosts", hosts: [h] }, "")).toBe(true);
    expect(acceptDrop(folders, { kind: "folder", id: "a" }, "x")).toBe(false);
  });
  it("lists groups still at the root once", () => {
    const hosts = [
      host("h1", "", { group: "Prod" }),
      host("h2", "", { group: " prod " }),
      host("h3", "a", { group: "Staging" }),
      host("h4", "", { group: "" }),
    ];
    expect(rootGroups(folders, hosts)).toEqual(["Prod"]);
  });
});

describe("launchpad", () => {
  const now = new Date(2026, 10, 22, 15, 0).getTime();
  it("reads stored prefs defensively", () => {
    expect(parsePrefs(null)).toEqual(EMPTY_PREFS);
    expect(parsePrefs("{bad")).toEqual(EMPTY_PREFS);
    const prefs = parsePrefs(
      JSON.stringify({
        pinned: ["a", 3],
        history: { a: { at: 1, ok: true }, b: { ok: false } },
        scope: "workspace",
        tab: "nope",
      }),
    );
    expect(prefs.pinned).toEqual(["a"]);
    expect(Object.keys(prefs.history)).toEqual(["a"]);
    expect(prefs.scope).toBe("workspace");
    expect(prefs.tab).toBe("sessions");
  });
  it("records attempts, pins, forgets and dismisses", () => {
    let prefs = recordConnection(EMPTY_PREFS, "a", false, "Sai mật khẩu", now);
    prefs = recordConnection(prefs, "a", false, "Timeout", now + 1);
    expect(prefs.history.a).toMatchObject({ ok: false, error: "Timeout", count: 2 });
    prefs = dismissFailure(prefs, "a");
    expect(prefs.history.a.dismissed).toBe(true);
    prefs = recordConnection(prefs, "a", true, "", now + 2);
    expect(prefs.history.a).toMatchObject({ ok: true, error: "", dismissed: false });
    prefs = togglePin(prefs, "a");
    expect(prefs.pinned).toEqual(["a"]);
    prefs = forgetHost(prefs, "a");
    expect(prefs.history.a).toBeUndefined();
    expect(prefs.pinned).toEqual([]);
  });
  it("keeps the history bounded", () => {
    let prefs = EMPTY_PREFS;
    for (let i = 0; i <= HISTORY_LIMIT; i++)
      prefs = recordConnection(prefs, `h${i}`, true, "", i);
    expect(Object.keys(prefs.history)).toHaveLength(HISTORY_LIMIT);
    expect(prefs.history.h0).toBeUndefined();
  });
  it("labels ages and sections", () => {
    expect(ageLabel(now - 10_000, now)).toBe("vừa xong");
    expect(ageLabel(now - 5 * 60_000, now)).toBe("5 phút");
    expect(ageLabel(now - 3 * 3600_000, now)).toBe("3 giờ");
    expect(ageLabel(now - 2 * 86400_000, now)).toBe("2 ngày");
    expect(recentGroup(now - 3600_000, false, now)).toBe("today");
    expect(recentGroup(now - 3 * 86400_000, false, now)).toBe("week");
    expect(recentGroup(now - 30 * 86400_000, false, now)).toBe("older");
    expect(recentGroup(0, true, now)).toBe("pinned");
  });
  it("matches every word in any field", () => {
    expect(matches("root web", "web.example.com", "root")).toBe(true);
    expect(matches("root db", "web.example.com", "root")).toBe(false);
    expect(matches("  ", "x")).toBe(true);
  });
  it("builds rows across workspaces and what needs attention", () => {
    const a = host("a");
    const b = host("b", "", { workspaceId: "w2" });
    const c = host("c", "", { workspaceId: "w2" });
    let prefs = recordConnection(EMPTY_PREFS, "a", true, "", now - 1000);
    prefs = recordConnection(prefs, "b", false, "Từ chối", now - 500);
    prefs = recordConnection(prefs, "c", false, "Timeout", now - 400);
    prefs = togglePin(prefs, "c");
    const sessions = [
      { id: "s1", host: a, status: "connected" },
      { id: "s2", host: c, status: "error", error: "Timeout" },
    ];
    const forwards = {
      "s1:f": { id: "s1:f", sessionId: "s1", status: "error", spec: {} },
      "s1:g": { id: "s1:g", sessionId: "s1", status: "stopped", spec: {} },
      "gone:f": { id: "gone:f", sessionId: "gone", status: "running", spec: {} },
    };
    const transfers = [
      { id: "t1", sessionId: "s1", status: "failed", name: "x" },
      { id: "t2", sessionId: "s1", status: "completed", name: "y" },
    ];
    const all = buildRows(
      { hosts: [a, b, c], sessions, forwards, transfers, prefs, scope: "all" },
      now,
    );
    expect(all.sessions).toHaveLength(2);
    expect(all.forwards.map((f) => f.id)).toEqual(["s1:f"]);
    expect(all.transfers.map((t) => t.id)).toEqual(["t1"]);
    expect(all.recent.map((r) => r.host.id)).toEqual(["c", "b", "a"]);
    // c's failure is shown once, by its session.
    expect(all.attention.map((x) => x.id)).toEqual([
      "session:s2",
      "forward:s1:f",
      "transfer:t1",
      "host:b",
    ]);
    expect(badgeCount(all)).toBe(4);

    const hosts = scopeHosts([a, b, c], "workspace", "w1");
    const mine = buildRows(
      { hosts, sessions, forwards, transfers, prefs, scope: "workspace" },
      now,
    );
    expect(mine.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(mine.attention.map((x) => x.kind)).toEqual(["forward", "transfer"]);
  });
});
