import React, { useState } from "react";
import {
  save as saveDialog,
  open as openDialog,
} from "@tauri-apps/plugin-dialog";
import {
  ArchiveRestore,
  DatabaseBackup,
  FileKey,
  FolderOpen,
  TriangleAlert,
} from "lucide-react";
import {
  backupFileName,
  call,
  cleanError,
  keyFileName,
  passwordProblem,
} from "../lib.js";
import { Button, Field, Modal } from "./ui.jsx";

/** Exports one private key from the vault to an OpenSSH file (F6). */
export function ExportKeyModal({ keyItem, close, done }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = passphrase
    ? passwordProblem(passphrase, confirmation, 1)
    : null;
  const submit = async (e) => {
    e.preventDefault();
    if (problem) return;
    const path = await saveDialog({
      title: "Lưu private key",
      defaultPath: keyFileName(keyItem),
    });
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      await call("export_key", { keyId: keyItem.id, path, passphrase });
      done(path);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Xuất private key"
      subtitle={`${keyItem.name} · ${keyItem.algorithm}`}
      close={close}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="notice error backup-warning">
            <TriangleAlert size={16} />
            Private key sẽ được ghi ra file ngoài vault. Ai có file này (và
            passphrase, nếu đặt) có thể đăng nhập vào mọi server dùng key này.
          </p>
          <Field
            label="Passphrase cho file (khuyến nghị)"
            type="password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {passphrase && (
            <Field
              label="Nhập lại passphrase"
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          )}
          <p className="form-note">
            {problem ||
              (passphrase
                ? "File OpenSSH được mã hóa bằng passphrase (bcrypt-pbkdf + AES-256)."
                : "Không có passphrase: file chứa private key ở dạng rõ.")}
          </p>
          {error && <p className="notice error">{error}</p>}
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary" icon={FileKey} disabled={busy || !!problem}>
            Chọn nơi lưu…
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Writes an encrypted backup of servers, keys and known hosts (F6). */
export function BackupModal({ close, done }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = passwordProblem(password, confirmation);
  const submit = async (e) => {
    e.preventDefault();
    if (problem) return;
    const path = await saveDialog({
      title: "Lưu file sao lưu",
      defaultPath: backupFileName(),
      filters: [
        { name: "SSH Studio backup", extensions: ["sshstudio-backup"] },
      ],
    });
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      done(await call("create_backup", { path, password }), path);
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Sao lưu workspace"
      subtitle="Server, SSH key, mật khẩu proxy và known hosts"
      close={close}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <p className="form-note">
            File sao lưu được mã hóa AES-256-GCM bằng khóa dẫn xuất từ mật khẩu
            (Argon2id). Mật khẩu SSH và OTP không bao giờ được lưu nên không có
            trong file. Quên mật khẩu này thì không thể khôi phục.
          </p>
          <Field
            label="Mật khẩu sao lưu"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Field
            label="Nhập lại mật khẩu"
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
          {password && problem && <p className="form-note">{problem}</p>}
          {error && <p className="notice error">{error}</p>}
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={DatabaseBackup}
            disabled={busy || !!problem}
          >
            Chọn nơi lưu…
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Opens a backup, previews what it adds and asks about fingerprint conflicts (F6). */
export function RestoreModal({ close, done }) {
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState(null);
  const [replace, setReplace] = useState(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    const picked = await openDialog({
      title: "Chọn file sao lưu",
      multiple: false,
      directory: false,
      filters: [
        { name: "SSH Studio backup", extensions: ["sshstudio-backup"] },
        { name: "Tất cả file", extensions: ["*"] },
      ],
    });
    if (picked) {
      setPath(picked);
      setPreview(null);
      setError("");
    }
  };
  const act = async (fn) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(cleanError(e));
    } finally {
      setBusy(false);
    }
  };
  const inspect = (e) => {
    e.preventDefault();
    act(async () => {
      setPreview(await call("inspect_backup", { path, password }));
      setReplace(new Set());
    });
  };
  const restore = () =>
    act(async () =>
      done(
        await call("restore_backup", {
          path,
          password,
          replace: [...replace],
        }),
      ),
    );
  const toggle = (address) => {
    const next = new Set(replace);
    next.has(address) ? next.delete(address) : next.add(address);
    setReplace(next);
  };
  const conflicts = preview?.knownHosts.conflicts || [];

  return (
    <Modal
      title="Khôi phục từ bản sao lưu"
      subtitle="Gộp vào workspace hiện tại · không xóa dữ liệu đang có"
      close={close}
      wide={conflicts.length > 0}
    >
      {!preview ? (
        <form onSubmit={inspect}>
          <div className="form-body">
            <Field label="File sao lưu">
              <div className="path-picker">
                <input
                  readOnly
                  value={path}
                  placeholder="Chưa chọn file"
                  onClick={choose}
                />
                <Button type="button" icon={FolderOpen} onClick={choose}>
                  Chọn…
                </Button>
              </div>
            </Field>
            <Field
              label="Mật khẩu sao lưu"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="notice error">{error}</p>}
          </div>
          <div className="modal-footer">
            <Button type="button" onClick={close}>
              Hủy
            </Button>
            <Button variant="primary" disabled={busy || !path || !password}>
              Xem trước
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="form-body">
            <p className="form-note">
              Bản sao lưu tạo lúc{" "}
              {new Date(preview.created * 1000).toLocaleString("vi-VN")}
            </p>
            <table className="restore-summary">
              <tbody>
                <tr>
                  <th>Server</th>
                  <td>
                    {preview.hosts.new} mới / {preview.hosts.total}
                  </td>
                </tr>
                <tr>
                  <th>SSH key</th>
                  <td>
                    {preview.keys.new} mới / {preview.keys.total}
                  </td>
                </tr>
                <tr>
                  <th>Known hosts</th>
                  <td>
                    {preview.knownHosts.new} mới / {preview.knownHosts.total}
                    {conflicts.length > 0 &&
                      ` · ${conflicts.length} khác fingerprint`}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="form-note">
              Server và key đã có (cùng id / cùng fingerprint) được giữ nguyên.
            </p>
            {conflicts.length > 0 && (
              <div className="restore-conflicts">
                <p className="notice error backup-warning">
                  <TriangleAlert size={16} />
                  Fingerprint trong bản sao lưu khác với fingerprint đang tin
                  cậy. Chỉ chọn thay khi chắc chắn server đã đổi host key.
                </p>
                {conflicts.map((c) => (
                  <label className="check restore-conflict" key={c.address}>
                    <input
                      type="checkbox"
                      checked={replace.has(c.address)}
                      onChange={() => toggle(c.address)}
                    />
                    <span>
                      <strong>{c.address}</strong>
                      <small className="mono">Hiện tại: {c.current}</small>
                      <small className="mono">Sao lưu: {c.backup}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {error && <p className="notice error">{error}</p>}
          </div>
          <div className="modal-footer">
            <Button type="button" onClick={() => setPreview(null)}>
              Quay lại
            </Button>
            <Button
              variant="primary"
              icon={ArchiveRestore}
              disabled={busy}
              onClick={restore}
            >
              Khôi phục
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
