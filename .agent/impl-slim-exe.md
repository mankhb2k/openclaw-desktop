# Implement: Slim exe + First-run backend download

> Kế hoạch implement chi tiết dựa trên plan-slim-exe.md.
> Cập nhật: 2026-04-14

---

## Tổng quan thay đổi

| File | Loại | Mô tả |
|---|---|---|
| `package.json` | Sửa | Xóa 3 deps (openclaw, @buape, @larksuiteoapi) |
| `electron-builder.yml` | Sửa | Exclude openclaw khỏi bundle |
| `resources/setup.html` | Tạo mới | Setup screen (progress bar + nút Download) |
| `app/main/setup-preload.ts` | Tạo mới | contextBridge cho setup window |
| `app/main/main.ts` | Sửa | First-run detection + setup flow |

---

## Bước 1 — `package.json`: Xóa bundled backend deps

```diff
 "dependencies": {
-  "openclaw": "2026.4.5",
   "axios": "^1.13.6",
   "tree-kill": "^1.2.2",
-  "electron-updater": "^6.8.3",
-  "@buape/carbon": "0.14.0",
-  "@larksuiteoapi/node-sdk": "1.60.0"
+  "electron-updater": "^6.8.3"
 }
```

> `@buape/carbon` và `@larksuiteoapi/node-sdk` chỉ cần khi bundle openclaw
> (npm dedup issue). Không bundle → không cần khai báo.

Sau đó chạy lại:
```bash
npm install
```

---

## Bước 2 — `electron-builder.yml`: Exclude openclaw khỏi bundle

Thêm vào block `files:`, sau dòng `"!**/*.map"`:

```yaml
  # ── SLIM: Loại openclaw và extension deps ra khỏi exe ──────────────
  # Chúng được download dưới dạng layers, không bundle vào exe.
  - "!node_modules/openclaw/**"
  - "!node_modules/@buape/**"
  - "!node_modules/@larksuiteoapi/**"
```

---

## Bước 3 — `resources/setup.html`: Setup screen

File này được electron-builder copy vào installer qua `extraResources`
(đã config sẵn trong `electron-builder.yml`).

Truy cập trong app:
```typescript
// packaged
path.join(process.resourcesPath, 'resources', 'setup.html')
// dev
path.resolve(getProjectRoot(), 'resources', 'setup.html')
```

Nội dung `resources/setup.html`:

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; style-src 'unsafe-inline'">
  <title>OpenClaw Desktop</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #0e1015; color: #e2e8f0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      height: 100vh; gap: 20px; padding: 32px;
    }
    h1 { font-size: 22px; font-weight: 600; }
    .subtitle { font-size: 13px; color: #64748b; text-align: center; }
    .card {
      background: #1e2330; border: 1px solid #2d3748;
      border-radius: 10px; padding: 28px 32px;
      width: 100%; max-width: 440px;
      display: flex; flex-direction: column; gap: 16px;
    }
    .bar-wrap {
      background: #2d3748; border-radius: 4px; height: 6px; overflow: hidden;
    }
    .bar {
      height: 6px; background: #22c55e; border-radius: 4px;
      width: 0%; transition: width 0.25s ease;
    }
    .status { font-size: 13px; color: #94a3b8; min-height: 18px; }
    .status.error { color: #f87171; }
    .status.ok    { color: #22c55e; }
    button {
      padding: 10px 20px; border: none; border-radius: 6px;
      font-size: 14px; font-weight: 500; cursor: pointer;
      transition: opacity 0.15s;
    }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    #btn-download { background: #22c55e; color: #000; }
    #btn-retry    { background: #334155; color: #e2e8f0; display: none; }
  </style>
</head>
<body>
  <h1>OpenClaw Desktop</h1>
  <p class="subtitle">Backend cần được tải về lần đầu (~30 MB).<br>
     Quá trình này chỉ thực hiện một lần.</p>

  <div class="card">
    <div class="bar-wrap"><div id="bar" class="bar"></div></div>
    <p id="status" class="status">Sẵn sàng tải backend.</p>
    <button id="btn-download" onclick="startDownload()">Tải backend</button>
    <button id="btn-retry"    onclick="retry()">Thử lại</button>
  </div>

  <script>
    const bar        = document.getElementById('bar');
    const statusEl   = document.getElementById('status');
    const btnDownload = document.getElementById('btn-download');
    const btnRetry    = document.getElementById('btn-retry');

    const phaseLabel = {
      checking:       'Đang kiểm tra...',
      downloading:    'Đang tải...',
      verifying:      'Đang xác minh...',
      extracting:     'Đang giải nén...',
      hoisting:       'Đang cấu hình...',
      swapping:       'Đang áp dụng...',
      complete:       'Hoàn tất! Đang khởi động...',
      error:          'Lỗi!',
    };

    function startDownload() {
      btnDownload.disabled = true;
      btnRetry.style.display = 'none';
      statusEl.className = 'status';
      window.setupAPI.startDownload();
    }

    function retry() {
      btnDownload.disabled = false;
      btnRetry.style.display = 'none';
      bar.style.width = '0%';
      statusEl.textContent = 'Sẵn sàng tải backend.';
      statusEl.className = 'status';
    }

    window.setupAPI.onProgress((state) => {
      const pct = state.progressPercent ?? (state.phase === 'complete' ? 100 : 0);
      bar.style.width = pct + '%';
      statusEl.textContent = state.message || phaseLabel[state.phase] || state.phase;

      if (state.phase === 'error') {
        statusEl.className = 'status error';
        btnDownload.disabled = false;
        btnRetry.style.display = 'block';
      } else if (state.phase === 'complete') {
        statusEl.className = 'status ok';
      }
    });
  </script>
</body>
</html>
```

---

## Bước 4 — `app/main/setup-preload.ts`: contextBridge

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('setupAPI', {
  /** Renderer gọi khi user bấm nút "Tải backend" */
  startDownload: () => ipcRenderer.send('setup:start-download'),

  /** Main process gửi progress về renderer */
  onProgress: (cb: (state: {
    phase: string;
    progressPercent?: number;
    message?: string;
  }) => void) => {
    ipcRenderer.on('setup:progress', (_e, state) => cb(state));
  },
});
```

---

## Bước 5 — `app/main/main.ts`: First-run flow

### 5a. Thêm import

```typescript
// Thêm vào phần imports
import { isSplitModeReady, updateBackendLayers, /* existing imports */ } from './layer-updater';
```
*(đã có sẵn — không cần thêm)*

### 5b. Thêm helper: `resolveSetupHtmlPath()`

Thêm sau `getDataRoot()`:

```typescript
function resolveSetupHtmlPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'resources', 'setup.html');
  }
  return path.resolve(getProjectRoot(), 'resources', 'setup.html');
}
```

### 5c. Sửa `createWindow()` — thêm first-run check

Hàm `createWindow()` hiện tại (dòng 864):
```typescript
async function createWindow(): Promise<void> {
  const dataRoot = getDataRoot();
  const controlUiUrl = await ensureBackendAndGetUrl(dataRoot);  // ← BLOCKS
  // ... tạo window, loadURL(controlUiUrl)
}
```

Sửa thành:
```typescript
async function createWindow(): Promise<void> {
  const dataRoot = getDataRoot();

  // ── First-run: backend chưa được cài → setup screen ────────────────
  if (app.isPackaged && !isSplitModeReady(dataRoot)) {
    await runSetupFlow(dataRoot);
    return; // runSetupFlow tự tạo window và navigate
  }

  // ── Normal startup ──────────────────────────────────────────────────
  const controlUiUrl = await ensureBackendAndGetUrl(dataRoot);
  currentGatewayWsUrl = controlUiUrl.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`);
  await createMainWindowAndLoad(controlUiUrl);
}
```

### 5d. Thêm `runSetupFlow()`

```typescript
async function runSetupFlow(dataRoot: string): Promise<void> {
  // Tạo window với setup preload
  const windowIcon = resolveWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    show: false,
    backgroundColor: '#0e1015',
    title: 'OpenClaw Desktop — Setup',
    ...(process.platform === 'win32'
      ? { icon: nativeImage.createEmpty() }
      : windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'setup-preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  await mainWindow.loadFile(resolveSetupHtmlPath());

  // Đăng ký taskbar progress (Windows)
  mainWindow.setProgressBar(0);

  // Lắng nghe nút "Tải backend" từ renderer
  ipcMain.once('setup:start-download', () => {
    void performInitialDownload(dataRoot);
  });
}
```

### 5e. Thêm `performInitialDownload()`

```typescript
async function performInitialDownload(dataRoot: string): Promise<void> {
  function sendProgress(state: LayerUpdateState): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('setup:progress', state);
    // Taskbar progress bar (Windows native)
    if (typeof state.progressPercent === 'number') {
      mainWindow.setProgressBar(state.progressPercent / 100);
    }
  }

  try {
    await updateBackendLayers({
      dataRoot,
      manifestUrl: BACKEND_MANIFEST_URL,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '35.7.5',
      projectRoot: getProjectRoot(),
      onProgress: sendProgress,
    });

    // Download xong → reset progress bar
    mainWindow?.setProgressBar(-1);

    // Chuyển sang Control UI (bình thường)
    const controlUiUrl = await ensureBackendAndGetUrl(dataRoot);
    currentGatewayWsUrl = controlUiUrl.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      // Resize về kích thước bình thường trước khi load Control UI
      mainWindow.setResizable(true);
      mainWindow.setSize(1280, 800);
      mainWindow.setMinimumSize(MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT);
      mainWindow.setTitle(dashboardWindowTitle());
      wireControlUiExternalLinks(mainWindow.webContents, controlUiUrl);
      registerDesktopUpdateHandler();
      await mainWindow.loadURL(controlUiUrl);
      scheduleBackendLayerCheck(dataRoot);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendProgress({ phase: 'error', error: msg });
    mainWindow?.setProgressBar(-1);
  }
}
```

### 5f. Extract `createMainWindowAndLoad()` (refactor nhỏ)

Phần tạo window + loadURL hiện có trong `createWindow()` → extract ra hàm riêng để dùng chung:

```typescript
async function createMainWindowAndLoad(controlUiUrl: string): Promise<void> {
  const windowIcon = resolveWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: MAIN_WINDOW_MIN_WIDTH, minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false, backgroundColor: '#0e1015',
    title: dashboardWindowTitle(),
    ...(process.platform === 'win32'
      ? { icon: nativeImage.createEmpty() }
      : windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'preload-control-ui.js'),
    },
  });
  // ... (toàn bộ event handlers hiện tại)
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  await mainWindow.loadURL(controlUiUrl);
  // ...
}
```

---

## Thứ tự implement (tránh breaking changes)

```
1. Bước 3: Tạo resources/setup.html          (không ảnh hưởng existing code)
2. Bước 4: Tạo app/main/setup-preload.ts     (không ảnh hưởng existing code)
3. Bước 5b: Thêm resolveSetupHtmlPath()      (helper, không ảnh hưởng)
4. Bước 5c-f: Sửa createWindow()             (refactor + thêm first-run flow)
   → Test trong dev mode (app.isPackaged = false → bỏ qua first-run)
5. Bước 1: Slim package.json                 (xóa deps)
   → npm install
6. Bước 2: Slim electron-builder.yml         (exclude openclaw)
7. Build exe và test:
   a. npm run build:ts
   b. npm run dist:installer
   c. Cài installer → app tự launch → hiện setup screen → bấm Tải
   d. Verify: %APPDATA%\OpenClaw\backend\ được tạo đúng
   e. Restart app → vào thẳng Control UI (split mode)
```

---

## Test cases

| Case | Cách test | Expect |
|---|---|---|
| First launch | Xóa `%APPDATA%\OpenClaw\backend\` → chạy app | Setup screen hiện, nút Tải backend |
| Download progress | Bấm Tải | Thanh progress chạy, taskbar icon nhấp nháy |
| Download complete | Chờ xong | Setup screen chuyển thành Control UI |
| Lần 2 trở đi | Đóng mở lại app | Thẳng Control UI, không hiện setup |
| Mất mạng | Tắt wifi → bấm Tải | Hiện lỗi + nút Thử lại |
| Dev mode | `npm run dev` | Bỏ qua setup (app.isPackaged = false) |

---

## Lưu ý quan trọng

- `updateBackendLayers` **không** kill/restart gateway → dùng được cho first-run mà không cần stub
- `ipcMain.once` thay vì `ipcMain.on` → tránh duplicate handlers nếu user bấm nhiều lần
- `mainWindow.setProgressBar(-1)` để tắt taskbar progress sau khi xong
- setup-preload.ts compile ra `dist/main/setup-preload.js` via tsconfig `app/**/*.ts`
- Dev mode: `app.isPackaged === false` → `createWindow()` đi thẳng vào normal flow, không cần test setup screen qua `npm run dev`
