import React, { useState } from "react";
import { modeString, parseMode } from "../lib.js";
import { Button, Field, Modal } from "./ui.jsx";

const groups = [
  ["Chủ sở hữu", 6],
  ["Nhóm", 3],
  ["Người khác", 0],
];
const bits = [
  ["Đọc", 4],
  ["Ghi", 2],
  ["Chạy", 1],
];

/** Changes POSIX permissions of a remote entry (F2). */
export function ChmodModal({ name, mode: initial, close, save }) {
  const [text, setText] = useState(
    (initial & 0o7777).toString(8).padStart(3, "0"),
  );
  const mode = parseMode(text);
  const toggle = (bit) =>
    setText(((mode ?? 0) ^ bit).toString(8).padStart(3, "0"));
  return (
    <Modal title="Đổi quyền" subtitle={`“${name}”`} close={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (mode !== null) save(mode);
        }}
      >
        <div className="form-body">
          <table className="chmod-grid">
            <thead>
              <tr>
                <th />
                {bits.map(([label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([group, shift]) => (
                <tr key={group}>
                  <th>{group}</th>
                  {bits.map(([label, bit]) => (
                    <td key={label}>
                      <input
                        type="checkbox"
                        aria-label={`${group} – ${label}`}
                        checked={mode !== null && !!(mode & (bit << shift))}
                        onChange={() => toggle(bit << shift)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <Field
            label="Dạng số (octal)"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="form-note">
            {mode === null
              ? "Nhập 3–4 chữ số từ 0 đến 7, ví dụ 755."
              : modeString(mode)}
          </p>
        </div>
        <div className="modal-footer">
          <Button type="button" onClick={close}>
            Hủy
          </Button>
          <Button variant="primary" disabled={mode === null}>
            Áp dụng
          </Button>
        </div>
      </form>
    </Modal>
  );
}
