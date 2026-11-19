import React, { useState, useEffect, useRef, useCallback } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { FilePane } from "./FilePane.jsx";
import { NameModal } from "./NameModal.jsx";
import { FolderOpen } from "lucide-react";
import { call, uid, cleanError, isFolder } from "../lib.js";

export function FileManager({ session, home, notify, transfers, showQueue }) {
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
    if (!entry || isFolder(entry))
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
