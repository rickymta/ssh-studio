import React, { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Server,
  Folder,
  FolderOpen,
  File,
  ArrowUp,
  Upload,
  Download,
  Pencil,
  Trash2,
  RefreshCw,
  Monitor,
  LoaderCircle,
  FolderPlus,
  ExternalLink,
  FilePenLine,
  LockKeyhole,
} from "lucide-react";
import { size, isFolder, nextSelection, modeString } from "../lib.js";
import { Button, IconButton } from "./ui.jsx";

export function FilePane({
  side,
  listing,
  selection,
  loading,
  error,
  disabled,
  dropActive,
  dropFolder,
  load,
  select,
  startDrag,
  create,
  rename,
  remove,
  edit,
  chmod,
  transfer,
  canTransfer,
}) {
  const [address, setAddress] = useState(listing.path);
  useEffect(() => setAddress(listing.path), [listing.path]);
  const chosen = selection.selection;
  const single =
    chosen.length === 1
      ? listing.files.find((f) => f.name === chosen[0])
      : null;
  const names = listing.files.map((f) => f.name);
  const pick = (file, e = {}) =>
    select(
      nextSelection(names, chosen, selection.anchor, file.name, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
      }),
    );
  const join = (name) =>
    side === "remote"
      ? listing.path.replace(/\/$/, "") + "/" + name
      : listing.path.replace(/[\\/]$/, "") + "\\" + name;
  return (
    <section
      className={`file-pane ${dropActive && !dropFolder ? "drop-active" : ""}`}
      data-drop-side={disabled ? undefined : side}
      data-drop-path={listing.path}
    >
      <div className="file-pane-title">
        <span>
          {side === "local" ? <Monitor size={17} /> : <Server size={17} />}{" "}
          {side === "local" ? "Máy của bạn" : "Remote server"}
        </span>
        <Button
          disabled={!chosen.length || !canTransfer}
          icon={side === "local" ? Upload : Download}
          onClick={transfer}
        >
          {side === "local" ? "Upload" : "Download"}
          {chosen.length > 1 && ` (${chosen.length})`}
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
          disabled={disabled || chosen.length !== 1}
          onClick={rename}
        />
        <IconButton
          icon={Trash2}
          title="Xóa (cả thư mục con)"
          disabled={disabled || !chosen.length}
          onClick={remove}
        />
        {edit && (
          <IconButton
            icon={FilePenLine}
            title="Sửa file văn bản"
            disabled={disabled || !single || isFolder(single)}
            onClick={() => edit(single)}
          />
        )}
        {chmod && (
          <IconButton
            icon={LockKeyhole}
            title="Đổi quyền (chmod)"
            disabled={disabled || !single || single.link}
            onClick={() => chmod(single)}
          />
        )}
        <span>
          {chosen.length > 1 && `${chosen.length} đã chọn · `}
          {listing.files.length} mục
        </span>
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
          <table
            className="file-table"
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
                e.preventDefault();
                select({ selection: names, anchor: names[0] || null });
              }
            }}
          >
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
                  aria-selected={chosen.includes(file.name)}
                  className={[
                    chosen.includes(file.name) ? "selected" : "",
                    dropFolder === file.name ? "drop-target" : "",
                  ].join(" ")}
                  data-drop-side={isFolder(file) ? side : undefined}
                  data-drop-path={isFolder(file) ? join(file.name) : undefined}
                  data-drop-folder={isFolder(file) ? file.name : undefined}
                  onPointerDown={(e) => {
                    if (
                      e.button === 0 &&
                      !e.ctrlKey &&
                      !e.shiftKey &&
                      !e.metaKey
                    )
                      startDrag(file, e);
                  }}
                  onClick={(e) => pick(file, e)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      pick(file);
                      if (isFolder(file)) load(join(file.name));
                    } else if (e.key === " ") {
                      e.preventDefault();
                      pick(file, { ctrlKey: true });
                    }
                  }}
                  title={
                    side === "remote" && file.mode
                      ? `${file.name} · ${modeString(file.mode)}`
                      : file.name
                  }
                  onDoubleClick={() => {
                    if (isFolder(file)) load(join(file.name));
                    else if (edit) edit(file);
                  }}
                >
                  <td>
                    {file.directory ? (
                      <Folder size={16} className="folder-icon" />
                    ) : file.link ? (
                      <ExternalLink
                        size={16}
                        className={file.targetDirectory ? "folder-icon" : ""}
                      />
                    ) : (
                      <File size={16} />
                    )}
                    <span>{file.name}</span>
                  </td>
                  <td>{isFolder(file) ? "—" : size(file.size)}</td>
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
