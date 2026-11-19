import React, { useState } from "react";
import { KeyRound, Check, LoaderCircle, LockKeyhole } from "lucide-react";
import { uid } from "../lib.js";
import { Button, Modal, Field } from "./ui.jsx";

export function HostModal({ host, keys, close, save }) {
  const [form, setForm] = useState(
    host || {
      id: uid(),
      name: "",
      host: "",
      port: 22,
      username: "root",
      group: "Servers",
      auth: "password",
      keyId: "",
    },
  );
  const [busy, setBusy] = useState(false);
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });
  return (
    <Modal
      title={host ? "Chỉnh sửa server" : "Thêm server"}
      subtitle="Lưu cấu hình và kết nối bất cứ khi nào bạn cần."
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await save({
            ...form,
            port: Number(form.port),
            group: form.group.trim() || "Servers",
          });
          setBusy(false);
        }}
      >
        <div className="form-body">
          <Field
            label="Tên hiển thị"
            placeholder="Ví dụ: Production API"
            required
            autoFocus
            {...field("name")}
          />
          <div className="form-row address-row">
            <Field
              label="Địa chỉ server"
              placeholder="192.168.1.10 hoặc server.example.com"
              required
              {...field("host")}
            />
            <Field
              label="Port"
              type="number"
              min="1"
              max="65535"
              required
              {...field("port")}
            />
          </div>
          <div className="form-row">
            <Field label="Username" required {...field("username")} />
            <Field
              label="Nhóm"
              placeholder="Production, Staging…"
              {...field("group")}
            />
          </div>
          <Field label="Phương thức xác thực">
            <div className="segmented">
              <button
                type="button"
                className={form.auth === "password" ? "selected" : ""}
                onClick={() => setForm({ ...form, auth: "password" })}
              >
                <LockKeyhole size={16} />
                Password
              </button>
              <button
                type="button"
                className={form.auth === "key" ? "selected" : ""}
                onClick={() => setForm({ ...form, auth: "key" })}
              >
                <KeyRound size={16} />
                SSH Key
              </button>
            </div>
          </Field>
          {form.auth === "key" ? (
            <Field label="SSH key">
              <select required {...field("keyId")}>
                <option value="">Chọn key từ thư viện</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.algorithm}
                  </option>
                ))}
              </select>
              {!keys.length && (
                <small>
                  Đóng hộp thoại và vào SSH Keys để nhập hoặc tạo key trước.
                </small>
              )}
            </Field>
          ) : (
            <p className="form-note">
              <LockKeyhole size={16} />
              Password được hỏi khi kết nối và không lưu xuống ổ đĩa.
            </p>
          )}
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button
            variant="primary"
            icon={busy ? LoaderCircle : Check}
            disabled={busy}
          >
            Lưu server
          </Button>
        </div>
      </form>
    </Modal>
  );
}
