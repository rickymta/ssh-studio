import React, { useEffect, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { defaultSettings } from "../lib.js";
import { Button, Field } from "./ui.jsx";

const cursorStyles = {
  block: "Khối",
  bar: "Thanh dọc",
  underline: "Gạch dưới",
};
const views = { terminal: "Terminal", files: "Files", split: "Chia đôi" };
export const shortcutList = [
  ["Ctrl+Tab / Ctrl+Shift+Tab", "Chuyển phiên kế tiếp / trước"],
  ["Ctrl+1 … Ctrl+9", "Mở phiên thứ 1 … 9"],
  ["Ctrl+Shift+W", "Đóng phiên đang xem"],
  ["Ctrl+Shift+T", "Mở lại server vừa đóng"],
  ["Ctrl+Shift+F", "Tìm trong terminal (Enter / Shift+Enter: sau / trước)"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "Tăng / giảm / đặt lại cỡ chữ terminal"],
  ["Ctrl+K (Ctrl+Shift+K trong terminal)", "Tìm server"],
  ["Ctrl+Shift+C / Ctrl+Shift+V", "Sao chép / dán trong terminal"],
];

/** Preferences stored in workspace.json `settings` (F7). */
export function SettingsPage({ settings, save }) {
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  // Follow saved changes (e.g. zoom shortcuts) but not mere re-renders of the app, which
  // rebuild the settings object and would otherwise wipe what is being edited.
  const saved = JSON.stringify(settings);
  useEffect(() => setDraft(settings), [saved]);
  const dirty = JSON.stringify(draft) !== saved;
  const set = (key, parse = (v) => v) => ({
    value: draft[key],
    onChange: (e) => setDraft({ ...draft, [key]: parse(e.target.value) }),
  });
  const check = (key) => ({
    checked: !!draft[key],
    onChange: (e) => setDraft({ ...draft, [key]: e.target.checked }),
  });
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await save(draft);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="page">
      <form onSubmit={submit}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">TÙY CHỈNH</div>
            <h1>Cài đặt</h1>
            <p>Lưu cùng workspace trên máy này. Áp dụng ngay cho các phiên.</p>
          </div>
          <div className="actions">
            <Button
              type="button"
              icon={RotateCcw}
              onClick={() => setDraft(defaultSettings)}
            >
              Mặc định
            </Button>
            <Button variant="primary" icon={Save} disabled={busy || !dirty}>
              Lưu thay đổi
            </Button>
          </div>
        </div>
        <div className="settings-grid">
          <fieldset className="settings-section">
            <legend>Terminal</legend>
            <Field label="Font chữ" {...set("fontFamily")} />
            <div className="form-row">
              <Field
                label="Cỡ chữ (8–32)"
                type="number"
                min="8"
                max="32"
                {...set("fontSize", Number)}
              />
              <Field
                label="Giãn dòng (1.0–2.0)"
                type="number"
                min="1"
                max="2"
                step="0.05"
                {...set("lineHeight", Number)}
              />
            </div>
            <div className="form-row">
              <Field
                label="Số dòng lưu lại (scrollback)"
                type="number"
                min="500"
                max="100000"
                step="500"
                {...set("scrollback", Number)}
              />
              <Field label="Con trỏ">
                <select {...set("cursorStyle")}>
                  {Object.entries(cursorStyles).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="check">
              <input type="checkbox" {...check("cursorBlink")} />
              Con trỏ nhấp nháy
            </label>
            <label className="check">
              <input type="checkbox" {...check("copyOnSelect")} />
              Tự sao chép khi bôi đen (copy-on-select)
            </label>
            <div
              className="settings-preview mono"
              style={{
                fontFamily: draft.fontFamily,
                fontSize: `${draft.fontSize}px`,
                lineHeight: draft.lineHeight,
              }}
            >
              deploy@web-01:~$ tail -f /var/log/nginx/access.log
            </div>
          </fieldset>
          <fieldset className="settings-section">
            <legend>Phiên &amp; cửa sổ</legend>
            <Field label="Chế độ xem khi mở phiên mới">
              <select {...set("defaultView")}>
                {Object.entries(views).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" {...check("confirmClose")} />
              Hỏi xác nhận khi đóng phiên đang kết nối hoặc thoát lúc còn việc
            </label>
            <label className="check">
              <input type="checkbox" {...check("closeToTray")} />
              Đóng cửa sổ thì thu về khay hệ thống (phiên vẫn chạy)
            </label>
            <p className="form-note">
              Khi thu về khay: nhấp biểu tượng SSH Studio ở khay để mở lại, chọn
              “Thoát SSH Studio” trong menu khay để thoát hẳn.
            </p>
          </fieldset>
          <fieldset className="settings-section settings-shortcuts">
            <legend>Phím tắt</legend>
            <table>
              <tbody>
                {shortcutList.map(([keys, action]) => (
                  <tr key={keys}>
                    <td>
                      <kbd>{keys}</kbd>
                    </td>
                    <td>{action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="form-note">
              Ctrl+C, Ctrl+V, Ctrl+W và các phím khác của shell luôn được gửi
              tới server.
            </p>
          </fieldset>
        </div>
      </form>
    </section>
  );
}
