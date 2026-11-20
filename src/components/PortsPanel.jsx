import React, { useState } from "react";
import { Cable, Play, Plus, Square, Trash2, TriangleAlert } from "lucide-react";
import {
  call,
  forwardKinds,
  forwardLabel,
  forwardRows,
  isLoopback,
  uid,
} from "../lib.js";
import { Button, Field, IconButton } from "./ui.jsx";

const blank = {
  kind: "local",
  bindHost: "127.0.0.1",
  bindPort: "",
  targetHost: "127.0.0.1",
  targetPort: "",
};
const help = {
  local:
    "Mở cổng trên máy này; mỗi kết nối được server chuyển tới đích (đích tính từ phía server).",
  remote:
    "Server mở cổng; kết nối tới cổng đó được chuyển về đích trên máy này.",
  dynamic:
    "Proxy SOCKS5 trên máy này; ứng dụng (trình duyệt, DB client…) đi ra Internet qua server.",
};
const statusText = {
  running: "Đang chạy",
  stopped: "Đã dừng",
  error: "Lỗi",
};

/** Port forwarding of one session (F5). Saved forwards start automatically on connect. */
export function PortsPanel({
  session,
  savedHost,
  forwards,
  notify,
  saveForwards,
}) {
  const [form, setForm] = useState(blank);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const saved = savedHost?.forwards || [];
  const rows = forwardRows(saved, forwards, session.id);
  const connected = session.status === "connected";
  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm({ ...form, [key]: e.target.value }),
  });

  const start = async (spec) => {
    try {
      await call("start_forward", { sessionId: session.id, spec });
      return true;
    } catch (e) {
      notify(e, true);
      return false;
    }
  };
  const add = async (e) => {
    e.preventDefault();
    const spec = {
      id: uid().slice(0, 8),
      kind: form.kind,
      bindHost: form.bindHost.trim() || "127.0.0.1",
      bindPort: Number(form.bindPort) || 0,
      targetHost: form.kind === "dynamic" ? "" : form.targetHost.trim(),
      targetPort: form.kind === "dynamic" ? 0 : Number(form.targetPort),
    };
    setBusy(true);
    try {
      if (remember && savedHost) await saveForwards([...saved, spec]);
      if (connected) await start(spec);
      setForm({ ...blank, kind: form.kind });
    } catch (e) {
      notify(e, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ports-panel">
      <form className="ports-form" onSubmit={add}>
        <div className="ports-form-row">
          <Field label="Kiểu">
            <select {...field("kind")}>
              {Object.entries(forwardKinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={
              form.kind === "remote" ? "Địa chỉ trên server" : "Lắng nghe tại"
            }
            required
            {...field("bindHost")}
          />
          <Field
            label="Cổng"
            type="number"
            min="0"
            max="65535"
            placeholder="0 = tự chọn"
            {...field("bindPort")}
          />
          {form.kind !== "dynamic" && (
            <>
              <Field
                label={
                  form.kind === "local" ? "Đích (từ server)" : "Đích (máy này)"
                }
                required
                {...field("targetHost")}
              />
              <Field
                label="Cổng đích"
                type="number"
                min="1"
                max="65535"
                required
                {...field("targetPort")}
              />
            </>
          )}
          <Button
            variant="primary"
            icon={Plus}
            disabled={busy || (!connected && !remember)}
          >
            {connected ? "Bắt đầu" : "Lưu"}
          </Button>
        </div>
        <div className="ports-form-notes">
          <span>{help[form.kind]}</span>
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Lưu vào server (tự bật khi kết nối)
          </label>
        </div>
        {!isLoopback(form.bindHost) && (
          <p className="notice error ports-warning">
            <TriangleAlert size={15} />
            Lắng nghe tại {form.bindHost} cho phép máy khác trong mạng dùng
            đường hầm này.
          </p>
        )}
      </form>
      <div className="ports-list">
        {rows.length ? (
          <table className="file-table">
            <thead>
              <tr>
                <th>Kiểu</th>
                <th>Chuyển tiếp</th>
                <th>Kết nối</th>
                <th>Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ spec, saved: isSaved, state }) => {
                const running = state?.status === "running";
                return (
                  <tr key={spec.id}>
                    <td>
                      <Cable size={15} />
                      <span>{forwardKinds[spec.kind]}</span>
                    </td>
                    <td className="mono" title={state?.error || ""}>
                      {forwardLabel(spec, running ? state.boundPort : 0)}
                      {state?.error && (
                        <small className="forward-error">{state.error}</small>
                      )}
                    </td>
                    <td>
                      {state
                        ? `${state.active || 0} / ${state.total || 0}`
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={`forward-status ${state?.status || "idle"}`}
                      >
                        {state ? statusText[state.status] : "Chưa chạy"}
                        {isSaved && " · đã lưu"}
                      </span>
                    </td>
                    <td className="ports-actions">
                      {running ? (
                        <IconButton
                          icon={Square}
                          title="Dừng"
                          onClick={() =>
                            call("stop_forward", { id: state.id }).catch((e) =>
                              notify(e, true),
                            )
                          }
                        />
                      ) : (
                        <IconButton
                          icon={Play}
                          title="Bắt đầu"
                          disabled={!connected}
                          onClick={() => start(spec)}
                        />
                      )}
                      {isSaved && (
                        <IconButton
                          icon={Trash2}
                          title="Xóa khỏi cấu hình server"
                          onClick={() =>
                            saveForwards(
                              saved.filter((s) => s.id !== spec.id),
                            ).catch((e) => notify(e, true))
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-inline">
            Chưa có port forward. Ví dụ: Local 127.0.0.1:5433 → 127.0.0.1:5432
            để mở PostgreSQL của server trên máy này.
          </div>
        )}
      </div>
    </div>
  );
}
