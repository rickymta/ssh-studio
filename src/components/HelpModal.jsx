import React, { useEffect, useState } from "react";
import { Copy, Search } from "lucide-react";
import {
  APP_VERSION,
  SHORTCUTS,
  call,
  desktop,
  osLabel,
  writeClipboard,
} from "../lib.js";
import { Modal } from "./ui.jsx";

const REPOSITORY = "https://github.com/rickymta/ssh-studio";

/** A combo such as "Ctrl+Shift+W" as key caps; "…" stays plain text. */
export function Keys({ combo }) {
  if (combo === "…") return <span className="keys-gap">…</span>;
  return (
    <span className="keys">
      {combo.split("+").map((part, i) => (
        <kbd key={i}>{part || "+"}</kbd>
      ))}
    </span>
  );
}

const GUIDE = [
  [
    "Thêm server",
    "Bấm “Thêm server”, chọn cách xác thực (mật khẩu, SSH key, agent hoặc MFA / OTP). Lần đầu kết nối, SSH Studio hỏi xác nhận fingerprint của server.",
  ],
  [
    "Workspace",
    "Gom server theo khách hàng hoặc dự án ở thẻ workspace trên cùng sidebar. Trong mỗi workspace, xếp server vào thư mục (tối đa 3 cấp) ở mục Thư mục của sidebar: kéo thả server hoặc thư mục, hay chuột phải → “Chuyển tới thư mục”. Trang Servers liệt kê theo thư mục, lọc theo trạng thái và kết nối cả thư mục một lần.",
  ],
  [
    "Launchpad",
    "Ctrl+Shift+D hoặc mục Launchpad đầu sidebar: phiên đang mở, server gần đây, port forward, truyền file và những gì cần chú ý của mọi workspace ở một nơi. J / K để chọn, Enter để mở, C để kết nối, P để ghim, phím 1–6 để đổi tab.",
  ],
  [
    "Lưu mật khẩu",
    "Đánh dấu “Lưu mật khẩu” khi đăng nhập để lần sau không phải nhập lại. Mật khẩu được mã hóa AES-256-GCM, khóa nằm trong kho bảo mật của hệ điều hành; mã OTP không bao giờ được lưu.",
  ],
  [
    "Terminal và file",
    "Mỗi phiên có 4 chế độ: Terminal, Files, Chia đôi và Song song. Kéo thanh chia để đổi kích thước, nhấp đúp để đặt lại.",
  ],
  [
    "Chuyển file",
    "Kéo thả giữa hai khung local / remote (hoặc từ Explorer vào khung remote), hay bấm Upload / Download. Tiến độ ở mục “Truyền file” dưới thanh trạng thái; file lỗi có thể tiếp tục.",
  ],
  [
    "Port forwarding",
    "Tab Ports của mỗi phiên. Đánh dấu “Lưu vào server” để forward tự bật mỗi khi kết nối.",
  ],
  [
    "Sao lưu",
    "Trang SSH Keys → Sao lưu tạo file mã hóa bằng mật khẩu riêng, chứa server, key, mật khẩu đã lưu và known hosts để chuyển sang máy khác.",
  ],
];

/** Help window: shortcut cheat sheet, quick guide and About. */
export function HelpModal({ tab: initial = "keys", close }) {
  const [tab, setTab] = useState(initial);
  const [query, setQuery] = useState("");
  const [info, setInfo] = useState(null);
  useEffect(() => {
    if (desktop) call("app_info").then(setInfo, () => {});
  }, []);
  const q = query.trim().toLowerCase();
  const groups = SHORTCUTS.map((g) => ({
    ...g,
    items: g.items.filter(
      (item) =>
        !q ||
        item.label.toLowerCase().includes(q) ||
        item.keys.join(" ").toLowerCase().includes(q),
    ),
  })).filter((g) => g.items.length);
  const tabs = [
    ["keys", "Phím tắt"],
    ["guide", "Hướng dẫn"],
    ["about", "Giới thiệu"],
  ];
  return (
    <Modal
      title="Trợ giúp"
      subtitle="F1 hoặc Ctrl+/ để mở lại cửa sổ này."
      close={close}
      wide
      className="help-modal"
    >
      <div className="help-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="help-body">
        {tab === "keys" && (
          <>
            <label className="help-search">
              <Search size={15} />
              <input
                autoFocus
                placeholder="Lọc phím tắt…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {groups.map((g) => (
              <section key={g.title} className="shortcut-group">
                <h3>{g.title}</h3>
                {g.items.map((item) => (
                  <div key={item.label} className="shortcut-row">
                    <span>{item.label}</span>
                    <span className="shortcut-keys">
                      {item.keys.map((combo, i) => (
                        <React.Fragment key={combo}>
                          {i > 0 &&
                            combo !== "…" &&
                            item.keys[i - 1] !== "…" && (
                              <span className="keys-or">hoặc</span>
                            )}
                          <Keys combo={combo} />
                        </React.Fragment>
                      ))}
                    </span>
                  </div>
                ))}
              </section>
            ))}
            {!groups.length && (
              <p className="help-empty">Không có phím tắt khớp “{query}”.</p>
            )}
          </>
        )}
        {tab === "guide" && (
          <dl className="help-guide">
            {GUIDE.map(([title, text]) => (
              <React.Fragment key={title}>
                <dt>{title}</dt>
                <dd>{text}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
        {tab === "about" && (
          <div className="help-about">
            <strong>SSH Studio</strong>
            <span>Terminal nhiều phiên và SFTP cho mọi server của bạn.</span>
            <dl>
              <dt>Phiên bản</dt>
              <dd>{info?.version || APP_VERSION}</dd>
              <dt>Hệ điều hành</dt>
              <dd>
                {info ? `${osLabel(info.os)} (${info.arch})` : "Trình duyệt"}
              </dd>
              {info && (
                <>
                  <dt>Tauri</dt>
                  <dd>{info.tauri}</dd>
                  <dt>Thư mục dữ liệu</dt>
                  <dd className="copyable">
                    <code>{info.dataDir}</code>
                    <button
                      title="Sao chép đường dẫn"
                      aria-label="Sao chép đường dẫn"
                      onClick={() => writeClipboard(info.dataDir)}
                    >
                      <Copy size={13} />
                    </button>
                  </dd>
                </>
              )}
              <dt>Mã nguồn</dt>
              <dd className="copyable">
                <code>{REPOSITORY}</code>
                <button
                  title="Sao chép liên kết"
                  aria-label="Sao chép liên kết"
                  onClick={() => writeClipboard(REPOSITORY)}
                >
                  <Copy size={13} />
                </button>
              </dd>
              <dt>Giấy phép</dt>
              <dd>MIT</dd>
            </dl>
            <p className="help-note">
              Dữ liệu chỉ nằm trên máy này. Private key, mật khẩu đã lưu và mật
              khẩu proxy được mã hóa AES-256-GCM; nhật ký hoạt động không chứa
              mật khẩu hay mã OTP.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
