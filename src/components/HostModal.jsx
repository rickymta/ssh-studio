import React, { useState } from "react";
import {
  KeyRound,
  Check,
  LoaderCircle,
  LockKeyhole,
  ShieldEllipsis,
  Usb,
} from "lucide-react";
import { uid } from "../lib.js";
import { Button, Modal, Field } from "./ui.jsx";

const methods = [
  ["password", "Password", LockKeyhole],
  ["key", "SSH Key", KeyRound],
  ["agent", "Agent", Usb],
  ["interactive", "MFA / OTP", ShieldEllipsis],
];
const notes = {
  password:
    "Password được hỏi khi kết nối, trừ khi bạn chọn lưu (ở đây hoặc trong hộp thoại đăng nhập). Nếu server yêu cầu thêm mã OTP, SSH Studio sẽ hỏi tiếp.",
  agent:
    "Dùng key trong SSH agent (OpenSSH Agent / Pageant trên Windows, SSH_AUTH_SOCK trên macOS/Linux). Private key không rời khỏi agent.",
  interactive:
    "Keyboard-interactive: hiển thị đúng các câu hỏi của server (password, mã OTP, xác nhận…).",
};
const defaultPorts = { socks5: 1080, http: 3128 };
/** Methods that can use a remembered login password (mirrors `store::remembers_password`). */
const rememberable = (auth) => auth === "password" || auth === "interactive";

export function HostModal({ host, hosts = [], keys, close, save }) {
  const [form, setForm] = useState(() => {
    const base = host || {
      id: uid(),
      name: "",
      host: "",
      port: 22,
      username: "root",
      group: "Servers",
      auth: "password",
      keyId: "",
    };
    return {
      ...base,
      password: "",
      forgetPassword: false,
      jumpHostId: base.jumpHostId || "",
      proxy: {
        kind: "none",
        host: "",
        port: 1080,
        username: "",
        ...(base.proxy || {}),
        password: "",
      },
    };
  });
  const [route, setRoute] = useState(
    form.jumpHostId
      ? "jump"
      : form.proxy.kind && form.proxy.kind !== "none"
        ? "proxy"
        : "direct",
  );
  const [busy, setBusy] = useState(false);
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });
  const proxyField = (key) => ({
    value: form.proxy[key],
    onChange: (e) =>
      setForm({ ...form, proxy: { ...form.proxy, [key]: e.target.value } }),
  });
  const jumpChoices = hosts.filter((h) => h.id !== form.id);
  return (
    <Modal
      title={host ? "Chỉnh sửa server" : "Thêm server"}
      subtitle="Lưu cấu hình và kết nối bất cứ khi nào bạn cần."
      close={close}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const proxy =
            route === "proxy"
              ? {
                  kind: form.proxy.kind === "none" ? "socks5" : form.proxy.kind,
                  host: form.proxy.host.trim(),
                  port: Number(form.proxy.port),
                  username: form.proxy.username.trim(),
                  // Empty keeps the password already in the vault.
                  password: form.proxy.password || undefined,
                }
              : { kind: "none", host: "", port: 0, username: "" };
          const remembers = rememberable(form.auth);
          await save({
            ...form,
            // Empty keeps the remembered password (the backend drops it if the login changed).
            password:
              (remembers && !form.forgetPassword && form.password) || undefined,
            forgetPassword: remembers && form.forgetPassword,
            port: Number(form.port),
            group: form.group.trim() || "Servers",
            jumpHostId: route === "jump" ? form.jumpHostId : "",
            proxy,
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
              {methods.map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  className={form.auth === value ? "selected" : ""}
                  onClick={() => setForm({ ...form, auth: value })}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
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
              {notes[form.auth]}
            </p>
          )}
          {rememberable(form.auth) && (
            <div className="saved-password">
              <Field
                label="Lưu mật khẩu đăng nhập (tùy chọn)"
                type="password"
                autoComplete="new-password"
                disabled={form.forgetPassword}
                placeholder={
                  host?.hasSavedPassword
                    ? "•••••• đã lưu (để trống: giữ nguyên)"
                    : "Để trống: hỏi mỗi lần kết nối"
                }
                {...field("password")}
              />
              {host?.hasSavedPassword && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.forgetPassword}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        forgetPassword: e.target.checked,
                        password: "",
                      })
                    }
                  />
                  Xóa mật khẩu đã lưu (hỏi lại ở lần kết nối sau)
                </label>
              )}
              <small>
                Mã hóa AES-256-GCM trong vault trên máy này, không trả về giao
                diện. Mã OTP không bao giờ được lưu.
              </small>
            </div>
          )}
          <Field label="Kết nối qua">
            <div className="segmented">
              {[
                ["direct", "Trực tiếp"],
                ["jump", "Jump host"],
                ["proxy", "Proxy"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={route === value ? "selected" : ""}
                  onClick={() => setRoute(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {route === "jump" && (
            <Field label="Jump host (ProxyJump)">
              <select required {...field("jumpHostId")}>
                <option value="">Chọn server trung gian</option>
                {jumpChoices.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.username}@{h.host}:{h.port}
                  </option>
                ))}
              </select>
              <small>
                Kết nối và xác thực jump host trước, rồi mở đường hầm tới server
                này. Jump host có thể có jump host riêng.
              </small>
            </Field>
          )}
          {route === "proxy" && (
            <>
              <div className="form-row proxy-row">
                <Field label="Loại proxy">
                  <select
                    value={
                      form.proxy.kind === "none" ? "socks5" : form.proxy.kind
                    }
                    onChange={(e) =>
                      setForm({
                        ...form,
                        proxy: {
                          ...form.proxy,
                          kind: e.target.value,
                          port: defaultPorts[e.target.value],
                        },
                      })
                    }
                  >
                    <option value="socks5">SOCKS5</option>
                    <option value="http">HTTP CONNECT</option>
                  </select>
                </Field>
                <Field
                  label="Địa chỉ proxy"
                  required
                  placeholder="proxy.company.vn"
                  {...proxyField("host")}
                />
                <Field
                  label="Port"
                  type="number"
                  min="1"
                  max="65535"
                  required
                  {...proxyField("port")}
                />
              </div>
              <div className="form-row">
                <Field
                  label="Username proxy (tùy chọn)"
                  autoComplete="off"
                  {...proxyField("username")}
                />
                <Field
                  label="Password proxy"
                  type="password"
                  autoComplete="new-password"
                  disabled={!form.proxy.username}
                  placeholder={
                    form.proxy.hasPassword
                      ? "•••••• (để trống: giữ nguyên)"
                      : ""
                  }
                  {...proxyField("password")}
                />
              </div>
              <p className="form-note">
                <LockKeyhole size={16} />
                Password proxy được mã hóa AES-256-GCM trong vault, không trả về
                giao diện.
              </p>
            </>
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
