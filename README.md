<p align="center">
  <img src="assets/exports/app/256x256.png" width="128" height="128" alt="SSH Studio icon" />
</p>

# SSH Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-7ce4c9.svg)](LICENSE)
[![Tauri 2](https://img.shields.io/badge/Desktop-Tauri%202-24c8db.svg)](https://tauri.app/)

**Một workspace cho terminal SSH, file SFTP và SSH key của nhiều server.**

Ứng dụng desktop Windows quản lý SSH terminal, file SFTP và SSH key. Backend **Rust + Tauri 2**, giao diện **React + xterm.js**. Không có Electron hoặc Node backend trong ứng dụng đóng gói.

## Chạy ứng dụng

Yêu cầu Node.js 20.19+ / 22.12+, Rust 1.91.1+ với toolchain MSVC, Visual Studio C++ Build Tools và WebView2 trên Windows.

```powershell
git clone https://github.com/rickymta/ssh-studio.git
cd ssh-studio
npm ci
npm start
```

`npm run dev` chỉ mở frontend Vite, không có khả năng kết nối SSH. Dùng `npm start` để chạy cửa sổ Tauri và backend Rust.

## Tính năng

- Thêm, sửa, xóa server; tìm theo tên/IP/username; phân nhóm theo môi trường hoặc dự án.
- Mở nhiều phiên SSH cùng lúc, kể cả nhiều phiên tới cùng server. Mỗi terminal giữ trạng thái khi chuyển tab.
- Xác thực bằng password hoặc private key. Password được hỏi mỗi lần kết nối, không lưu xuống ổ đĩa.
- Terminal tương tác có PTY, màu ANSI, resize và scrollback 10.000 dòng.
- Chế độ Terminal, Files hoặc chia đôi terminal/file manager.
- Hai khung file local/remote: duyệt đường dẫn, mở thư mục, tạo thư mục, đổi tên, xóa file hoặc thư mục rỗng.
- Upload/download file qua SFTP, tiến độ, hàng đợi tối đa hai file đồng thời, hủy tác vụ. Ghi vào file `.part` trước khi công bố file đích.
- Nhập private key OpenSSH/PEM có hoặc không có passphrase; tạo key Ed25519; sao chép public key; dùng chung key cho nhiều server. Chặn xóa key đang được cấu hình server sử dụng.
- Xác nhận SHA256 fingerprint lần đầu; lưu Known Hosts; chặn khi host key thay đổi.

## Sử dụng

1. Nếu dùng key: vào **SSH Keys**, nhập private key hoặc tạo mới. Với key tạo mới, sao chép public key và thêm vào `~/.ssh/authorized_keys` trên server qua kênh quản trị tin cậy.
2. Chọn **Thêm server**, điền hostname/IP, port, username và phương thức xác thực.
3. Chọn **Kết nối**. Đối chiếu fingerprint với console server hoặc quản trị viên trước khi tin cậy.
4. Mở thêm kết nối từ danh sách Servers; chuyển qua lại giữa các tab.
5. Trong **Files**, chọn thư mục đích ở cả hai khung, chọn file rồi **Upload** hoặc **Download**.

## Dữ liệu và bảo vệ key

Tauri lưu `workspace.json` trong thư mục AppData của `dev.sshstudio.desktop` (Windows thường là `%APPDATA%\dev.sshstudio.desktop`). Metadata server và public key không phải bí mật. Private key được mã hóa bằng AES-256-GCM với nonce ngẫu nhiên; master key được lưu trong Windows Credential Manager, service `dev.sshstudio.desktop`, entry `vault-master-key`. Private key không được trả về frontend.

Key có passphrase được mở khóa lúc nhập, sau đó bản private key trong vault được bảo vệ bởi mã hóa của ứng dụng. Việc sao chép riêng `workspace.json` sang máy khác không chuyển được khả năng giải mã private key. Giữ bản gốc key an toàn trước khi nhập. Không có đồng bộ cloud hoặc telemetry.

## Giới hạn bản 0.1

- Truyền từng file; chưa truyền thư mục đệ quy, kéo thả hoặc resume. Nén thư mục trước khi truyền.
- Không tự ghi đè file đích. Nếu tên đã tồn tại, đổi tên hoặc xóa file đích bằng thao tác riêng.
- Chưa có SSH agent, jump host, proxy, port forwarding hoặc xác thực keyboard-interactive/MFA.
- `.ppk` cần xuất sang OpenSSH bằng PuTTYgen trước khi nhập.
- Chưa có export private key hoặc backup vault có mật khẩu độc lập.
- Chưa có chỉnh sửa nội dung file remote hoặc đồng bộ thư mục.
- Bản build chưa ký số. Windows là nền tảng đã nhắm đến; chưa xác minh macOS/Linux.

## Kiểm tra và build

```powershell
npm run build
npm test
npm run pack
npm run dist
```

- `npm test`: Rust unit tests và server SSH/SFTP loopback tự tạo, không sử dụng server hay credential thật.
- `npm run pack`: executable release tại `src-tauri/target/release/ssh-studio.exe`.
- `npm run dist`: thêm NSIS installer tại `src-tauri/target/release/bundle/nsis/`.

Các test kiểm tra mã hóa và phát hiện sửa đổi vault, không lộ private key trong snapshot, tên file, phiên SSH độc lập, truyền file hai chiều, tránh ghi đè, sai password và host key thay đổi.

## Cấu trúc

- `src/main.jsx`: workspace, forms, terminal, SFTP panels và transfer queue.
- `src/style.css`: giao diện desktop tối.
- `src-tauri/src/main.rs`: Tauri commands và state dùng chung.
- `src-tauri/src/ssh.rs`: host verification, authentication, session/channel lifecycle.
- `src-tauri/src/files.rs`: local filesystem, SFTP và transfers.
- `src-tauri/src/store.rs`: metadata, vault mã hóa và OS credential store.
- `src-tauri/src/integration.rs`: server fixture và integration test.

Backend dùng [russh](https://github.com/warp-tech/russh), [russh-sftp](https://docs.rs/russh-sftp/latest/russh_sftp/) và [keyring](https://docs.rs/keyring/latest/keyring/). Quyền frontend được khai báo trong `src-tauri/capabilities/default.json`; CSP giới hạn kết nối của webview vào IPC Tauri.

## Bộ icon

Icon chính kết hợp thư mục và dấu lệnh `>_`, nền xanh đậm và nét mint. Icon status bar là bản đơn sắc trắng, nền trong suốt.

| Icon | Nguồn | File xuất |
| --- | --- | --- |
| Ứng dụng | [logo.svg](assets/logo.svg) | [PNG 1024 px](assets/exports/app/1024x1024.png), [Windows ICO](src-tauri/icons/icon.ico) |
| Status bar | [statusbar.svg](assets/statusbar.svg) | [PNG 16–48 px](assets/exports/statusbar/) |

Icon đã được tích hợp vào sidebar, status bar và bộ icon đóng gói của Tauri. Xem [hướng dẫn tái tạo icon](assets/ICONS.md). Chưa triển khai menu system tray hoặc chế độ chạy nền.

## Đóng góp

Đọc [CONTRIBUTING.md](CONTRIBUTING.md) để thiết lập môi trường, chạy kiểm tra và gửi pull request. Báo lỗi hoặc đề xuất tính năng tại [GitHub Issues](https://github.com/rickymta/ssh-studio/issues). Không đưa credential, private key hoặc dữ liệu server thật vào issue, log hay ảnh chụp màn hình.

## Giấy phép

Mã nguồn và bộ icon của dự án được phát hành theo [MIT License](LICENSE). Các thư viện phụ thuộc giữ giấy phép riêng của chúng.
