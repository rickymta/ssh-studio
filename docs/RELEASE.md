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

Cấu hình riêng: [`src-tauri/tauri.macos.conf.json`](../src-tauri/tauri.macos.conf.json) (bundle `app` +
`dmg`, macOS 10.15+). Tauri tự gộp file này khi build trên Mac.

| Thành phần | Trên macOS |
| --- | --- |
| Vault master key | `keyring` (Keychain): mục `dev.sshstudio.desktop` / `vault-master-key` trong login keychain. |
| SSH agent | `SSH_AUTH_SOCK` (ssh-agent của hệ thống / 1Password / Secretive). |
| Ghi file tải về | Fallback B2 (`rename` khi không tạo được hard link) dùng chung cho mọi nền tảng. |
| Xuất private key | File được tạo với quyền `0600`. |
| Khay hệ thống | Biểu tượng trên menu bar, dùng chế độ template (`icon_as_template`) nên tự đổi màu theo menu bar sáng/tối. |

Build trên máy Mac (cần Xcode Command Line Tools):

```bash
npm ci
npm run dist                     # .app và .dmg tại src-tauri/target/release/bundle/
```

Không có máy Mac: GitHub → Actions → **Build installers** → Run workflow; hai bản `dmg` (Apple Silicon
`macos-aarch64`, Intel `macos-x64`) nằm trong Artifacts của lần chạy.

Bản không ký: lần đầu mở, Gatekeeper chặn. Chuột phải vào app → **Open**, hoặc
`xattr -dr com.apple.quarantine "/Applications/SSH Studio.app"`.

Ký và notarize trên CI (tùy chọn, `release.yml` đã đọc sẵn): thêm secret `APPLE_CERTIFICATE` (file `.p12`
mã hóa base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
(`Developer ID Application: <Tên> (<TEAMID>)`) để ký; thêm `APPLE_ID`, `APPLE_PASSWORD` (app-specific
password), `APPLE_TEAM_ID` để notarize. Thiếu một phần của bộ nào thì bộ đó bị bỏ qua và bản build không
ký thay vì lỗi. Không commit các giá trị này.

## 3. Linux

Cấu hình riêng: [`src-tauri/tauri.linux.conf.json`](../src-tauri/tauri.linux.conf.json) (bundle `deb`,
`rpm`, `AppImage`; gói `.deb` / `.rpm` khuyến nghị `gnome-keyring`).

| Thành phần | Trên Linux |
| --- | --- |
| Vault master key | Secret Service qua D-Bus (GNOME Keyring, KWallet…). Desktop không có Secret Service thì app không mở được vault; cần cài và mở khóa keyring. |
| SSH agent | `SSH_AUTH_SOCK`. |
| Khay hệ thống | Cần `libayatana-appindicator3-1` (gói `.deb` đã khai báo phụ thuộc). Không tạo được tray thì app vẫn chạy, chỉ ghi lỗi ra stderr; khi đó đừng bật "thu về khay". |
| WebView | WebKitGTK 4.1. |
| Dữ liệu | `~/.local/share/dev.sshstudio.desktop/workspace.json`. |

Thư viện build (Debian/Ubuntu):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev build-essential curl wget file libxdo-dev   libssl-dev libayatana-appindicator3-dev librsvg2-dev libdbus-1-dev
npm ci
npm run dist                     # deb, rpm, AppImage tại src-tauri/target/release/bundle/
```

Build trên Windows qua Docker (cách đã dùng để kiểm tra): image `ubuntu:22.04` cài các gói trên + Node 22 +
Rust stable, chạy `npm ci && npm run dist` trong container với `APPIMAGE_EXTRACT_AND_RUN=1` (container
không có FUSE). Build trên Ubuntu 22.04 để glibc đủ cũ cho nhiều distro.

`cargo test` trên Linux cần một Secret Service; trên máy không có desktop (CI, container):

```bash
dbus-run-session -- bash -c 'echo -n test | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  cargo test --manifest-path src-tauri/Cargo.toml'
```

## 4. Trạng thái đa nền tảng (2026-11-20)

| Nền tảng | Đã kiểm tra | Chưa kiểm tra |
| --- | --- | --- |
| Windows x64 | fmt, clippy, 54 test Rust, vitest, build NSIS. | — |
| Linux x64 | Trong Docker Ubuntu 22.04: fmt, clippy `-D warnings`, **54/54 test Rust** (vault qua gnome-keyring), vitest, build `.deb` / `.rpm` / `.AppImage`. Cài `.deb` vào Ubuntu 22.04 sạch: đủ thư viện, có icon và `.desktop`, app chạy dưới Xvfb, giao diện (WebKitGTK 2.50) hiển thị đúng. | Desktop thật (tray, kéo thả từ file manager, KWallet), Fedora với `.rpm`. |
| macOS | Cấu hình bundle, icon `.icns`, tray template, CI `macos-latest` (test + build dmg). | Chưa có lần chạy CI nào và chưa có máy Mac chạy thử: cần chạy workflow **CI** / **Build installers** và kiểm tra thủ công (Keychain, Finder kéo thả, Gatekeeper). |
