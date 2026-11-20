# SSH Studio — Hiện trạng & lộ trình hoàn thiện

> Tài liệu bàn giao, lập ngày 2026-11-19 trên commit `ccfbdd9` (Initial commit, v0.1.0).
> Chưa có thay đổi mã nguồn nào ngoài file này.
>
> **Cập nhật 2026-11-20 — v0.2 (nhánh `feature/v0.2-completion`)**: B1–B13 và F1–F7 đã làm, F8 chỉ
> chuẩn bị cấu hình + tài liệu. Trạng thái từng mục ghi ngay tại mục đó; tổng hợp ở §6.

## 0. Hiện trạng kiểm tra

| Hạng mục | Kết quả |
| --- | --- |
| Toolchain | Node 22.18, npm 10.9, Rust/Cargo 1.100 (MSVC). Có Docker 29.9 để dựng OpenSSH server thật khi test. |
| `npm test` (`cargo test`) | **4/4 pass**: `names_cannot_escape_directory`, `vault_detects_tampering`, `snapshot_never_exposes_private_key`, `simultaneous_sessions_sftp_roundtrip_and_host_key_rejection`. |
| `npm run build` / chạy app | Chưa chạy trong đợt này. |
| Kiểm thử UI đầu-cuối | Chưa làm. |

Stack: Tauri 2.12 · Rust 2024 · russh 0.65.2 · russh-sftp 3.0.1 · ssh-key 0.7.0-rc.12 · keyring 4.2 · React 19 · xterm.js 5.5 · Vite 6.

## 1. Tính năng đã có (v0.1.0)

### 1.1 Server
- CRUD server (tên, host, port, username, nhóm, auth `password`/`key`, `keyId`) — `save_host`, `delete_host` (`src-tauri/src/main.rs`).
- Tìm theo tên/IP/username, lọc nhóm ở sidebar + dropdown (`src/main.jsx` `App`).

### 1.2 Phiên SSH & terminal
- Nhiều phiên song song, kể cả cùng một server; tab + danh sách phiên ở sidebar.
- PTY `xterm-256color`, ANSI, resize (FitAddon), scrollback 10.000; giữ trạng thái khi đổi tab.
- Keepalive 15 s × 3. Chế độ xem Terminal / Files / Chia đôi.
- Hỏi xác nhận khi đóng phiên và khi đóng cửa sổ lúc còn phiên/transfer.

### 1.3 File (SFTP)
- Hai khung local/remote: duyệt, lên thư mục cha, nhập đường dẫn, chọn thư mục local bằng dialog, làm mới.
- Tạo thư mục, đổi tên (chặn trùng), xóa file/thư mục rỗng; `safe_name` chặn path traversal.
- Upload/Download **từng file**, tiến độ, hàng đợi 2 slot (`Semaphore`), hủy; ghi `.part` rồi publish không ghi đè.

### 1.4 SSH keys
- Nhập OpenSSH/PEM (có/không passphrase, ≤ 1 MB), tạo Ed25519, sao chép public key, chặn trùng fingerprint, chặn xóa key đang dùng.
- Vault: AES-256-GCM, master key trong Windows Credential Manager (`dev.sshstudio.desktop` / `vault-master-key`); `snapshot` không trả private key.

### 1.5 Known hosts
- Xác nhận SHA256 fingerprint lần đầu (timeout 120 s), chặn khi host key đổi, trang Known Hosts để quên host.

## 2. Lỗi / điểm yếu đã phát hiện (cần sửa trước)

| # | Mô tả | Vị trí | Hướng sửa | Trạng thái |
| --- | --- | --- | --- | --- |
| B1 | "Kết nối lại" mở **tab mới**, tab lỗi/đã đóng cũ vẫn nằm lại. | `src/main.jsx:831` | Reconnect tái dùng `session.id` (TerminalView giữ nguyên), reset status về `connecting`. | ✅ `09fdd00` |
| B2 | Download publish bằng `hard_link` → lỗi trên FAT/exFAT/USB/ổ mạng không hỗ trợ hard link. | `src-tauri/src/files.rs:309` | Fallback: nếu `hard_link` lỗi `Unsupported`/`PermissionDenied`, kiểm tra không tồn tại rồi `rename`. | ✅ `09fdd00` |
| B3 | `workspace.json` hỏng → app không khởi động (`expect` panic). | `store.rs:60`, `main.rs:278,307` | Đổi tên file hỏng thành `workspace.json.corrupt-<timestamp>`, khởi động rỗng, báo cho frontend qua cờ trong snapshot. | ✅ `09fdd00` |
| B4 | Output terminal gửi dạng mảng số JSON → chậm khi output lớn (`cat` file lớn). | `ssh.rs:181` | Gửi base64 (hoặc Tauri `Channel`/`ipc::Response`), frontend decode. Sửa luôn test `wait_for` trong `integration.rs`. | ✅ `09fdd00` |
| B5 | `terminal.onBinary` không được forward (một số chế độ mouse report). | `src/main.jsx` `TerminalView` | Thêm handler `onBinary` → `terminal_input`. Backend nhận bytes thay vì `String`. | ✅ `09fdd00` |
| B6 | Không có copy/paste chuẩn trong terminal (Ctrl+V gửi `^V`). | `TerminalView` | `attachCustomKeyEventHandler`: Ctrl+Shift+C/V, chuột phải dán, tùy chọn copy-on-select. | ✅ `09fdd00` |
| B7 | SFTP session được cache vĩnh viễn; nếu channel SFTP chết thì không tạo lại. | `ssh.rs:87` | Khi thao tác lỗi do channel đóng → xóa cache và thử lại 1 lần. | ✅ `09fdd00` |
| B8 | Backend không kiểm tra tên key rỗng/quá dài. | `main.rs:70,92` | Validate `name.trim()` 1–100 ký tự. | ✅ `09fdd00` |
| B9 | Nhấp đúp symlink trỏ tới **file** sẽ mở như thư mục → lỗi thay cho listing. | `src/main.jsx:1756,1760` | Backend trả thêm `target_is_dir` (stat theo link); chỉ mở khi là thư mục. Cho phép transfer link-tới-file. | ✅ `09fdd00` |
| B10 | Nhóm đang lọc vẫn được chọn sau khi nhóm đó hết server. | `App` (`group` state) | Reset về `all` khi nhóm không còn trong `groups`. | ✅ `09fdd00` |
| B11 | README/UI nói `.ppk` không hỗ trợ, nhưng `russh::keys::decode_secret_key` đã đọc PPK (ssh-key feature `ppk`, kể cả có mật khẩu). | README, `KeyModal` | Viết test nhập PPK v2/v3, rồi bỏ dòng giới hạn, đổi text UI. | ✅ `09fdd00` |
| B12 | Topbar hard-code nhãn "Windows". | `src/main.jsx:440` | Lấy từ `@tauri-apps/plugin-os` hoặc `navigator.userAgent`. | ✅ `09fdd00` |
| B13 | Thư mục `electron/` rỗng còn sót. | repo | Xóa. | ✅ `09fdd00` |

## 3. Tính năng cần hoàn thiện (toàn bộ mục "Giới hạn bản 0.1")

Thứ tự đề xuất, mỗi nhóm một commit (Conventional Commits, ví dụ `feat(transfer): ...`).

### F1. Truyền file nâng cao — ✅ Xong — `d73e134`
- **Thư mục đệ quy** upload/download: một transfer gom tiến độ (tính tổng byte trước), tạo cây thư mục đích.
- **Xung đột/ghi đè**: request thêm `conflict: "fail" | "overwrite" | "skip" | "rename"`. Frontend kiểm tra trùng tên trong listing khung đích, hỏi người dùng (Ghi đè / Giữ cả hai / Bỏ qua / Hủy, có "áp dụng cho tất cả").
  - Remote overwrite: SFTP v3 `rename` không ghi đè và russh-sftp không có `posix-rename@openssh.com` → dùng swap: `target → target.sshstudio-old`, `temp → target`, xóa old; lỗi thì đổi ngược.
  - Local overwrite: `std::fs::rename` (thay thế nguyên tử trên Windows).
- **Resume**: tên partial xác định theo phiên bản nguồn, ví dụ `.<name>.<size>-<mtime>.sshstudio.part`; giữ partial khi lỗi/mất kết nối (xóa khi người dùng hủy); lần sau seek tới `len(partial)` (russh-sftp `File` có `AsyncSeek`). Chặn hai transfer cùng đích (map đích đang chạy trong `AppState`). Nút "Thử lại/Tiếp tục" trên transfer lỗi.
- **Giữ mtime** sau transfer (`set_metadata` phía remote, `File::set_modified` phía local) — cần cho F3.
- **Multi-select** (Ctrl/Shift-click) để truyền/xóa nhiều mục.
- **Kéo thả**:
  - Giữa hai khung: dùng pointer events tự cài (**không** dùng HTML5 DnD — trên Windows, Tauri bật `dragDropEnabled` mặc định nên HTML5 DnD không hoạt động).
  - Từ Explorer vào khung remote: `getCurrentWebview().onDragDropEvent` (lấy paths + vị trí, xác định khung đích).

### F2. Sửa file remote — ✅ Xong — `0646cd4` (chưa tô màu cú pháp)
- Lệnh `read_text(sessionId, path)` → `{content, size, mtime}` (giới hạn ~5 MB, từ chối nhị phân/không phải UTF-8).
- `write_text(sessionId, path, content, expectedMtime, expectedSize)`: nếu file đã đổi kể từ lúc mở thì báo xung đột; ghi `.part` rồi swap như F1; giữ quyền file (`permissions`).
- UI: modal/editor monospace, có số dòng, Ctrl+S, cảnh báo khi đóng chưa lưu. (Có thể thêm CodeMirror 6 nếu muốn tô màu cú pháp.)
- Kèm: xóa thư mục không rỗng (đệ quy, xác nhận rõ số mục), chmod (tùy chọn).

### F3. Đồng bộ thư mục — ✅ Xong — `2367821`
- So sánh đệ quy local ↔ remote theo size + mtime: chỉ-local, chỉ-remote, local mới hơn, remote mới hơn, giống nhau.
- Màn hình xem trước diff, chọn chiều (upload/download), chọn từng mục; mặc định **không xóa**; tùy chọn "mirror" (xóa phía đích) phải xác nhận riêng.
- Thực thi bằng hàng đợi transfer của F1 (policy overwrite).

### F4. Xác thực & kết nối — ✅ Xong — `ca254a4` (.ppk: B11)
- **Prompt hợp nhất**: backend phát event `auth-prompt {id, sessionId, title, instructions, prompts:[{label, echo}]}`, frontend trả lời qua `auth_respond(id, answers)` (cơ chế oneshot giống `verify_host`). Bỏ tham số `password` của `connect`; password cũng đi qua prompt này (cần cho jump host).
- **Keyboard-interactive / MFA**: `authenticate_keyboard_interactive_start/respond` (`KeyboardInteractiveAuthResponse::{Success, Failure{remaining_methods, partial_success}, InfoRequest{..}}`). Hỗ trợ chuỗi `partial_success` (ví dụ publickey rồi OTP). Password bị từ chối mà server có `keyboard-interactive` → thử lại, tự điền password cho prompt duy nhất không echo.
- **SSH agent**: auth mới `agent`. Windows: `AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")`, fallback `AgentClient::connect_pageant()`; Unix: `connect_env()`. Duyệt `request_identities()`, thử từng key qua `authenticate_publickey_with(user, key, hash, &mut agent)`.
- **.ppk**: xem B11.
- **Jump host (ProxyJump)**: `Host.jumpHostId` trỏ tới server đã lưu (cho phép chuỗi, chặn vòng lặp). Kết nối jump host (xác minh host key + auth riêng), `channel_open_direct_tcpip(target, port, "127.0.0.1", 0)`, rồi `client::connect_stream(config, channel.into_stream(), handler)`. Phải giữ handle jump host sống cùng phiên.
- **Proxy**: `Host.proxy = {type: "none"|"socks5"|"http", host, port, username, password}`. Tự cài SOCKS5 (RFC 1928/1929) và HTTP CONNECT trên `TcpStream`, rồi `connect_stream`. Password proxy mã hóa bằng vault như private key, không trả về frontend.
- Cập nhật `HostModal`: auth `password | key | agent | interactive`, chọn jump host, cấu hình proxy.

### F5. Port forwarding — ✅ Xong — `3be8b0b`
- **Local (-L)**: bind `127.0.0.1:lport`, mỗi kết nối → `channel_open_direct_tcpip(rhost, rport, ...)`, copy hai chiều (`channel.into_stream()` + `tokio::io::copy_bidirectional`).
- **Remote (-R)**: `handle.tcpip_forward(addr, port)`; cài `Handler::server_channel_open_forwarded_tcpip` để map `(connected_address, connected_port)` → đích local; `cancel_tcpip_forward` khi dừng.
- **Dynamic (-D)**: SOCKS5 server tối giản (no-auth, CONNECT) trên local, mỗi request → direct-tcpip.
- Lệnh `start_forward(sessionId, spec)`, `stop_forward(id)`, event `forward` (trạng thái, số kết nối, lỗi bind). Forward lưu trong cấu hình host được tự bật khi kết nối. UI: tab "Ports" trong phiên.

### F6. Key export & backup vault — ✅ Xong — `223be95`
- **Export private key**: xác nhận, dialog lưu file, tùy chọn passphrase (`PrivateKey::encrypt`, ssh-key đã bật feature `encryption`), xuất OpenSSH.
- **Backup vault**: file `.sshstudio-backup` chứa hosts, keys (đã giải mã), known hosts, forwards; mã hóa AES-256-GCM với khóa từ mật khẩu qua **Argon2id** (crate `argon2`, salt ngẫu nhiên, lưu tham số trong header). Không phụ thuộc Credential Manager.
- **Khôi phục**: nhập mật khẩu, merge (host theo id, key theo fingerprint, known host: xung đột → hỏi), báo cáo số mục thêm/bỏ qua.

### F7. Terminal, cài đặt, phím tắt, tray — ✅ Xong — `cc61eaa`, `0f9e68c` (không thêm addon-web-links: cần plugin mở trình duyệt ngoài)
- Tìm trong terminal: `@xterm/addon-search` (Ctrl+Shift+F, next/prev, highlight). Có thể thêm `@xterm/addon-web-links`.
- **Cài đặt** (lưu trong `workspace.json` mục `settings`): font, cỡ chữ, line-height, scrollback, kiểu con trỏ, copy-on-select, chế độ xem mặc định, xác nhận khi đóng, thu về tray khi đóng.
- **Phím tắt**: Ctrl+Tab / Ctrl+Shift+Tab đổi tab, Ctrl+Shift+W đóng phiên, Ctrl+Shift+T mở lại server vừa dùng, Ctrl+1..9, Ctrl+= / Ctrl+- / Ctrl+0 cỡ chữ, Ctrl+K tìm server. Không chiếm Ctrl+W/C/V trong terminal.
- **System tray**: Tauri feature `tray-icon` (dùng icon `assets/exports/statusbar`), menu Hiện cửa sổ / số phiên / Thoát; tùy chọn chạy nền khi đóng cửa sổ.

### F8. Ngoài khả năng tự làm — ⚠️ Chỉ cấu hình + tài liệu — xem `docs/RELEASE.md`
- **Ký số bản build**: cần chứng chỉ code signing của chủ dự án → chỉ chuẩn bị cấu hình `bundle.windows.certificateThumbprint`/`signCommand` và tài liệu.
- **macOS/Linux**: giữ code đa nền tảng (keyring, agent theo `cfg`, fallback B2), thêm target bundle nếu muốn; xác minh thật cần máy tương ứng.

## 4. Chiến lược kiểm thử

- Thay `MemorySftp` phẳng trong `integration.rs` bằng SFTP handler **dựa trên thư mục tạm thật** (mkdir/rmdir/readdir theo path, stat/setstat, open với offset, rename, remove) để test được đệ quy, resume, sync, edit.
- Bổ sung vào server fixture: `auth_keyboard_interactive` (OTP giả), `channel_open_direct_tcpip` (cho jump host & -L), `tcpip_forward` (cho -R).
- Test mới tối thiểu: thư mục đệ quy; conflict overwrite/skip/rename; resume sau khi ngắt giữa chừng; edit + phát hiện xung đột; sync preview; MFA partial success; jump host; local/dynamic forward; backup → restore round-trip + sai mật khẩu; import PPK.
- E2E thủ công: Docker `linuxserver/openssh-server` (bật password + key, thêm container thứ hai làm jump host), chạy `npm start`. **Chưa làm** trong đợt v0.2: máy phát triển không có Docker/WSL.
- Trước mỗi commit: `npm test` và `npm run build` phải pass.

## 5. Tiêu chí hoàn thành

- Toàn bộ B1–B13 và F1–F7 xong, có test tương ứng, `npm test` + `npm run build` + `npm run pack` pass.
- README cập nhật: mục Tính năng, bỏ các dòng đã làm khỏi "Giới hạn", ghi rõ phần F8.
- Không lưu password/OTP xuống đĩa; private key và password proxy chỉ nằm trong vault; không có secret trong log/event/snapshot.

## 6. Trạng thái v0.2 (2026-11-20)

| Hạng mục | Trạng thái |
| --- | --- |
| Fixture test (§4) | ✅ `690d49e`: SFTP trên thư mục tạm thật, keyboard-interactive, direct-tcpip, tcpip-forward. |
| Tách giao diện | ✅ `dc8934d`: `src/components/*`, `src/lib.js` + vitest. |
| B1–B13 | ✅ `09fdd00`. |
| F1–F7 | ✅ một commit mỗi nhóm (xem tiêu đề từng mục). |
| F8 | ⚠️ `src-tauri/tauri.signing.conf.json` + `npm run dist:signed` + `docs/RELEASE.md`; chưa ký thật, chưa chạy macOS/Linux. |
| `npm test` | ✅ 27 vitest + 47 Rust test (unit + integration trên server giả lập). |
| `npm run build` | ✅ |
| `npm run pack` | ✅ build release `ssh-studio.exe` (chưa chạy exe: sẽ dùng workspace/Credential Manager thật của máy). |
| E2E với OpenSSH thật (Docker) | ❌ Chưa làm: không có Docker/WSL trên máy. Kiểm tra giao diện chỉ qua bản web (`npm run dev`), không chạy cửa sổ Tauri với server thật. |

Tiêu chí bảo mật (§5) được giữ: password/OTP chỉ đi qua prompt trong bộ nhớ; private key và mật khẩu
proxy chỉ nằm trong vault (snapshot bỏ `secret`, chỉ trả `hasPassword`); file backup mã hóa bằng
mật khẩu riêng; mọi ghi đè file đều do người dùng chọn.
