# Changelog

Các thay đổi đáng chú ý của SSH Studio. Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
phiên bản theo [Semantic Versioning](https://semver.org/lang/vi/). Mục mới được `npm run release` tự thêm
từ commit (Conventional Commits) kể từ tag trước.

## [0.1.0] - 2026-11-20

Bản phát hành đầu tiên, cho Windows x64 (installer NSIS, chưa ký số).

### Tính năng

- Server: thêm / sửa / xóa, tìm theo tên, IP, username (Ctrl+K), nhóm theo môi trường hoặc dự án.
- Workspace: gom server theo khách hàng / dự án (tên, màu), chuyển workspace ở sidebar.
- Xác thực: mật khẩu, private key, SSH agent (OpenSSH Agent / Pageant), keyboard-interactive / MFA
  (OTP), jump host (ProxyJump nhiều bước), proxy SOCKS5 / HTTP CONNECT. Tùy chọn lưu mật khẩu đăng
  nhập trong vault mã hóa; mã OTP không bao giờ được lưu.
- Terminal: nhiều phiên song song, renderer WebGL, tìm kiếm (Ctrl+Shift+F), sao chép / dán,
  copy-on-select, kết nối lại giữ scrollback, hiển thị độ trễ phản hồi.
- File (SFTP): hai khung local / remote, chế độ Terminal / Files / Chia đôi / Song song, kéo đổi
  kích thước khung và cột; upload / download thư mục đệ quy, kéo thả (cả từ Explorer), hỏi khi trùng
  tên, tiếp tục từ chỗ dừng, giữ thời gian sửa đổi; sửa file text, chmod, xóa thư mục.
- Đồng bộ thư mục local ↔ remote có xem trước; port forwarding Local / Remote / Dynamic SOCKS5.
- SSH key: nhập OpenSSH / PEM / PuTTY .ppk, tạo Ed25519, xuất private key; sao lưu / khôi phục
  toàn bộ vault vào file mã hóa bằng mật khẩu riêng (Argon2id + AES-256-GCM).
- Cài đặt terminal, chế độ xem mặc định, cỡ giao diện, khay hệ thống; trợ giúp (F1) với bảng phím
  tắt, nhật ký hoạt động (Ctrl+Shift+L). F1–F12, Ctrl+R… không còn tải lại cửa sổ.

### Bảo mật

- Private key, mật khẩu đã lưu và mật khẩu proxy chỉ nằm trong vault AES-256-GCM, khóa chính trong
  Windows Credential Manager. Snapshot gửi lên giao diện, sự kiện và nhật ký không chứa secret.
- Xác nhận SHA256 fingerprint lần đầu, chặn kết nối khi host key thay đổi.

### Giới hạn đã biết

- Chỉ có bản Windows; macOS / Linux chưa được build và kiểm thử (xem `docs/RELEASE.md`).
- Installer chưa ký số nên SmartScreen có thể cảnh báo.
