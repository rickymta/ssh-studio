# Đóng góp cho SSH Studio

SSH Studio dùng Rust + Tauri 2 cho backend desktop, React cho giao diện và xterm.js cho terminal. Windows là nền tảng được ưu tiên ở phiên bản hiện tại.

## Thiết lập môi trường

1. Cài Node.js 20.19+ / 22.12+, Rust 1.91.1+ với toolchain MSVC, Visual Studio C++ Build Tools và WebView2.
2. Fork repository nếu bạn không có quyền ghi, rồi clone bản fork. Nếu có quyền, clone trực tiếp:

   ```powershell
   git clone https://github.com/rickymta/ssh-studio.git
   cd ssh-studio
   npm ci
   npm start
   ```

3. Tạo nhánh riêng cho thay đổi. Mỗi pull request nên giải quyết một vấn đề cụ thể.

`npm start` chạy ứng dụng Tauri đầy đủ. `npm run dev` chỉ phục vụ frontend, không khởi động backend SSH.

## Quy ước phát triển

- Giữ thao tác SSH, SFTP, filesystem và private key trong Rust. Frontend chỉ nhận metadata cần thiết qua Tauri commands/events.
- Không trả private key về frontend, ghi password/key vào log, hoặc bỏ qua kiểm tra host fingerprint.
- Giữ các phiên terminal độc lập; kiểm tra việc chuyển tab, resize, mất kết nối và đóng phiên khi thay đổi session lifecycle.
- Với truyền file, giữ cơ chế file tạm, hủy tác vụ và không tự ghi đè file đích. Xử lý cả đường dẫn Windows và đường dẫn POSIX trên server.
- Thêm hoặc điều chỉnh test cho thay đổi hành vi. Dùng server loopback, dữ liệu tạm và credential thử nghiệm; không dùng server production.
- Giữ thông báo lỗi và nội dung giao diện bằng tiếng Việt, ngắn gọn và có hướng xử lý.
- Commit `package-lock.json` và `src-tauri/Cargo.lock` khi dependencies thay đổi. Không commit build output, `node_modules`, vault, credential hoặc private key.

## Kiểm tra trước khi gửi PR

```powershell
npm run build
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

Nếu thiếu rustfmt, cài bằng `rustup component add rustfmt` cho toolchain đang dùng. Khi cần định dạng Rust, chạy `cargo fmt --manifest-path src-tauri/Cargo.toml`.

`npm test` chạy Rust unit tests và SSH/SFTP integration test bằng server loopback. Phần kiểm tra kho key dùng credential thử nghiệm với service riêng trong kho hệ điều hành, không dùng credential của ứng dụng thật. Nếu test bị ngắt, entry thử nghiệm có tiền tố `dev.sshstudio.integration.` có thể còn lại.

Với thay đổi giao diện, kiểm tra trong cửa sổ Tauri ở kích thước tối thiểu 1000 × 680 và kích thước thông thường. Với thay đổi đóng gói, chạy `npm run pack` hoặc `npm run dist` trên Windows. Không cần build installer cho chỉnh sửa tài liệu đơn thuần.

## Thay đổi icon

Chỉnh nguồn vector ở `assets/logo.svg` và `assets/statusbar.svg`, sau đó tái tạo các bản PNG/ICO theo [assets/ICONS.md](assets/ICONS.md). Commit cả SVG nguồn và các file icon được tạo lại. Kiểm tra icon ở kích thước nhỏ, đặc biệt 16, 20 và 24 px.

## Issue và pull request

- Báo lỗi: mô tả bước tái hiện, kết quả mong đợi/thực tế, phiên bản ứng dụng và Windows. Đính kèm log đã loại bỏ dữ liệu nhạy cảm khi cần.
- Đề xuất tính năng: mô tả tình huống sử dụng và hành vi mong muốn trước khi đề xuất giải pháp kỹ thuật.
- PR: nêu vấn đề, thay đổi hành vi, cách kiểm tra và giới hạn còn lại. Kèm ảnh trước/sau cho thay đổi giao diện.
- Không công khai lỗi bảo mật kèm credential hoặc thông tin khai thác server thật. Dùng mục **Security → Report a vulnerability** trên GitHub nếu repository đã bật tính năng này; nếu chưa, liên hệ riêng maintainer để thống nhất kênh báo cáo.

Khi gửi đóng góp, bạn đồng ý phát hành phần đóng góp của mình theo [MIT License](LICENSE) của dự án. Chỉ đưa vào mã nguồn và tài nguyên mà bạn có quyền phân phối.
