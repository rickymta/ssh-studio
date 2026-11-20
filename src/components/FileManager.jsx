import React, { useState, useEffect, useRef, useCallback } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { FilePane } from "./FilePane.jsx";
import { NameModal } from "./NameModal.jsx";
import { ConflictModal } from "./ConflictModal.jsx";
import { EditorModal } from "./EditorModal.jsx";
import { ChmodModal } from "./ChmodModal.jsx";
import { SyncModal } from "./SyncModal.jsx";
import { Splitter, useLayout } from "./layout.jsx";
import { FolderOpen, FolderSync } from "lucide-react";
import {
  call,
  uid,
  cleanError,
  deleteSummary,
  desktop,
  planConflicts,
  splitPath,
} from "../lib.js";

const emptySelection = { selection: [], anchor: null };

export function FileManager({ session, home, notify, transfers, showQueue }) {
  const [local, setLocal] = useState({ path: home, parent: home, files: [] });
  const [remote, setRemote] = useState({ path: ".", parent: ".", files: [] });
  const [selected, setSelected] = useState({
    local: emptySelection,
    remote: emptySelection,
  });
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [editing, setEditing] = useState(null);
  const [chmodEntry, setChmodEntry] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [drag, setDrag] = useState(null);
  const [dropHover, setDropHover] = useState(false);
  const root = useRef(null);
  const layout = useLayout();
  const paths = useRef({ local: home, remote: "." });
  const revisions = useRef({ local: 0, remote: 0 });
  const connected = session.status === "connected";
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
        if (paths.current[side] !== result.path)
          setSelected((old) => ({ ...old, [side]: emptySelection }));
        paths.current[side] = result.path;
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
    if (connected) load("remote", ".");
  }, [session.status]);
  const finished = transfers.filter(
    (t) =>
      t.sessionId === session.id &&
      ["completed", "failed", "cancelled"].includes(t.status),
  ).length;
  useEffect(() => {
    if (finished) {
      load("local", paths.current.local);
      if (connected) load("remote", paths.current.remote);
    }
  }, [finished]);

  const entries = (side) => {
    const listing = side === "local" ? local : remote;
    const names = selected[side].selection;
    return listing.files.filter((f) => names.includes(f.name));
  };
  const action = async (side, type, value) => {
    try {
      const entry = entries(side)[0];
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
  const remove = async (side) => {
    const names = entries(side).map((f) => f.name);
    if (!names.length) return;
    const request = {
      sessionId: side === "remote" ? session.id : null,
      directory: paths.current[side],
      names,
    };
    try {
      const counted = await call("delete_entries", {
        ...request,
        countOnly: true,
      });
      const label =
        names.length === 1 ? `“${names[0]}”` : `${names.length} mục đã chọn`;
      const detail = counted.folders ? ` (gồm ${deleteSummary(counted)})` : "";
      if (
        !(await confirm(
          `Xóa vĩnh viễn ${label}${detail}? Không thể hoàn tác.`,
          { title: "Xóa", kind: "warning" },
        ))
      )
        return;
      const deleted = await call("delete_entries", {
        ...request,
        countOnly: false,
      });
      notify(`Đã xóa ${deleteSummary(deleted)}.`);
    } catch (e) {
      notify(e, true);
    }
    await load(side, paths.current[side]);
  };
  const remotePath = (name) =>
    paths.current.remote.replace(/\/$/, "") + "/" + name;
  const applyChmod = async (mode) => {
    try {
      await call("chmod", {
        sessionId: session.id,
        directory: paths.current.remote,
        name: chmodEntry.name,
        mode,
      });
      setChmodEntry(null);
      await load("remote", paths.current.remote);
    } catch (e) {
      notify(e, true);
    }
  };

  /** Transfers `items` ({directory, name}) to `toDirectory` on the other side. */
  const send = async (direction, items, toDirectory) => {
    if (!items.length) return;
    if (!connected)
      return notify("Kết nối server trước khi truyền file.", true);
    const to = direction === "upload" ? "remote" : "local";
    let existing;
    try {
      existing = (
        await call("list_files", {
          sessionId: to === "remote" ? session.id : null,
          directory: toDirectory,
        })
      ).files.map((f) => (to === "local" ? f.name.toLowerCase() : f.name));
    } catch (e) {
      return notify(e, true);
    }
    const key = (name) => (to === "local" ? name.toLowerCase() : name);
    const byKey = new Map(items.map((item) => [key(item.name), item]));
    const plan = await planConflicts(
      [...byKey.keys()],
      existing,
      (k) =>
        new Promise((resolve) =>
          setConflict({
            name: byKey.get(k).name,
            side: to,
            resolve: (answer) => {
              setConflict(null);
              resolve(answer);
            },
          }),
        ),
    );
    if (!plan) return;
    let sent = 0;
    for (const { name: k, conflict } of plan) {
      const item = byKey.get(k);
      try {
        await call("transfer", {
          request: {
            id: uid(),
            sessionId: session.id,
            direction,
            localDirectory:
              direction === "upload" ? item.directory : toDirectory,
            remoteDirectory:
              direction === "upload" ? toDirectory : item.directory,
            name: item.name,
            conflict,
          },
        });
        sent++;
      } catch (e) {
        notify(`${item.name}: ${cleanError(e)}`, true);
      }
    }
    if (sent) showQueue();
  };
  const transferSelection = (side, toDirectory) =>
    send(
      side === "local" ? "upload" : "download",
      entries(side).map((f) => ({
        directory: paths.current[side],
        name: f.name,
      })),
      toDirectory ?? paths.current[side === "local" ? "remote" : "local"],
    );

  // Dragging rows between the panes uses pointer events: the webview's native drag-drop
  // handler (needed for files dropped from Explorer) swallows HTML5 drag events.
  const startDrag = (side, file, e) => {
    if (e.button !== 0) return;
    const origin = { x: e.clientX, y: e.clientY };
    const names = selected[side].selection.includes(file.name)
      ? selected[side].selection
      : [file.name];
    let active = false;
    const target = (ev) =>
      document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest?.("[data-drop-side]");
    const move = (ev) => {
      if (
        !active &&
        Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < 6
      )
        return;
      if (!active) {
        active = true;
        if (!selected[side].selection.includes(file.name))
          setSelected((old) => ({
            ...old,
            [side]: { selection: [file.name], anchor: file.name },
          }));
      }
      const over = target(ev);
      setDrag({
        side,
        count: names.length,
        x: ev.clientX,
        y: ev.clientY,
        over:
          over && over.dataset.dropSide !== side
            ? over.dataset.dropFolder || over.dataset.dropSide
            : null,
      });
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (!active) return;
      const over = target(ev);
      if (!over || over.dataset.dropSide === side) return;
      const destination = over.dataset.dropPath;
      send(
        side === "local" ? "upload" : "download",
        names.map((name) => ({ directory: paths.current[side], name })),
        destination,
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Files dropped from Explorer / Finder onto the remote pane are uploaded.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!desktop) return;
    let off;
    let disposed = false;
    const remoteTarget = (position) => {
      const scale = window.devicePixelRatio || 1;
      const el = document
        .elementFromPoint(position.x / scale, position.y / scale)
        ?.closest?.('[data-drop-side="remote"]');
      return el && root.current?.contains(el) ? el : null;
    };
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          if (payload.type === "over" || payload.type === "enter")
            setDropHover(!!remoteTarget(payload.position));
          else if (payload.type === "leave") setDropHover(false);
          else if (payload.type === "drop") {
            setDropHover(false);
            const el = remoteTarget(payload.position);
            if (!el || !payload.paths?.length) return;
            sendRef.current(
              "upload",
              payload.paths.map(splitPath).filter((p) => p.name),
              el.dataset.dropPath,
            );
          }
        })
        .then((unlisten) => (disposed ? unlisten() : (off = unlisten))),
    );
    return () => {
      disposed = true;
      off?.();
    };
  }, []);

  return (
    <div className="file-manager" ref={root}>
      <div className="file-hint">
        <FolderOpen size={14} />
        Hai khung local / remote
        <span>
          Ctrl/Shift để chọn nhiều · Kéo thả giữa hai khung hoặc từ Explorer vào
          remote
        </span>
        <button
          className="text-button"
          disabled={!connected || !!errors.remote || !!errors.local}
          title="So sánh và đồng bộ hai thư mục đang mở"
          onClick={() => setSyncing(true)}
        >
          <FolderSync size={13} /> Đồng bộ
        </button>
      </div>
      <div className="file-panes">
        {["local", "remote"].map((side) => {
          const listing = side === "local" ? local : remote;
          const disabled = side === "remote" && !connected;
          const chosen = entries(side);
          return (
            <React.Fragment key={side}>
              {side === "remote" && (
                <Splitter field="panes" vertical label="Độ rộng khung local" />
              )}
              <FilePane
                style={
                  side === "local"
                    ? { flex: `0 0 ${layout.panes * 100}%` }
                    : undefined
                }
                side={side}
                listing={listing}
                selection={selected[side]}
                loading={loading[side]}
                error={errors[side]}
                disabled={disabled}
                dropActive={
                  (drag && drag.over && drag.side !== side) ||
                  (side === "remote" && dropHover)
                }
                dropFolder={drag && drag.side !== side ? drag.over : null}
                load={(directory) => load(side, directory)}
                select={(next) =>
                  setSelected((old) => ({ ...old, [side]: next }))
                }
                startDrag={(file, e) => startDrag(side, file, e)}
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
                    value: chosen[0].name,
                  })
                }
                remove={() => remove(side)}
                edit={
                  side === "remote"
                    ? (file) => setEditing(remotePath(file.name))
                    : undefined
                }
                chmod={side === "remote" ? setChmodEntry : undefined}
                transfer={() => transferSelection(side)}
                canTransfer={connected && !errors.remote && !errors.local}
              />
            </React.Fragment>
          );
        })}
      </div>
      {drag && (
        <div
          className="drag-ghost"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.count === 1 ? "1 mục" : `${drag.count} mục`} →{" "}
          {drag.side === "local" ? "remote" : "local"}
        </div>
      )}
      {dialog && (
        <NameModal
          {...dialog}
          close={() => setDialog(null)}
          save={(value) => action(dialog.side, dialog.type, value)}
        />
      )}
      {conflict && <ConflictModal {...conflict} />}
      {editing && (
        <EditorModal
          session={session}
          path={editing}
          notify={notify}
          close={() => {
            setEditing(null);
            load("remote", paths.current.remote);
          }}
        />
      )}
      {syncing && (
        <SyncModal
          session={session}
          localDirectory={paths.current.local}
          remoteDirectory={paths.current.remote}
          notify={notify}
          showQueue={showQueue}
          close={() => setSyncing(false)}
        />
      )}
      {chmodEntry && (
        <ChmodModal
          name={chmodEntry.name}
          mode={chmodEntry.mode || 0o644}
          close={() => setChmodEntry(null)}
          save={applyChmod}
        />
      )}
    </div>
  );
}
