# Phát hành: ký số và nền tảng khác (F8)

Phần này cần tài nguyên của chủ dự án (chứng chỉ, máy macOS/Linux) nên mới chỉ có cấu hình và hướng
dẫn. Chưa có bản build nào được ký, và chưa chạy thử trên macOS/Linux.

## 1. Ký số bản Windows

`npm run dist` tạo installer NSIS **không ký**. `npm run dist:signed` gộp thêm
[`src-tauri/tauri.signing.conf.json`](../src-tauri/tauri.signing.conf.json) vào cấu hình Tauri để ký
executable và installer bằng `signtool` (có trong Windows SDK).

### 1.1 Chứng chỉ trong Windows Certificate Store (OV/EV)

1. Cài chứng chỉ code signing vào store `CurrentUser\My` (EV thường nằm trên token USB / HSM, driver
   của nhà cung cấp sẽ đưa chứng chỉ vào store).
2. Lấy thumbprint:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
   ```
3. Thay `THAY_BANG_THUMBPRINT_CHUNG_CHI` trong `src-tauri/tauri.signing.conf.json` bằng thumbprint (40 ký
   tự hex, không dấu cách). Thumbprint không phải bí mật nhưng nên giữ file này ở nhánh phát hành.
4. Nếu nhà cung cấp chứng chỉ có máy chủ timestamp riêng, đổi `timestampUrl`. Bản ký có timestamp vẫn
   hợp lệ sau khi chứng chỉ hết hạn.
5. Build và kiểm tra:
   ```powershell
   npm run dist:signed
   signtool verify /pa /v src-tauri\target\release\ssh-studio.exe
   signtool verify /pa /v "src-tauri\target\release\bundle\nsis\SSH Studio_0.1.0_x64-setup.exe"
   ```

### 1.2 Ký bằng lệnh riêng (Azure Trusted Signing, HSM đám mây…)

Thay khối `windows` bằng `signCommand`; Tauri thay `%1` bằng đường dẫn file cần ký:

```json
{
  "bundle": {
    "windows": {
      "signCommand": "trusted-signing-cli -e https://<vùng>.codesigning.azure.net -a <tài-khoản> -c <hồ-sơ-chứng-chỉ> %1"
    }
  }
}
```

Credential của dịch vụ ký (ví dụ `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`) đặt bằng
biến môi trường / secret của CI, **không** ghi vào file cấu hình hay commit.

### 1.3 Lưu ý

- SmartScreen vẫn có thể cảnh báo với chứng chỉ OV mới cho tới khi có đủ "danh tiếng"; chứng chỉ EV hoặc
  Trusted Signing được tin cậy nhanh hơn.
- Đổi chứng chỉ không ảnh hưởng dữ liệu người dùng: vault dùng khóa trong Credential Manager, không gắn
  với chữ ký của ứng dụng.

## 2. macOS

Code đã tách theo nền tảng; những điểm cần xác minh trên máy Mac:

| Thành phần | Trên macOS |
| --- | --- |
| Vault master key | `keyring` (mặc định bật Keychain): mục `dev.sshstudio.desktop` / `vault-master-key` trong login keychain. |
| SSH agent | `SSH_AUTH_SOCK` (ssh-agent của hệ thống / 1Password / Secretive). |
| Ghi file tải về | Fallback B2 (`rename` khi không tạo được hard link) dùng chung cho mọi nền tảng. |
| Xuất private key | File được tạo với quyền `0600`. |
| Khay hệ thống | Biểu tượng trên menu bar. Icon trắng đơn sắc ở `assets/exports/statusbar`; nên thêm `.icon_as_template(true)` trong `src-tauri/src/tray.rs` để icon đổi màu theo giao diện sáng/tối. |

Build và ký:

```bash
npm ci
npm run tauri -- build --bundles app,dmg
```

Để ký và notarize, thêm vào `tauri.signing.conf.json` (hoặc một file riêng cho macOS):

```json
{ "bundle": { "macOS": { "signingIdentity": "Developer ID Application: <Tên> (<TEAMID>)" } } }
```

và đặt biến môi trường `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID` khi build.
Không commit các giá trị này.

## 3. Linux

| Thành phần | Trên Linux |
| --- | --- |
| Vault master key | Secret Service qua D-Bus (GNOME Keyring, KWallet…). Desktop không có Secret Service thì app không mở được vault; cần cài và mở khóa keyring. |
| SSH agent | `SSH_AUTH_SOCK`. |
| Khay hệ thống | Cần `libayatana-appindicator3` (hoặc `libappindicator3`). Không tạo được tray thì app vẫn chạy, chỉ ghi lỗi ra stderr; khi đó đừng bật "thu về khay". |
| WebView | WebKitGTK 4.1. |

Thư viện build (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
npm ci
npm run tauri -- build --bundles deb,appimage
```

## 4. Việc còn lại trước khi phát hành đa nền tảng

- Chạy `npm test` trên macOS và Linux (test agent dùng Unix socket đã có nhánh `cfg(unix)`, chưa chạy).
- Kiểm thử thủ công: kết nối, SFTP, kéo thả từ Finder / file manager, tray, ký và cài đặt.
- Thêm CI ma trận (`windows-latest`, `macos-latest`, `ubuntu-22.04`) với `tauri-action`; secret ký đặt
  trong CI.
