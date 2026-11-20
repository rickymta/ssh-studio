import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { WORKSPACE_COLORS, cleanError, workspaceInitial } from "../lib.js";
import { Button, Field, Modal } from "./ui.jsx";

export function WorkspaceAvatar({ workspace, size = 28 }) {
  const color = WORKSPACE_COLORS[workspace.color] || WORKSPACE_COLORS.mint;
  return (
    <span
      className="avatar"
      style={{
        width: size,
        height: size,
        color,
        borderColor: `${color}66`,
        background: `${color}1f`,
      }}
    >
      {workspaceInitial(workspace.name)}
    </span>
  );
}

/**
 * Sidebar card showing the active workspace; opens a menu to switch, create or edit one.
 * `view` comes from `workspaceView(data)`.
 */
export function WorkspaceSwitcher({ view, activate, edit }) {
  const [open, setOpen] = useState(false);
  const root = useRef();
  useEffect(() => {
    if (!open) return;
    const away = (e) => !root.current?.contains(e.target) && setOpen(false);
    const escape = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const { active, workspaces, counts } = view;
  return (
    <div className="workspace-switcher" ref={root}>
      <button
        className="workspace-label"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Đổi workspace"
        onClick={() => setOpen(!open)}
      >
        <WorkspaceAvatar workspace={active} />
        <div>
          {active.name}
          <small>{counts[active.id] || 0} server</small>
        </div>
        <ChevronsUpDown size={15} />
      </button>
      {open && (
        <div className="workspace-menu" role="menu">
          <div className="workspace-menu-title">WORKSPACE</div>
          {workspaces.map((w) => (
            <div
              key={w.id}
              className={`workspace-item ${w.id === active.id ? "active" : ""}`}
            >
              <button
                role="menuitemradio"
                aria-checked={w.id === active.id}
                onClick={() => {
                  setOpen(false);
                  if (w.id !== active.id) activate(w.id);
                }}
              >
                <WorkspaceAvatar workspace={w} size={24} />
                <span>{w.name}</span>
                <small>{counts[w.id] || 0}</small>
                {w.id === active.id && <Check size={14} />}
              </button>
              <button
                className="workspace-edit"
                title={`Sửa “${w.name}”`}
                aria-label={`Sửa workspace ${w.name}`}
                onClick={() => {
                  setOpen(false);
                  edit(w);
                }}
              >
                <Pencil size={13} />
              </button>
            </div>
          ))}
          <button
            className="workspace-new"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              edit(null);
            }}
          >
            <Plus size={15} />
            Tạo workspace mới
          </button>
        </div>
      )}
    </div>
  );
}

/** Creates (`workspace` null) or edits a workspace; editing also offers deletion. */
export function WorkspaceModal({ workspace, view, close, save, remove }) {
  const [name, setName] = useState(workspace?.name || "");
  const [color, setColor] = useState(workspace?.color || "mint");
  const others = view.workspaces.filter((w) => w.id !== workspace?.id);
  const [moveTo, setMoveTo] = useState(others[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const servers = workspace ? view.counts[workspace.id] || 0 : 0;
  const attempt = async (action) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={workspace ? "Sửa workspace" : "Workspace mới"}
      subtitle="Gom các server theo khách hàng, dự án hoặc môi trường. Mỗi server thuộc một workspace."
      close={busy ? () => {} : close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          attempt(() => save({ id: workspace?.id || "", name, color }));
        }}
      >
        <div className="form-body">
          <Field
            label="Tên workspace"
            placeholder="Ví dụ: Khách hàng A, Homelab"
            required
            autoFocus
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field label="Màu">
            <div className="color-swatches" role="radiogroup">
              {Object.entries(WORKSPACE_COLORS).map(([key, value]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={color === key}
                  aria-label={key}
                  className={color === key ? "selected" : ""}
                  style={{ background: value }}
                  onClick={() => setColor(key)}
                />
              ))}
            </div>
          </Field>
          {workspace && (
            <div className="workspace-danger">
              <strong>Xóa workspace</strong>
              {others.length ? (
                <>
                  <p>
                    {servers
                      ? `${servers} server sẽ được chuyển sang workspace khác.`
                      : "Workspace này chưa có server nào."}
                  </p>
                  <div className="workspace-danger-row">
                    {servers > 0 && (
                      <select
                        aria-label="Chuyển server sang"
                        value={moveTo}
                        onChange={(e) => setMoveTo(e.target.value)}
                      >
                        {others.map((w) => (
                          <option key={w.id} value={w.id}>
                            Chuyển sang {w.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <Button
                      type="button"
                      variant="danger"
                      icon={Trash2}
                      disabled={busy}
                      onClick={() => attempt(() => remove(workspace, moveTo))}
                    >
                      Xóa
                    </Button>
                  </div>
                </>
              ) : (
                <p>Cần giữ lại ít nhất một workspace.</p>
              )}
            </div>
          )}
          {error && <div className="inline-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <Button type="button" disabled={busy} onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={busy ? LoaderCircle : workspace ? Check : Plus}
            disabled={busy || !name.trim()}
          >
            {workspace ? "Lưu" : "Tạo workspace"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
