# Changelog

Các thay đổi đáng chú ý của SSH Studio. Định dạng theo [Keep a Changelog](https://keepachangelog.com/vi/1.1.0/),
phiên bản theo [Semantic Versioning](https://semver.org/lang/vi/). Mục mới được `npm run release` tự thêm
từ commit (Conventional Commits) kể từ tag trước.

## [0.3.0] - 2026-11-22

### Launchpad (Ctrl+Shift+D)

- Một nơi cho mọi workspace (hoặc chỉ workspace hiện tại): **Phiên đang mở**, **Gần đây**,
  **Port forward** đang chạy, **Truyền file** đang chạy / lỗi, **Cần chú ý** và **Tất cả server**.
- "Cần chú ý" gom phiên bị ngắt, forward lỗi, truyền file thất bại và server có lần kết nối trước
  lỗi; số mục hiện thành badge ở sidebar và thanh tab. Lỗi kết nối có thể "Bỏ qua" tới lần sau.
- Ghim server lên đầu, tìm kiếm, phím J / K / Enter / C (kết nối) / P (ghim) / 1–6 (đổi tab).
- Lịch sử kết nối chỉ lưu thời điểm và kết quả, trên máy này; không chứa mật khẩu hay OTP.

### Thư mục trong workspace

- Cây thư mục tối đa 3 cấp ở sidebar (thay danh sách nhóm): kéo thả server và thư mục, chuột phải
  để tạo, đổi tên, chuyển, xóa (nội dung chuyển lên cấp trên, không xóa server).
- "Tạo thư mục từ nhóm" chuyển các nhóm server có sẵn thành thư mục; nhóm vẫn giữ làm nhãn và bộ lọc.
- Trang Servers thành tổng quan workspace: danh sách theo thư mục hoặc dạng thẻ, lọc Đang kết nối /
  Chưa mở / Có port forward / Cần chú ý, cột lần kết nối gần nhất, "Kết nối tất cả" cho cả danh sách
  hoặc một thư mục, menu server (sao chép lệnh ssh, ghim, chuyển thư mục / workspace).
- Form server có ô chọn thư mục. Sao lưu / khôi phục giữ thư mục.

### Giao diện

- Menu thả xuống và chuột phải có menu con; hộp nhập tên trong app.
- Trang luôn chừa chỗ cho thanh cuộn nên không giật khi đổi tab hay bộ lọc; bố cục gọn hơn ở cửa sổ
  nhỏ nhất (1000×680).

## [0.2.2] - 2026-11-21

### Sửa lỗi

- chỉ chạy một bản SSH Studio

## [0.2.1] - 2026-11-21

### Tính năng

- tùy chọn tương thích server cũ, thông báo lỗi xác thực rõ ràng

## [0.2.0] - 2026-11-20

Bản đầu tiên cho cả Windows, macOS và Linux.

### Nền tảng

- **macOS**: `.dmg` riêng cho Apple Silicon (`macos-aarch64`) và Intel (`macos-x64`), macOS 10.15+.
  Vault dùng Keychain; biểu tượng khay đổi màu theo menu bar sáng / tối. Bản chưa ký: lần đầu mở
  bằng chuột phải → Open (xem `docs/RELEASE.md` §2).
- **Linux x64**: `.deb`, `.rpm`, `.AppImage` (build trên Ubuntu 22.04). Vault dùng Secret Service
  (GNOME Keyring / KWallet); gói `.deb` / `.rpm` khuyến nghị `gnome-keyring`.
- Windows x64: installer NSIS như trước.
- Test tự động chạy trên cả ba nền tảng trước mỗi lần phát hành.

### Giao diện

- Dialog xác nhận trong app thay hộp thoại của hệ điều hành: nút ghi rõ hành động ("Xóa",
  "Ngắt kết nối"…), thao tác xóa mặc định chọn Hủy, Escape chỉ đóng dialog.
- Menu chuột phải riêng thay menu của WebView (Back / Reload / Print…): ô nhập có Cắt / Sao chép /
  Dán / Chọn tất cả, ô mật khẩu không cho sao chép.
- Checkbox, radio và select theo giao diện tối, giống nhau trên mọi nền tảng (select không còn nền
  trắng trên Linux).
- Màn hình SSH Keys ghi đúng kho khóa của hệ điều hành đang dùng.

### Sửa lỗi

- Cài đặt "Giãn dòng" hiện `1.2999999523162842` thay vì `1.3`.

### Giới hạn đã biết

- Installer chưa ký số (SmartScreen trên Windows, Gatekeeper trên macOS có thể cảnh báo).
- macOS mới được test tự động trên CI, chưa chạy thử trên máy Mac thật; Linux đã cài và chạy thử
  trên Ubuntu 22.04, chưa thử Fedora và tray trên desktop thật.

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
