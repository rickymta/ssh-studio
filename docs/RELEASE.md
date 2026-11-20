# Phát hành

## 0. Phát hành bằng GitHub Actions

Luồng giống git-studio: chỉ đẩy tag `vX.Y.Z` nằm trên `main` mới chạy Actions (không chạy theo mỗi push
hay pull request).

1. Trên `main`, working tree sạch:
   ```powershell
   npm run release -- patch        # hoặc minor | major | 1.2.3 | 1.3.0-beta.1; thêm --dry-run để xem trước
   ```
   Script đổi version ở `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, thêm mục mới vào `CHANGELOG.md` từ các commit
   (Conventional Commits) kể từ tag trước, rồi commit `chore(release): vX.Y.Z` và tạo tag. Script không
   push. Nên đọc lại và sửa mục CHANGELOG (`git commit --amend`, rồi `git tag -f vX.Y.Z`) trước khi push.
2. Đẩy lên:
   ```powershell
   git push origin main vX.Y.Z
   ```
3. Workflow [`release.yml`](../.github/workflows/release.yml):
   - **prepare**: tag đúng dạng, version trong tag khớp các file (`npm run check:version`), tag nằm
     trên `main`.
   - **test**: gọi [`ci.yml`](../.github/workflows/ci.yml) trên đúng commit của tag: vitest, build
     frontend, `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (server SSH/SFTP loopback,
     không dùng server hay credential thật). Lỗi thì dừng, không tạo release.
   - **draft**: tạo release DRAFT, nội dung lấy từ mục của version trong `CHANGELOG.md`.
   - **build**: installer NSIS Windows x64 (`SSHStudio_X.Y.Z_windows-x64-setup.exe`), upload vào draft.
     Build lỗi thì release vẫn là draft.
   - **publish**: thêm `SHA256SUMS.txt`, chuyển draft thành release chính thức (tag có `-pre` thành
     pre-release).
4. Chạy lại cho tag đã có: Actions → Release → Run workflow, nhập tag.

CI cũng chạy tay được: Actions → CI → Run workflow.

Ký số trên CI (tùy chọn): thêm secret `WINDOWS_CERTIFICATE` (file `.pfx` mã hóa base64) và
`WINDOWS_CERTIFICATE_PASSWORD`. Không có secret thì bản build không ký.

Phần dưới đây là ký số khi build trên máy và các nền tảng khác (F8). Chưa có bản build nào được ký, và
chưa chạy thử trên macOS/Linux.

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
- Thêm icon `.icns` / `.png` (hiện chỉ có `icons/icon.ico`), rồi thêm `macos-latest` và `ubuntu-22.04`
  vào ma trận `check` của `ci.yml` và `build` của `release.yml` (git-studio có sẵn mẫu cho dmg, deb,
  rpm, AppImage).
