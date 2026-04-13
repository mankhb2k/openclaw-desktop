# Kế Hoạch Đóng Gói Electron + Tải Dependencies Sau Cài Đặt

> **Ngữ cảnh dự án**: OpenClaw Desktop — Electron wrapper xung quanh `openclaw` npm package (gateway + Control UI).  
> Hiện tại: `asar: false`, toàn bộ `node_modules` (~500 MB+) được bundle vào NSIS installer.  
> Mục tiêu phương án mới: installer nhỏ (~50–80 MB), tải `node_modules` + openclaw gateway sau khi cài.

---

## Mục lục

1. [Tổng quan kiến trúc](#1-tổng-quan-kiến-trúc)
2. [Quy trình đóng gói EXE nhẹ](#2-quy-trình-đóng-gói-exe-nhẹ)
3. [Luồng First-Run: tải và cài dependencies](#3-luồng-first-run-tải-và-cài-dependencies)
4. [Quy trình update 1 chạm](#4-quy-trình-update-1-chạm)
5. [So sánh: Split vs Full-Bundle](#5-so-sánh-split-vs-full-bundle)
6. [Tính khả thi với NSIS](#6-tính-khả-thi-với-nsis)
7. [Yêu cầu để luồng hoạt động hiệu quả](#7-yêu-cầu-để-luồng-hoạt-động-hiệu-quả)
8. [Roadmap triển khai](#8-roadmap-triển-khai)

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────────┐
│                   PHƯƠNG ÁN SPLIT (đề xuất)                     │
├──────────────────┬──────────────────────────────────────────────┤
│  INSTALLER EXE   │  Electron shell + main/backend/preload JS    │
│  (~50–80 MB)     │  assets/ icon, tsconfig                      │
│                  │  KHÔNG có node_modules                       │
├──────────────────┼──────────────────────────────────────────────┤
│  BACKEND BUNDLE  │  node_modules/ (openclaw + tất cả deps)      │
│  (~400–600 MB)   │  Được tải từ GitHub Releases / CDN           │
│  (tải sau)       │  Giải nén vào %APPDATA%\OpenClaw\backend\    │
└──────────────────┴──────────────────────────────────────────────┘

Luồng hoạt động sau cài đặt:
  app.exe khởi động
    → kiểm tra %APPDATA%\OpenClaw\backend\node_modules\openclaw
    → nếu chưa có: hiện "First Run Setup" wizard
        → tải backend-bundle-vX.Y.Z.tar.gz từ GitHub Releases
        → giải nén vào dataRoot
        → chạy npm install nếu cần
    → nếu đã có: khởi động gateway như bình thường
```

---

## 2. Quy trình đóng gói EXE nhẹ

### 2.1 Cấu hình electron-builder.yml (phương án split)

```yaml
appId: dev.openclaw.desktop
productName: OpenClaw
asar: false                      # Giữ false — lý do đã ghi trong file gốc

files:
  - dist/**/*                    # JS đã biên dịch (main, backend, preload)
  - assets/icon.ico
  - package.json
  # KHÔNG có node_modules/**/* — đây là điểm mấu chốt

extraResources:
  - from: resources
    to: resources
    filter: ["**/*"]

win:
  target:
    - target: nsis
      arch: [x64]

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  allowElevation: true
  include: installer/custom.nsh   # Script NSH tùy chỉnh (xem mục 6)
  artifactName: "${productName}-Setup-${version}.${ext}"

publish:
  provider: github
  owner: Mankhb2k
  repo: openclaw-1click
```

### 2.2 Build pipeline

```
npm run build:ts
    ↓
electron-builder --win nsis          # tạo OpenClaw-Setup-X.Y.Z.exe (~50 MB)
    ↓
Tạo backend-bundle-vX.Y.Z.tar.gz    # toàn bộ node_modules được nén lại
    ↓
Tải cả 2 lên GitHub Releases:
    - OpenClaw-Setup-X.Y.Z.exe       (installer chính)
    - backend-bundle-vX.Y.Z.tar.gz   (dependencies riêng)
    - latest.yml                      (electron-updater manifest)
    - backend-manifest.json           (version + hash của bundle)
```

### 2.3 Script tạo backend-bundle

```bash
# scripts/pack-backend-bundle.mjs
# Nén toàn bộ node_modules + openclaw.mjs vào tar.gz
tar -czf release/backend-bundle-v${VERSION}.tar.gz \
  --exclude="node_modules/**/*.map" \
  --exclude="node_modules/openclaw/docs" \
  --exclude="node_modules/node-llama-cpp/llama" \
  --exclude="node_modules/pdfjs-dist/web" \
  --exclude="node_modules/playwright-core/.local-browsers" \
  node_modules/

# Tạo manifest
node -e "
const hash = require('crypto').createHash('sha256')
  .update(fs.readFileSync('release/backend-bundle-v${VERSION}.tar.gz'))
  .digest('hex');
fs.writeFileSync('release/backend-manifest.json', JSON.stringify({
  version: '${VERSION}',
  backendVersion: require('./node_modules/openclaw/package.json').version,
  sha256: hash,
  url: 'https://github.com/Mankhb2k/openclaw-1click/releases/download/v${VERSION}/backend-bundle-v${VERSION}.tar.gz'
}));
"
```

---

## 3. Luồng First-Run: tải và cài dependencies

### 3.1 Sơ đồ luồng

```
app.exe khởi động lần đầu
    │
    ▼
app/main/setup-wizard.ts: kiểm tra
  path.join(dataRoot, 'backend', 'node_modules', 'openclaw')
    │
    ├─ EXISTS → khởi động gateway bình thường (hiện tại)
    │
    └─ NOT EXISTS → hiện BrowserWindow "First Run Setup"
          │
          ▼
        Bước 1: Fetch backend-manifest.json từ GitHub
          (kiểm tra version, hash, dung lượng)
          │
          ▼
        Bước 2: Tải backend-bundle-vX.Y.Z.tar.gz
          Progress bar: bytes downloaded / total
          (dùng electron net.request hoặc axios với onDownloadProgress)
          │
          ▼
        Bước 3: Verify SHA-256
          │
          ▼
        Bước 4: Giải nén tar.gz vào dataRoot/backend/
          (dùng package 'tar' — đã có trong dependencies)
          │
          ▼
        Bước 5: Ghi dataRoot/backend-version.json
          { installedVersion, installedAt, backendVersion }
          │
          ▼
        Khởi động gateway với OPENCLAW_APP_ROOT = dataRoot/backend
```

### 3.2 IPC events cho UI progress

```typescript
// Renderer nhận:
ipcRenderer.on('setup:progress', (_, { step, percent, message }) => { ... })
// step: 'fetch-manifest' | 'download' | 'verify' | 'extract' | 'done' | 'error'

// Main gửi:
mainWindow.webContents.send('setup:progress', {
  step: 'download',
  percent: 45.2,
  message: 'Đang tải dependencies (230 MB / 510 MB)...'
})
```

### 3.3 Xử lý offline / lỗi mạng

- Retry tối đa 3 lần với exponential backoff
- Resume download nếu bị ngắt (HTTP Range header)
- Lưu file `.partial` trong temp, chỉ move sang thư mục thật sau khi verify hash
- Nếu không có internet: hiện thông báo với link tải thủ công

---

## 4. Quy trình update 1 chạm

### 4.1 Hai kênh update độc lập

```
┌─────────────────────────────────────────────────────────────────┐
│  KÊNH 1: Electron Shell Update (đã có)                          │
│  electron-updater → kiểm tra latest.yml trên GitHub Releases    │
│  Tải OpenClaw-Setup-X.Y.Z.exe delta → cài silent → restart      │
├─────────────────────────────────────────────────────────────────┤
│  KÊNH 2: Backend Bundle Update (mới)                            │
│  Kiểm tra backend-manifest.json → so sánh với backend-version.json │
│  Tải backend-bundle-vX.Y.Z.tar.gz → verify → giải nén          │
│  Không cần restart Electron — chỉ cần restart gateway process  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Logic kiểm tra update

```typescript
// app/main/updater.ts
async function checkAllUpdates() {
  // Update 1: Electron shell (đã có trong main.ts)
  await checkDesktopUpdates()  // dùng electron-updater

  // Update 2: Backend bundle
  const manifest = await fetchBackendManifest()
  const installed = readInstalledBackendVersion(dataRoot)
  
  if (manifest.version !== installed.version) {
    sendToRenderer('backend:update-available', {
      currentVersion: installed.backendVersion,
      newVersion: manifest.backendVersion,
      size: manifest.compressedSize,
    })
  }
}
```

### 4.3 Sequence update 1 chạm từ UI

```
User bấm "Cập nhật ngay"
    │
    ├─ Nếu có Electron update → download + quitAndInstall
    │    (toàn bộ được restart, bao gồm backend mới nếu bundle đi kèm)
    │
    └─ Nếu chỉ có backend update:
          ├─ Tải backend-bundle mới vào dataRoot/backend-new/
          ├─ Verify hash
          ├─ Dừng gateway process (treeKill)
          ├─ rename backend/ → backend-old/, backend-new/ → backend/
          ├─ Khởi động lại gateway
          └─ Xóa backend-old/ sau khi gateway ready
```

### 4.4 Rollback tự động

```typescript
// Nếu gateway không start được sau 30s:
async function rollbackBackend() {
  await treeKill(gatewayChild.pid)
  fs.renameSync(backendDir, backendBrokenDir)
  fs.renameSync(backendOldDir, backendDir)  // restore backup
  startBackendLauncher(dataRoot)
}
```

---

## 5. So sánh: Split vs Full-Bundle

### 5.1 Bảng so sánh

| Tiêu chí | Full-Bundle (hiện tại) | Split (đề xuất) |
|---|---|---|
| **Kích thước installer** | ~500–800 MB | ~50–80 MB |
| **Tốc độ tải lần đầu** | Chậm (1 file lớn) | Tổng bằng nhau, nhưng UX tốt hơn |
| **Cài đặt offline** | Hoàn toàn offline | Cần internet lần đầu |
| **Update Electron shell** | Tải toàn bộ EXE mới | Tải EXE delta nhỏ |
| **Update backend** | Phải tải toàn bộ EXE mới | Tải chỉ backend-bundle |
| **Phức tạp kỹ thuật** | Đơn giản | Phức tạp hơn đáng kể |
| **Điểm lỗi** | Ít | Nhiều hơn (download, verify, extract) |
| **Trải nghiệm user** | Cài 1 lần, chạy ngay | Phải đợi download lần đầu |
| **Antivirus / SmartScreen** | Hay bị flag vì EXE lớn | EXE nhỏ ít bị flag hơn |
| **Vá bảo mật nhanh** | Deploy lại toàn bộ | Update backend riêng không cần restart toàn bộ |
| **Quản lý phiên bản** | 1 version duy nhất | 2 version (shell + backend) |
| **Tương thích openclaw ESM** | Đã xử lý (asar: false) | Giữ nguyên, không ảnh hưởng |

### 5.2 Ưu điểm của Split

- **Installer nhỏ**: Upload và tải xuống nhanh hơn 10×
- **Update linh hoạt**: Có thể cập nhật openclaw gateway mà không cần build EXE mới
- **A/B testing dễ**: Thay backend version mà không đụng Electron shell
- **Hotfix backend**: Vá lỗi `openclaw` npm package trong vòng phút mà không deploy EXE

### 5.3 Nhược điểm của Split

- **Bắt buộc có internet lần đầu** — không phù hợp môi trường airgap
- **Độ phức tạp tăng mạnh**: thêm download engine, hash verify, atomic extract, rollback
- **Rủi ro partial state**: nếu mất điện giữa chừng extract → app không chạy được
- **Windows Defender**: tải file `.tar.gz` từ internet rồi giải nén có thể bị scan chậm
- **GitHub Rate Limit**: manifest fetch và download phụ thuộc GitHub API/CDN
- **Debugging khó hơn**: bug có thể nằm ở layer download/extract thay vì logic app
- **2 version cần track**: không thể dùng `app.getVersion()` đơn giản để biết backend version

---

## 6. Tính khả thi với NSIS

### 6.1 Những gì NSIS làm tốt

```nsis
; installer/custom.nsh
!macro customInstall
  ; Tạo thư mục data root
  CreateDirectory "$APPDATA\OpenClaw"
  
  ; Ghi registry cho uninstaller
  WriteRegStr HKCU "Software\OpenClaw" "DataRoot" "$APPDATA\OpenClaw"
  
  ; Tùy chọn: detect Node.js version nếu muốn dùng system node
  ExecWait 'node --version' $0
  
  ; Tùy chọn: check .NET hoặc VC++ Redist nếu cần
!macroend

!macro customUninstall
  ; Hỏi user có muốn xóa %APPDATA%\OpenClaw không
  MessageBox MB_YESNO "Xóa toàn bộ dữ liệu OpenClaw?" IDNO skip_data_delete
  RMDir /r "$APPDATA\OpenClaw"
  skip_data_delete:
!macroend
```

### 6.2 Giới hạn của NSIS trong kịch bản này

| Việc | NSIS làm được? | Ghi chú |
|---|---|---|
| Cài file EXE nhỏ | Có | Dễ dàng |
| Tải file từ internet trong quá trình cài | Có (NSISdl) | Nhưng UX xấu, không có progress đẹp |
| Verify SHA-256 | Có (Crypto plugin) | Cần thêm plugin |
| Giải nén .tar.gz | Không trực tiếp | NSIS chỉ hiểu .zip và .7z; cần dùng tar.exe (Windows 10+) hoặc 7-zip plugin |
| Fallback nếu tải lỗi | Phức tạp | Logic NSIS cồng kềnh |
| **Khuyến nghị** | **Để Electron làm** | NSIS chỉ cài EXE; Electron xử lý download+extract |

### 6.3 Kiến trúc khuyến nghị với NSIS

```
NSIS chỉ làm:
  ✓ Cài OpenClaw.exe vào Program Files
  ✓ Tạo shortcut Desktop + Start Menu
  ✓ Ghi Uninstall registry entry
  ✓ Tạo thư mục %APPDATA%\OpenClaw

Electron làm (sau khi NSIS xong):
  ✓ Detect lần đầu chạy (không có backend-version.json)
  ✓ Hiện First Run Setup wizard
  ✓ Download + verify + extract backend-bundle
  ✓ Manage updates sau này
```

### 6.4 Cấu hình NSIS trong electron-builder.yml

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  allowElevation: true
  installerIcon: assets/icon.ico
  uninstallerIcon: assets/icon.ico
  createDesktopShortcut: always
  createStartMenuShortcut: true
  include: installer/custom.nsh
  artifactName: "${productName}-Setup-${version}.${ext}"
  # KHÔNG dùng NSISdl để tải dependencies — để Electron xử lý
```

---

## 7. Yêu cầu để luồng hoạt động hiệu quả

### 7.1 Yêu cầu kỹ thuật bắt buộc

#### a) GitHub Releases phải có đủ 3 artifacts mỗi release

```
openclaw-1click / releases / vX.Y.Z /
  ├── OpenClaw-Setup-X.Y.Z.exe          # NSIS installer
  ├── OpenClaw-Setup-X.Y.Z.exe.blockmap # delta update
  ├── latest.yml                         # electron-updater manifest
  ├── backend-bundle-vX.Y.Z.tar.gz      # node_modules được nén
  └── backend-manifest.json              # version + sha256 + url + size
```

#### b) `backend-manifest.json` schema

```json
{
  "version": "1.2.3",
  "backendVersion": "2026.4.5",
  "sha256": "abc123...",
  "compressedSize": 524288000,
  "uncompressedSize": 1073741824,
  "url": "https://github.com/.../backend-bundle-v1.2.3.tar.gz",
  "minElectronVersion": "1.0.0",
  "releaseNotes": { "vi": "Cập nhật openclaw lên 2026.4.5", "en": "..." }
}
```

#### c) `tar` package đã có trong dependencies

```json
// package.json — đã có: "tar": "7.5.13"
```

#### d) Atomic extract pattern

```typescript
// Không extract thẳng vào backend/, tránh partial state
const tempDir = path.join(dataRoot, `backend-extract-${Date.now()}`)
await extractTarGz(bundlePath, tempDir)
await verifyExtract(tempDir)  // kiểm tra openclaw/openclaw.mjs tồn tại
fs.renameSync(tempDir, backendDir)  // atomic rename
```

#### e) ENV_APP_ROOT phải trỏ đúng thư mục backend

```typescript
// Trong startBackendLauncher(), thay vì:
OPENCLAW_APP_ROOT: appRoot  // trỏ vào Program Files

// Dùng:
OPENCLAW_APP_ROOT: path.join(dataRoot, 'backend')  // trỏ vào %APPDATA%
```

### 7.2 Yêu cầu về UX

- **Progress window** phải hiện ngay khi app khởi động lần đầu, trước khi có gateway
- **Không đóng được app** trong khi đang extract (hoặc phải handle cleanup)
- **Thông báo rõ ràng**: "Lần đầu sử dụng, cần tải ~500 MB dependencies"
- **Estimated time** dựa trên speed download thực tế
- **Retry button** nếu tải thất bại

### 7.3 Yêu cầu về CI/CD

```yaml
# .github/workflows/release.yml
jobs:
  build:
    steps:
      - name: Build Electron EXE
        run: npm run dist:nsis
      
      - name: Pack backend bundle
        run: node scripts/pack-backend-bundle.mjs
      
      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          files: |
            release/OpenClaw-Setup-*.exe
            release/OpenClaw-Setup-*.exe.blockmap
            release/latest.yml
            release/backend-bundle-*.tar.gz
            release/backend-manifest.json
```

### 7.4 Yêu cầu về bảo mật

- Luôn verify SHA-256 trước khi extract — không bao giờ extract file chưa verify
- Dùng HTTPS để fetch manifest và tải bundle
- Không cache manifest quá 1 giờ
- Validate `minElectronVersion` trong manifest để tránh backend mới không tương thích shell cũ

---

## 8. Roadmap triển khai

### Phase 1 — Foundation (ưu tiên cao)

- [ ] Tạo `scripts/pack-backend-bundle.mjs`
- [ ] Tạo `scripts/generate-backend-manifest.mjs`
- [ ] Tạo `app/main/backend-setup.ts` — download + verify + extract engine
- [ ] Tạo First Run Setup BrowserWindow (HTML + IPC)
- [ ] Cập nhật `startBackendLauncher` dùng `dataRoot/backend` thay vì `appRoot`

### Phase 2 — Update flow

- [ ] Tạo `app/main/backend-updater.ts` — check + update backend riêng
- [ ] Tích hợp vào `checkDesktopUpdates` flow hiện có
- [ ] UI hiển thị 2 badge update riêng (shell vs backend)
- [ ] Rollback logic + test case

### Phase 3 — CI/CD

- [ ] GitHub Actions workflow tự động pack và publish cả 2 artifacts
- [ ] Code signing cho backend-bundle (nếu cần)
- [ ] CDN mirror để tránh GitHub Rate Limit

### Phase 4 — Hardening

- [ ] Resume download sau khi mất kết nối
- [ ] Delta backend update (chỉ tải các packages thay đổi)
- [ ] Telemetry: track tỷ lệ thành công first-run setup

---

## Kết luận nhanh

**Nên chọn phương án nào?**

| Tình huống | Khuyến nghị |
|---|---|
| User cần cài offline / airgap | Full-Bundle (hiện tại) |
| Muốn installer nhỏ, update backend nhanh | Split |
| Team nhỏ, ưu tiên đơn giản | Full-Bundle |
| Cần hotfix openclaw gateway nhanh | Split |
| Kết hợp tốt nhất | Split installer + giữ Full-Bundle portable option |

**Với cấu hình NSIS hiện tại của dự án** (`oneClick: false`, `allowElevation: true`, `electron-updater` đã setup), phương án Split là **khả thi 100%** — chỉ cần thêm ~400 dòng TypeScript cho download/extract engine và không cần thay đổi cấu hình NSIS đáng kể.
