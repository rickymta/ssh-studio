import React, { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { KeyRound, FolderOpen, ShieldCheck, LoaderCircle } from "lucide-react";
import { cleanError } from "../lib.js";
import { Button, Modal, Field } from "./ui.jsx";

export function KeyModal({ mode, close, save }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={mode === "generate" ? "Tạo SSH key" : "Nhập SSH key"}
      subtitle={
        mode === "generate"
          ? "Tạo key Ed25519 và bảo vệ bằng kho mã hóa của hệ điều hành."
          : "Hỗ trợ OpenSSH / PEM. Với .ppk, xuất OpenSSH bằng PuTTYgen."
      }
      close={busy ? () => {} : close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await save({ name, path, passphrase });
          } catch (e) {
            setError(cleanError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-body">
          <Field
            label="Tên key"
            placeholder="Ví dụ: Work laptop"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {mode === "import" && (
            <>
              <Field label="Private key">
                <Button
                  type="button"
                  icon={FolderOpen}
                  onClick={async () => {
                    try {
                      const p = await open({
                        multiple: false,
                        directory: false,
                        title: "Chọn private key OpenSSH / PEM",
                      });
                      if (p) setPath(p);
                    } catch (e) {
                      setError(cleanError(e));
                    }
                  }}
                >
                  {path || "Chọn file private key"}
                </Button>
              </Field>
              <Field
                label="Passphrase (nếu có)"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
              />
            </>
          )}
          <p className="form-note">
            <ShieldCheck size={18} />
            Private key sẽ được mã hóa bằng AES-256-GCM, khóa bảo vệ lưu trong
            Windows Credential Manager.
          </p>
          {error && <div className="inline-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <Button type="button" disabled={busy} onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={busy ? LoaderCircle : KeyRound}
            disabled={busy || (mode === "import" && !path)}
          >
            {busy ? "Đang lưu…" : mode === "generate" ? "Tạo key" : "Nhập key"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
