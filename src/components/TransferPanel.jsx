import React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Download,
  RotateCcw,
  Play,
  Upload,
  X,
} from "lucide-react";
import { size, statuses } from "../lib.js";
import { IconButton } from "./ui.jsx";

const active = (t) => ["running", "queued"].includes(t.status);

function detail(t) {
  if (t.error) return t.error;
  const parts = [];
  if (t.targetName && t.targetName !== t.name) parts.push(`→ ${t.targetName}`);
  if (t.files > 1) parts.push(`${t.filesDone || 0}/${t.files} file`);
  parts.push(`${size(t.bytes || 0)} / ${size(t.total || 0)}`);
  if (t.status === "running" && t.current) parts.push(t.current);
  return parts.join(" · ");
}

/** Transfer queue: progress, cancel, and retry ("Tiếp tục" resumes from partial files). */
export function TransferPanel({ transfers, close, clear, cancel, retry }) {
  const pending = transfers.filter(active).length;
  return (
    <section className="transfer-panel">
      <div className="transfer-heading">
        <strong>
          <ArrowUp size={15} />
          <ArrowDown size={15} />
          Truyền file <span>{pending} đang chờ / đang truyền</span>
        </strong>
        <div className="actions">
          <button className="text-button" onClick={clear}>
            Dọn lịch sử
          </button>
          <IconButton title="Thu gọn" icon={ChevronDown} onClick={close} />
        </div>
      </div>
      <div className="transfer-list">
        {transfers.length ? (
          transfers.map((t) => (
            <div className="transfer-row" key={t.id}>
              {t.direction === "upload" ? (
                <Upload size={17} />
              ) : (
                <Download size={17} />
              )}
              <div className="transfer-name">
                <strong>{t.name}</strong>
                <small title={detail(t)}>{detail(t)}</small>
              </div>
              <div className="progress">
                <div
                  style={{
                    width: `${t.status === "completed" ? 100 : t.total ? Math.min(100, (t.bytes / t.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className={`transfer-status ${t.status}`}>
                {statuses[t.status]}
              </span>
              {active(t) ? (
                <IconButton
                  icon={X}
                  title="Hủy truyền"
                  onClick={() => cancel(t)}
                />
              ) : t.status === "failed" && t.resumable ? (
                <IconButton
                  icon={Play}
                  title="Tiếp tục (giữ phần đã truyền)"
                  onClick={() => retry(t)}
                />
              ) : ["failed", "cancelled"].includes(t.status) ? (
                <IconButton
                  icon={RotateCcw}
                  title="Thử lại"
                  onClick={() => retry(t)}
                />
              ) : (
                <span className="icon-placeholder" />
              )}
            </div>
          ))
        ) : (
          <div className="empty-inline">
            Chưa có file nào được truyền trong phiên làm việc này.
          </div>
        )}
      </div>
    </section>
  );
}
