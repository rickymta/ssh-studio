import React, { useEffect, useMemo, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Folder,
  File,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import {
  call,
  cleanError,
  mirrorTargets,
  size,
  syncDefaults,
  syncRequest,
  syncSelectable,
  syncStates,
} from "../lib.js";
import { Button, Modal } from "./ui.jsx";

const when = (side) =>
  side ? new Date(side.mtime * 1000).toLocaleString("vi-VN") : "—";

/**
 * Compares the current local and remote folders (F3) and synchronises one way through the
 * transfer queue. Nothing is deleted unless "mirror" is turned on and confirmed separately.
 */
export function SyncModal({
  session,
  localDirectory,
  remoteDirectory,
  notify,
  close,
  showQueue,
}) {
  const [direction, setDirection] = useState("upload");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(new Set());
  const [hideSame, setHideSame] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [busy, setBusy] = useState(false);

  const compare = async () => {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      setPreview(
        await call("sync_preview", {
          sessionId: session.id,
          localDirectory,
          remoteDirectory,
        }),
      );
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    compare();
  }, []);
  useEffect(() => {
    if (preview) setChecked(new Set(syncDefaults(preview.entries, direction)));
    setMirror(false);
  }, [preview, direction]);

  const entries = preview?.entries || [];
  const visible = hideSame
    ? entries.filter((e) => e.state !== "same")
    : entries;
  const deletes = useMemo(
    () => (mirror ? mirrorTargets(entries, direction) : []),
    [mirror, entries, direction],
  );
  const request = preview
    ? syncRequest(preview, session.id, direction, checked, mirror)
    : null;
  const bytes = entries
    .filter(
      (e) => checked.has(e.path) && !e.folder && syncSelectable(e, direction),
    )
    .reduce(
      (sum, e) =>
        sum + ((direction === "upload" ? e.local : e.remote)?.size || 0),
      0,
    );
  const toggle = (path) =>
    setChecked((old) => {
      const next = new Set(old);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const start = async () => {
    if (!request || (!request.items.length && !request.delete.length)) return;
    if (
      request.delete.length &&
      !(await confirm(
        `Mirror sẽ XÓA VĨNH VIỄN ${request.delete.length} mục chỉ có ở ${direction === "upload" ? "remote" : "local"} (kể cả nội dung thư mục):\n\n${request.delete.slice(0, 12).join("\n")}${request.delete.length > 12 ? "\n…" : ""}\n\nTiếp tục?`,
        { title: "Xác nhận mirror", kind: "warning" },
      ))
    )
      return;
    setBusy(true);
    try {
      const result = await call("sync_run", { request });
      const parts = [`${result.ids.length} file vào hàng đợi`];
      if (result.folders) parts.push(`tạo ${result.folders} thư mục`);
      const removed = result.deleted.files + result.deleted.folders;
      if (removed) parts.push(`xóa ${removed} mục`);
      notify(`Đồng bộ: ${parts.join(", ")}.`);
      if (result.ids.length) showQueue();
      close();
    } catch (e) {
      notify(e, true);
      setBusy(false);
    }
  };

  const counts = entries.reduce((acc, e) => {
    acc[e.state] = (acc[e.state] || 0) + 1;
    return acc;
  }, {});
  return (
    <Modal
      title="Đồng bộ thư mục"
      subtitle="So sánh theo kích thước và thời gian sửa đổi. Mặc định không xóa gì."
      close={close}
      className="sync-modal"
    >
      <div className="sync-bar">
        <code title={localDirectory}>{localDirectory}</code>
        <div className="segmented" role="radiogroup" aria-label="Chiều đồng bộ">
          <button
            role="radio"
            aria-checked={direction === "upload"}
            className={direction === "upload" ? "selected" : ""}
            onClick={() => setDirection("upload")}
          >
            <ArrowRight size={14} /> Local → Remote
          </button>
          <button
            role="radio"
            aria-checked={direction === "download"}
            className={direction === "download" ? "selected" : ""}
            onClick={() => setDirection("download")}
          >
            <ArrowLeft size={14} /> Remote → Local
          </button>
        </div>
        <code title={remoteDirectory}>{remoteDirectory}</code>
        <Button
          type="button"
          icon={RefreshCw}
          disabled={busy}
          onClick={compare}
        >
          So sánh lại
        </Button>
      </div>
      <div className="sync-summary">
        {Object.entries(syncStates)
          .filter(([state]) => counts[state])
          .map(([state, label]) => (
            <span key={state} className={`sync-state ${state}`}>
              {label}: {counts[state]}
            </span>
          ))}
        {preview?.skippedLinks > 0 && (
          <span>Bỏ qua {preview.skippedLinks} symlink thư mục</span>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={hideSame}
            onChange={(e) => setHideSame(e.target.checked)}
          />
          Ẩn mục giống nhau
        </label>
      </div>
      <div className="sync-list">
        {error ? (
          <div className="file-error">{error}</div>
        ) : !preview ? (
          <div className="empty-inline">
            <LoaderCircle size={20} className="spin" /> Đang so sánh…
          </div>
        ) : !visible.length ? (
          <div className="empty-inline">Hai thư mục đã giống nhau.</div>
        ) : (
          <table className="file-table">
            <thead>
              <tr>
                <th />
                <th>Đường dẫn</th>
                <th>Trạng thái</th>
                <th>Local</th>
                <th>Remote</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e) => {
                const selectable = syncSelectable(e, direction);
                const doomed = deletes.some(
                  (d) => e.path === d || e.path.startsWith(d + "/"),
                );
                return (
                  <tr key={e.path} className={doomed ? "doomed" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Đồng bộ ${e.path}`}
                        disabled={!selectable}
                        checked={selectable && checked.has(e.path)}
                        onChange={() => toggle(e.path)}
                      />
                    </td>
                    <td title={e.path}>
                      {e.folder ? (
                        <Folder size={15} className="folder-icon" />
                      ) : (
                        <File size={15} />
                      )}
                      <span>{e.path}</span>
                    </td>
                    <td>
                      <span className={`sync-state ${e.state}`}>
                        {doomed ? "Sẽ xóa" : syncStates[e.state]}
                      </span>
                    </td>
                    <td>
                      {e.local && !e.folder
                        ? `${size(e.local.size)} · ${when(e.local)}`
                        : e.local
                          ? "thư mục"
                          : "—"}
                    </td>
                    <td>
                      {e.remote && !e.folder
                        ? `${size(e.remote.size)} · ${when(e.remote)}`
                        : e.remote
                          ? "thư mục"
                          : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="modal-footer sync-footer">
        <label className="check danger">
          <input
            type="checkbox"
            checked={mirror}
            disabled={!preview}
            onChange={(e) => setMirror(e.target.checked)}
          />
          Mirror: xóa mục chỉ có ở {direction === "upload" ? "remote" : "local"}
          {mirror && ` (${deletes.length})`}
        </label>
        <span>
          {request
            ? `${request.items.filter((i) => !i.folder).length} file · ${size(bytes)}`
            : ""}
        </span>
        <Button type="button" onClick={close}>
          Hủy
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={
            busy ||
            !request ||
            (!request.items.length && !request.delete.length)
          }
          onClick={start}
        >
          Đồng bộ
        </Button>
      </div>
    </Modal>
  );
}
