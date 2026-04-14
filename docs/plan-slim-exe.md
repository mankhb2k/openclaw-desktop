# Kế hoạch: Slim exe — chỉ UI, download backend sau install

> Mục tiêu: exe chỉ chứa Electron main process + Control UI (~50MB).
> Backend (openclaw + root-runtime) được download sau khi install xong,
> ngay lần đầu mở app.
> Cập nhật: 2026-04-14

---

## Tổng quan kiến trúc mới

```
[NSIS installer]
  → Cài exe vào Program Files                (~50MB, nhanh)
  → Chạy app lần đầu (runAfterFinish = true)

[App lần đầu chạy — Setup Screen]
  → Phát hiện không có backend layers
  → Hiển thị cửa sổ "Đang cài đặt backend..."
  → Download layer-root-runtime + layer-openclaw từ GitHub Releases
  → Extract → hoist → verify
  → Khởi động gateway → load Control UI

[App từ lần 2 trở đi]
  → Split mode sẵn sàng → vào thẳng Control UI
  → Layer updater tự kiểm tra update trong background
```

---

## Lý do KHÔNG download trong NSIS installer

NSIS chạy với quyền admin. `%APPDATA%` trong context admin trỏ đến
`C:\Windows\System32\...` hoặc `C:\Users\Administrator\...`, KHÔNG phải
AppData của user thực. Backend phải nằm trong AppData của user → cần
chạy ở user context.

Giải pháp sạch nhất: electron-builder có `nsis.runAfterFinish: true`
(default) → app tự chạy AS USER sau khi NSIS kết thúc → download đúng
AppData của user.

---

## Các bước thực hiện

### Bước 1 — Xóa openclaw khỏi `package.json` dependencies

`@buape/carbon` và `@larksuiteoapi/node-sdk` chỉ cần khi bundle openclaw
vào exe (npm dedup issue). Khi không bundle nữa, bỏ luôn.

```json
// package.json — dependencies sau khi slim
"dependencies": {
  "axios": "^1.13.6",
  "tree-kill": "^1.2.2",
  "electron-updater": "^6.8.3"
}
```

> `openclaw`, `@buape/carbon`, `@larksuiteoapi/node-sdk` → xóa khỏi dependencies.
> Chúng vẫn được download theo layers từ GitHub Releases.

---

### Bước 2 — Cập nhật `electron-builder.yml`

Thêm exclusions cho openclaw và extension deps:

```yaml
files:
  - dist/**/*
  - assets/icon.ico
  - package.json
  - node_modules/**/*
  - "!**/*.map"

  # ── SLIM: Loại openclaw và extension deps ──────────────────────
  # Chúng sẽ được download dưới dạng layers, không bundle vào exe.
  - "!node_modules/openclaw/**"
  - "!node_modules/@buape/**"
  - "!node_modules/@larksuiteoapi/**"

  # ── Các exclusions hiện tại (giữ nguyên) ──────────────────────
  - "!node_modules/openclaw/dist/extensions/*/node_modules/**"
  - "!node_modules/node-llama-cpp/llama/**"
  # ... rest unchanged

  - "vendor/control-ui/**/*"
```

Kết quả: exe ~300MB → ~30-50MB.

---

### Bước 3 — Tạo setup window HTML

File: `app/setup.html` — hiển thị trong BrowserWindow trước khi gateway sẵn sàng.

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>OpenClaw Desktop — Setup</title>
  <style>
    body { font-family: system-ui; background: #1a1a1a; color: #eee;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; height: 100vh; margin: 0; gap: 16px; }
    .bar-wrap { width: 320px; background: #333; border-radius: 4px; height: 8px; }
    .bar      { height: 8px; background: #4ade80; border-radius: 4px;
                width: 0%; transition: width 0.3s; }
    .status   { font-size: 13px; color: #aaa; }
    .error    { color: #f87171; }
    button    { padding: 8px 20px; background: #4ade80; color: #000;
                border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
  </style>
</head>
<body>
  <h2 style="margin:0">OpenClaw Desktop</h2>
  <p id="status" class="status">Đang kiểm tra backend...</p>
  <div class="bar-wrap"><div id="bar" class="bar"></div></div>
  <button id="retry" style="display:none" onclick="window.electronAPI.retrySetup()">
    Thử lại
  </button>
  <script>
    window.electronAPI.onSetupProgress(({ phase, progressPercent, message }) => {
      document.getElementById('status').textContent = message || phase;
      document.getElementById('bar').style.width = (progressPercent || 0) + '%';
      if (phase === 'error') {
        document.getElementById('status').className = 'status error';
        document.getElementById('retry').style.display = 'block';
      }
    });
  </script>
</body>
</html>
```

---

### Bước 4 — Cập nhật `main.ts`

#### 4a. Thêm preload script cho setup window

File: `app/main/setup-preload.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onSetupProgress: (cb: (data: unknown) => void) =>
    ipcRenderer.on('setup:progress', (_e, data) => cb(data)),
  retrySetup: () => ipcRenderer.send('setup:retry'),
});
```

#### 4b. Thay đổi `launchApp()` trong main.ts

```typescript
// Hiện tại:
async function launchApp() {
  // ...
  const controlUiUrl = await startGatewayAndWait(dataRoot);
  mainWindow.loadURL(controlUiUrl);
}

// Sau khi sửa — thêm check split mode:
async function launchApp() {
  const dataRoot = resolveDataRoot();

  // Lần đầu chạy: backend chưa được cài
  if (app.isPackaged && !isSplitModeReady(dataRoot)) {
    await runInitialBackendSetup(dataRoot);
    // Sau setup xong, tiếp tục bình thường
  }

  const controlUiUrl = await startGatewayAndWait(dataRoot);
  mainWindow.loadURL(controlUiUrl);
}
```

#### 4c. Thêm hàm `runInitialBackendSetup()`

```typescript
async function runInitialBackendSetup(dataRoot: string): Promise<void> {
  // 1. Tải setup.html vào mainWindow (thay vì gateway URL)
  mainWindow.loadFile(path.join(__dirname, '..', 'setup.html'));

  // 2. Chạy updateBackendLayers với callback gửi progress về setup.html
  await updateBackendLayers({
    manifestUrl: BACKEND_MANIFEST_URL,
    dataRoot,
    currentVersions: {},          // lần đầu: không có version nào
    onProgress: (state) => {
      mainWindow?.webContents.send('setup:progress', {
        phase: state.phase,
        progressPercent: state.progressPercent,
        message: getSetupMessage(state.phase),
      });
    },
    // Không cần kill gateway (chưa chạy)
    killGateway: async () => {},
    restartGateway: async () => {},
  });
}

function getSetupMessage(phase: LayerUpdatePhase): string {
  const msgs: Record<string, string> = {
    checking:      'Đang kiểm tra phiên bản...',
    downloading:   'Đang tải backend...',
    verifying:     'Đang xác minh...',
    extracting:    'Đang giải nén...',
    hoisting:      'Đang cấu hình...',
    complete:      'Hoàn tất!',
    error:         'Cài đặt thất bại.',
  };
  return msgs[phase] || phase;
}
```

#### 4d. IPC handler cho retry

```typescript
ipcMain.on('setup:retry', () => {
  runInitialBackendSetup(resolveDataRoot()).then(() => {
    const dataRoot = resolveDataRoot();
    startGatewayAndWait(dataRoot).then((url) => mainWindow?.loadURL(url));
  });
});
```

---

### Bước 5 — Cập nhật tsconfig.json

Thêm `app/setup.html` vào build output và `app/main/setup-preload.ts`:

```json
// tsconfig.json — giữ nguyên, chỉ thêm preload vào include
"include": ["app/**/*.ts"]   // đã cover setup-preload.ts
```

Cập nhật `electron-builder.yml` để include setup.html:
```yaml
files:
  - dist/**/*
  - app/setup.html        # ← thêm vào
  - ...
```

Hoặc copy setup.html vào `dist/` qua build script.

---

### Bước 6 — Cập nhật `electron-builder.yml` — NSIS

```yaml
nsis:
  # ... existing settings
  runAfterFinish: true      # (default) — app chạy sau install AS USER
                            # → user context đúng → AppData đúng
```

Không cần NSIS plugin download. Installer nhỏ, nhanh. App tự lo backend.

---

## Luồng hoàn chỉnh

```
User chạy installer
  ↓
NSIS cài exe + vendor/control-ui/ + dist/ vào Program Files
  [~30s, không cần mạng]
  ↓
NSIS chạy app (runAfterFinish)
  ↓
App khởi động → phát hiện không có backend/
  ↓
Setup window hiện ra:
  "Đang tải backend..." [████░░░░] 45%
  ↓ (download ~30MB qua mạng)
  ↓
Backend ready → gateway khởi động
  ↓
Control UI load tại http://127.0.0.1:18789/
  ↓
Lần sau mở app: thẳng Control UI (split mode ready)
```

---

## Ước tính thay đổi kích thước

| | Trước | Sau |
|---|---|---|
| NSIS installer | ~300MB | ~50MB |
| Thời gian install (local) | ~2 phút | ~15 giây |
| Thời gian first launch | tức thì | ~30-60s (download ~30MB) |
| Update backend | rebuild exe | push layers (~30MB) |

---

## Rủi ro và xử lý

| Rủi ro | Xử lý |
|---|---|
| Không có mạng khi first launch | Hiển thị lỗi + nút "Thử lại" trong setup window |
| Download bị gián đoạn | File `.partial` pattern đã có — retry từ đầu |
| SHA-256 mismatch | updateBackendLayers đã xử lý → báo lỗi |
| Backend manifest URL sai | Env var `OPENCLAW_BACKEND_MANIFEST_URL` override được |

---

## Thứ tự thực hiện

- [ ] Bước 1: Slim `package.json` dependencies
- [ ] Bước 2: Thêm exclusions vào `electron-builder.yml`
- [ ] Bước 3: Tạo `app/setup.html`
- [ ] Bước 4: Sửa `main.ts` — thêm `runInitialBackendSetup()`
- [ ] Bước 4: Tạo `app/main/setup-preload.ts`
- [ ] Bước 5: Update tsconfig / build để copy setup.html vào dist/
- [ ] Bước 6: Build + test với `npm run layer:install-local` (giả lập có backend)
- [ ] Bước 7: Test first-launch flow (xóa backend/ trong AppData trước khi chạy)
- [ ] Bước 8: Build exe và kiểm tra kích thước
