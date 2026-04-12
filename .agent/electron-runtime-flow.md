# Electron Runtime Flow — openclaw-electron

> Mô tả chi tiết luồng khởi động, vận hành, và tắt ứng dụng Electron.
> Tham chiếu: `openclaw-app/` là nguồn gốc kiến trúc; fork này kế thừa nguyên.

---

## Tổng quan kiến trúc

```
┌─────────────────────────────────────────────────────────────────┐
│                    NSIS .exe / Electron process                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Main Process  (dist/main/main.js)                       │   │
│  │   • Quản lý BrowserWindow                                │   │
│  │   • Spawn backend launcher qua ELECTRON_RUN_AS_NODE=1    │   │
│  │   • IPC handlers: desktop:update:*                       │   │
│  │   • Single-instance lock                                 │   │
│  └──────────────┬───────────────────────────────────────────┘   │
│                 │ spawn(ELECTRON_RUN_AS_NODE=1)                  │
│  ┌──────────────▼───────────────────────────────────────────┐   │
│  │  Backend Launcher  (dist/backend/start.js)               │   │
│  │   • Allocate TCP port                                    │   │
│  │   • Ensure gateway auth token                            │   │
│  │   • Spawn openclaw gateway CLI                           │   │
│  │   • Poll TCP → ghi launcher-ready.json                   │   │
│  └──────────────┬───────────────────────────────────────────┘   │
│                 │ spawn(openclaw gateway run --port PORT)        │
│  ┌──────────────▼───────────────────────────────────────────┐   │
│  │  OpenClaw Gateway  (node_modules/openclaw/dist/entry.js) │   │
│  │   • HTTP server :PORT                                    │   │
│  │   • WebSocket RPC                                        │   │
│  │   • Serve Control UI (built-in)                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Renderer / BrowserWindow                                │   │
│  │   loadURL(http://127.0.0.1:PORT/?#token=TOKEN)           │   │
│  │   preload.js → contextBridge openclawDesktop API         │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Luồng khởi động chi tiết

### Phase 1 — Electron main process khởi động

```
electron (exe)
  └─ main.js  ← dist/main/main.js
       │
       ├─ app.requestSingleInstanceLock()
       │    ├─ [FAIL] instance khác đang chạy → app.quit() ngay
       │    └─ [OK]   tiếp tục
       │
       └─ app.whenReady()
            ├─ nativeTheme.themeSource = 'system'
            ├─ registerDesktopUpdateHandler()   ← đăng ký IPC handlers
            ├─ initDesktopUpdater()             ← setup electron-updater (NSIS only)
            ├─ checkDesktopUpdates()            ← fetch update-notice.json từ GitHub
            ├─ buildApplicationMenu()           ← Windows: null / macOS: menu chuẩn
            ├─ registerGlobalShortcuts()        ← Ctrl+Shift+O mở Control UI ở browser
            ├─ runFirstLaunchOnboardingIfNeeded()  ← chỉ chạy lần đầu
            └─ createWindow()
```

### Phase 2 — Backend Launcher khởi động

```
main.js → launchBackend()
  │
  ├─ getDataRoot()
  │    ├─ Packaged:   %APPDATA%\openclaw-desktop\
  │    └─ Dev:        <projectRoot>/data/  (hoặc tương đương)
  │
  ├─ Xoá launcher-ready.json cũ nếu còn sót
  │
  ├─ resolveElectronRunnerPath()
  │    ├─ Packaged:   app.getPath('exe') → đường dẫn .exe thực (portable-safe)
  │    └─ Dev:        process.execPath
  │
  └─ spawn(electronRunner, ['dist/backend/start.js'], {
         ELECTRON_RUN_AS_NODE: '1',
         OPENCLAW_DESKTOP_DATA_ROOT: dataRoot,
         OPENCLAW_APP_ROOT: appRoot,
         OPENCLAW_CLI_SCRIPT: node_modules/openclaw/openclaw.mjs,
         OPENCLAW_SEED_WORKSPACE: resources/workspace/  (nếu tồn tại),
     })
```

### Phase 3 — start.js: khởi động gateway

```
start.js  (ELECTRON_RUN_AS_NODE=1, không có Electron APIs)
  │
  ├─ resolveDesktopPaths(dataRoot)
  │    → { workspaceDir, openclawDir, logsDir, openclawConfigFile, readyFile }
  │
  ├─ ensureDataLayout(paths)
  │    → mkdir -p workspaceDir, openclawDir, logsDir
  │
  ├─ maybeSeedWorkspace()
  │    → copy resources/workspace/ → workspaceDir nếu workspaceDir rỗng
  │
  ├─ ensureGatewayDesktopAuth(paths, appRoot)
  │    ├─ đọc openclaw.json (config file của gateway)
  │    ├─ nếu chưa có token: tạo crypto.randomBytes(24).toString('base64url')
  │    ├─ set gateway.auth.mode = 'token'
  │    ├─ ghi lại openclaw.json
  │    └─ return { tokenForUrl, basePath }
  │
  ├─ allocateGatewayPort(18789)
  │    → thử port 18789, 18790, 18791... cho đến khi tìm được port free
  │
  ├─ spawn(electronRunner, [openclaw.mjs, 'gateway', 'run',
  │         '--port', PORT, '--allow-unconfigured'], {
  │       ELECTRON_RUN_AS_NODE: '1',
  │       OPENCLAW_DATA_ROOT: openclawDir,
  │       OPENCLAW_WORKSPACE: workspaceDir,
  │       ...baseEnv
  │   })
  │    → stdout/stderr pipe → logsDir/openclaw-gateway.log
  │
  ├─ waitForTcpPort('127.0.0.1', PORT, timeout=120s)
  │    → poll TCP connect mỗi 200ms cho đến khi gateway accept connections
  │
  ├─ buildControlUiUrl(PORT, basePath, tokenForUrl)
  │    → 'http://127.0.0.1:PORT<basePath>/#token=TOKEN'  (nếu dùng token auth)
  │    → 'http://127.0.0.1:PORT<basePath>/'              (nếu không có token)
  │
  └─ writeFileSync(readyFile, {
         gatewayPort,
         controlUiUrl,
         dashboardUrl: controlUiUrl,   ← deprecated alias
         startedAt: ISO timestamp,
         pids: { openclawGateway: child.pid }
     })
       → launcher-ready.json ở dataRoot/
```

### Phase 4 — Main process đọc ready-file và tạo cửa sổ

```
main.js → createWindow()
  │
  ├─ waitForReadyFile(dataRoot, timeout=90s)
  │    → poll fs.existsSync(launcher-ready.json) mỗi 300ms
  │
  ├─ readReadyState(dataRoot)
  │    → parse launcher-ready.json → { controlUiUrl, gatewayPort }
  │
  ├─ new BrowserWindow({
  │       width: 1280, height: 800,
  │       minWidth: 1180, minHeight: 700,
  │       show: false,
  │       backgroundColor: '#0e1015',
  │       webPreferences: {
  │         contextIsolation: true,
  │         nodeIntegration: false,
  │         preload: 'dist/main/preload.js'
  │       }
  │   })
  │
  ├─ wireControlUiExternalLinks(webContents, controlUiUrl)
  │    → link http/https bên ngoài origin → shell.openExternal()
  │    → ngăn BrowserWindow mở tab mới
  │
  ├─ mainWindow.once('ready-to-show', () => mainWindow.show())
  │
  └─ mainWindow.loadURL(controlUiUrl)
       → BrowserWindow render Control UI từ gateway
       → preload.js expose window.openclawDesktop
```

---

## Luồng IPC: Renderer ↔ Main Process

```
Renderer (Control UI)                    Main Process
─────────────────────────────────────────────────────
window.openclawDesktop.getUpdateState()
  → ipcRenderer.invoke('desktop:update:get-state')
                                  ──────────────────►
                                  ipcMain.handle('desktop:update:get-state')
                                    return desktopUpdateState
                                  ◄──────────────────
  ← Promise<DesktopUpdateState>

window.openclawDesktop.checkForUpdates()
  → ipcRenderer.invoke('desktop:update:check')
                                  ──────────────────►
                                  checkDesktopUpdates()
                                    autoUpdater.checkForUpdates()
                                    fetch update-notice.json (GitHub)
                                    cập nhật desktopUpdateState
                                    publishDesktopUpdateState() → ipcMain.send
                                  ◄──────────────────
  ← Promise<DesktopUpdateState>

window.openclawDesktop.onUpdateState(listener)
  → ipcRenderer.on('desktop:update-state', handler)
                                  ──────────────────►  (persistent listener)
                                  main: publishDesktopUpdateState()
                                    mainWindow.webContents.send('desktop:update-state', state)
                                  ◄──────────────────
  ← () => removeListener  (cleanup function)

window.openclawDesktop.installUpdate()
  → ipcRenderer.invoke('desktop:update:install')
                                  ──────────────────►
                                  autoUpdater.quitAndInstall()
                                  (app khởi động lại)
```

### DesktopUpdateState — các phase

| Phase | Ý nghĩa |
|---|---|
| `idle` | Chưa kiểm tra, hoặc đã kiểm tra và không có gì |
| `checking` | Đang gọi autoUpdater.checkForUpdates() |
| `available` | Có bản mới trên GitHub Releases |
| `downloading` | Đang tải file installer về |
| `downloaded` | Đã tải xong, sẵn sàng cài |
| `error` | Lỗi trong quá trình check/download |
| `unsupported` | Bản portable — không hỗ trợ auto-update |

> **Lưu ý:** auto-update chỉ hoạt động với bản cài NSIS (`app.isPackaged = true`).
> Bản portable không có NSIS updater path → phase luôn là `unsupported`.

---

## Luồng tắt ứng dụng

```
User đóng cửa sổ / thoát app
  │
  app.on('before-quit')
    └─ killBackendTree()
         └─ treeKill(backendLauncher.pid, 'SIGTERM')
              → kill toàn bộ process tree (launcher + gateway + children)

  app.on('will-quit')
    └─ globalShortcut.unregisterAll()

  start.js (backend launcher)
    → nhận SIGTERM
    → onShutdown():
         ├─ clearInterval(keepAlive)
         ├─ shutdownChildren()  ← SIGTERM → gateway process
         ├─ fs.unlinkSync(launcher-ready.json)
         └─ process.exit(0)
```

---

## Luồng second-instance (single-instance lock)

```
User mở file .exe lần 2
  │
  app.requestSingleInstanceLock() → false (đã có instance)
    └─ app.quit()  ← thoát instance mới ngay

Instance đang chạy:
  app.on('second-instance')
    ├─ mainWindow.isMinimized() → mainWindow.restore()
    └─ mainWindow.focus()
```

---

## Data flow: Paths trên Windows

```
Packaged (NSIS install):
  dataRoot    = %APPDATA%\openclaw-desktop\
  workspaceDir = %APPDATA%\openclaw-desktop\workspace\
  openclawDir  = %APPDATA%\openclaw-desktop\.openclaw\
  logsDir      = %APPDATA%\openclaw-desktop\logs\
  readyFile    = %APPDATA%\openclaw-desktop\launcher-ready.json
  configFile   = %APPDATA%\openclaw-desktop\.openclaw\openclaw.json

Dev (npm run dev):
  dataRoot    = <projectRoot>/data/
  (cấu trúc con tương tự)

Resources (extraResources trong electron-builder):
  process.resourcesPath\resources\   (packaged)
  <projectRoot>\resources\           (dev)
```

---

## Sơ đồ files liên quan

```
dist/
├── main/
│   ├── main.js          ← compiled app/main/main.ts
│   ├── preload.js        ← compiled app/main/preload.ts
│   ├── app-icon.js
│   └── electron-runner.js
└── backend/
    ├── start.js          ← compiled app/backend/start.ts  [ELECTRON_RUN_AS_NODE]
    ├── config.js
    ├── ports.js
    └── process-registry.js

node_modules/openclaw/
└── dist/
    └── entry.js          ← openclaw CLI/gateway (chạy với ELECTRON_RUN_AS_NODE=1)

resources/
└── workspace/            ← seed workspace (copy lần đầu)
```

---

*Tài liệu này mô tả kiến trúc fork `openclaw-electron` pin v2026.4.5*
*Nguồn tham chiếu: `openclaw-app/app/main/main.ts`, `openclaw-app/app/backend/start.ts`*
