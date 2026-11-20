import React, { useEffect, useRef, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import {
  ACTIVITY_DAYS,
  ACTIVITY_MAX,
  clearActivity,
  filterActivity,
  useActivity,
} from "../activity.js";
import { Button, Modal } from "./ui.jsx";

const pad = (n) => String(n).padStart(2, "0");
/** "20/11 13:46:59" in local time. */
const time = (at) => {
  const d = new Date(at);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Activity log window (Ctrl+Shift+L): newest at the bottom, follows new entries. */
export function ActivityModal({ close, confirm }) {
  const entries = useActivity();
  const [level, setLevel] = useState("all");
  const [query, setQuery] = useState("");
  const list = filterActivity(entries, level, query);
  const bottom = useRef();
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [list.length]);
  const errors = entries.filter((e) => e.level === "error").length;
  return (
    <Modal
      title="Nhật ký hoạt động"
      subtitle={`Kết nối, truyền file và thông báo của ứng dụng; lưu ${ACTIVITY_DAYS} ngày (tối đa ${ACTIVITY_MAX} dòng) trên máy này. Không chứa mật khẩu hay mã OTP.`}
      close={close}
      wide
      className="activity-modal"
    >
      <div className="activity-toolbar">
        <div className="segmented small">
          <button
            className={level === "all" ? "selected" : ""}
            onClick={() => setLevel("all")}
          >
            Tất cả <b>{entries.length}</b>
          </button>
          <button
            className={level === "error" ? "selected" : ""}
            onClick={() => setLevel("error")}
          >
            Lỗi <b>{errors}</b>
          </button>
        </div>
        <label className="help-search">
          <Search size={15} />
          <input
            placeholder="Tìm theo nội dung hoặc server…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <Button
          icon={Trash2}
          disabled={!entries.length}
          onClick={async () => {
            if (
              await confirm("Xóa toàn bộ nhật ký hoạt động?", {
                title: "Xóa nhật ký",
                kind: "warning",
              })
            )
              clearActivity();
          }}
        >
          Xóa
        </Button>
      </div>
      <div className="activity-list" role="log">
        {list.map((e) => (
          <div key={e.id} className={`activity-row ${e.level}`}>
            <time>{time(e.at)}</time>
            <i />
            <span>
              {e.source && <b>{e.source}</b>}
              {e.message}
            </span>
          </div>
        ))}
        {!list.length && (
          <p className="help-empty">
            {entries.length
              ? "Không có dòng nào khớp bộ lọc."
              : "Chưa có hoạt động nào."}
          </p>
        )}
        <div ref={bottom} />
      </div>
    </Modal>
  );
}
