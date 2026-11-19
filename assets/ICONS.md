# SSH Studio icons

Hai icon dùng chung hình thư mục và dấu lệnh `>_`.

- `logo.svg`: icon chính, vector 1024 × 1024; nền xanh đậm, nét mint. Dùng cho ứng dụng, launcher và installer.
- `statusbar.svg`: bản đơn sắc trắng 24 × 24, nền trong suốt; dùng trên status bar/system tray nền tối. Có thể đổi màu stroke cho theme sáng hoặc dùng làm template icon trên macOS.
- `exports/app/`: PNG icon chính 256, 512, 1024 px.
- `exports/statusbar/`: PNG trong suốt 16, 20, 24, 32, 48 px.
- `../src-tauri/icons/`: ICO đa kích thước, ICNS và PNG do Tauri tạo từ icon chính.

Tái tạo các file xuất từ thư mục dự án:

```powershell
npx tauri icon assets/logo.svg --output src-tauri/icons
npx tauri icon assets/logo.svg --output assets/exports/app --png 256 --png 512 --png 1024
npx tauri icon assets/statusbar.svg --output assets/exports/statusbar --png 16 --png 20 --png 24 --png 32 --png 48
```

Icon chính đã gắn vào sidebar và cấu hình icon của Tauri. Icon đơn sắc đã gắn vào status bar trong ứng dụng. Các file system tray được cung cấp sẵn; chưa thêm hành vi chạy nền hoặc menu system tray.
