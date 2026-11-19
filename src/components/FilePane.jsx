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
} from "lucide-react";
import { size } from "../lib.js";
import { Button, IconButton } from "./ui.jsx";

export function FilePane({
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
