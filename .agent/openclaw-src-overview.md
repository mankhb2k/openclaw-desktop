# OpenClaw Source Overview — v2026.4.5

> Tổng quan cấu trúc thư mục của **fork** `openclaw-electron` và **upstream** `.tmp-openclaw-upstream/`.
> Fork pin tại `openclaw@2026.4.5`. Xem [openclaw-src.ref.json](openclaw-src.ref.json) để biết thông tin sync.
> Tài liệu liên quan: [electron-runtime-flow.md](electron-runtime-flow.md) · [dependencies.md](dependencies.md)

---

## Cấu trúc fork `openclaw-electron/` (thư mục hiện tại)

```
openclaw-electron/                ← root của fork
│
├── app/                          ← TypeScript source Electron (compile → dist/)
│   ├── main/                     ← Main process Electron
│   │   ├── main.ts               ← Entry chính: BrowserWindow + spawn backend + IPC
│   │   ├── preload.ts            ← contextBridge: window.openclawDesktop API
│   │   ├── app-icon.ts           ← Resolve đường dẫn icon (dev vs packaged)
│   │   └── electron-runner.ts    ← Resolve executable path (portable-safe)
│   ├── backend/                  ← Backend launcher (ELECTRON_RUN_AS_NODE=1)
│   │   ├── start.ts              ← Entry launcher: cấp port, spawn gateway, ghi ready-file
│   │   ├── config.ts             ← ENV constants, path helpers, gateway auth token
│   │   ├── ports.ts              ← allocateGatewayPort, waitForTcpPort
│   │   └── process-registry.ts   ← Track child processes, shutdown khi quit
│   └── shared/                   ← Code dùng chung main + backend
│       ├── paths.ts              ← PATH_NAMES constants (workspace, .openclaw, logs)
│       └── spawn-cwd.ts          ← resolveSpawnCwd (portable-safe working directory)
│
├── dist/                         ← Output TypeScript compile (gitignore)
│   ├── main/                     ← main.js, preload.js, app-icon.js, electron-runner.js
│   └── backend/                  ← start.js, config.js, ports.js, process-registry.js
│
├── resources/                    ← extraResources → process.resourcesPath/resources/
│   └── workspace/                ← Seed workspace (copy vào dataRoot lần đầu mở app)
│
├── assets/                       ← Static assets
│   └── icon.ico                  ← Icon Windows 256×256 (NSIS installer + taskbar)
│
├── scripts/                      ← Build/maintenance scripts
│   ├── pin-version.mjs           ← Tạo openclaw-version.pin + openclaw-src.ref.json
│   ├── verify-pin.mjs            ← So sánh 3 nguồn: pin / node_modules / ref.json
│   └── compare-upstream.mjs      ← Diff .tmp-openclaw-upstream vs node_modules/openclaw
│
├── .tmp-openclaw-upstream/       ← Full source upstream v2026.4.5 (tham chiếu, không build)
├── node_modules/                 ← npm install (openclaw@2026.4.5 + Electron deps)
│
├── release/                      ← Output electron-builder (gitignore)
│   └── OpenClaw-Setup-x.x.x.exe ← NSIS installer (target build)
│
├── openclaw-version.pin          ← "2026.4.5" — nguồn sự thật version
├── openclaw-src.ref.json         ← Audit trail: npmVersion, upstreamTag, syncedAt
├── package.json                  ← Dependencies + build scripts
├── tsconfig.json                 ← Compile app/ → dist/ (module: Node16)
├── electron-builder.yml          ← NSIS target x64, extraResources, publish config
│
├── electron-runtime-flow.md      ← Tài liệu luồng runtime chi tiết
├── dependencies.md               ← Chức năng từng dependency
├── openclaw-src-overview.md      ← File này — tổng quan cấu trúc
└── compare-upstream.report.md    ← Báo cáo diff upstream vs npm
```

### Chức năng từng thư mục trong fork

| Thư mục | Vai trò | Ghi chú |
|---|---|---|
| `app/main/` | Main process Electron — cửa sổ, IPC, auto-update | Compile → `dist/main/` |
| `app/backend/` | Backend launcher chạy với `ELECTRON_RUN_AS_NODE=1` — không có Electron APIs | Compile → `dist/backend/` |
| `app/shared/` | Constants và helpers dùng chung giữa main và backend | Compile cùng với trên |
| `dist/` | JavaScript đã compile — electron-builder đóng gói vào .exe | gitignore |
| `resources/` | Files tĩnh đưa vào bundle qua `extraResources` | Seed workspace mặc định |
| `assets/` | Icon và hình ảnh cho NSIS installer + app | icon.ico phải có 256×256 |
| `scripts/` | Maintenance: pin version, verify, compare upstream | Không vào bundle |
| `.tmp-openclaw-upstream/` | Full source upstream để tham chiếu, đọc code, so sánh | Không build, không pack |
| `node_modules/openclaw/` | **Gateway runtime** — chỉ chứa `dist/` compiled | Được pack vào .exe |
| `release/` | Artifacts build ra (Setup .exe) | gitignore |

---

## Cấu trúc gốc upstream (root)

```
.tmp-openclaw-upstream/
├── src/            ← Toàn bộ TypeScript source của gateway/backend
├── ui/             ← Frontend web (Control UI) — React + Vite
├── apps/           ← Native app wrappers (iOS, Android, macOS, shared)
├── extensions/     ← Plugin channel tích hợp sẵn (Telegram, WhatsApp, Slack...)
├── skills/         ← Skill scripts (1password, canvas, gh-issues, gemini...)
├── packages/       ← Các package nội bộ (clawdbot, moltbot, plugin-sdk contracts)
├── scripts/        ← Công cụ build/release/CI
├── docs/           ← Tài liệu chính thức
├── patches/        ← Patch-package diffs cho deps
├── test/           ← Test helpers dùng chung
├── test-fixtures/  ← Dữ liệu fixture cho tests
├── qa/             ← E2E / QA automation
├── assets/         ← Icon, logo
├── openclaw.mjs    ← CLI entrypoint (shebang wrapper → src/entry.ts)
└── package.json / pnpm-workspace.yaml / tsconfig.json
```

---

## `src/` — Backend / Gateway source chính

### Core entry points

| File / Folder | Chức năng |
|---|---|
| `entry.ts` | Điểm vào CLI chính — khởi tạo process, respawn nếu cần, chuyển sang `index.ts` |
| `entry.respawn.ts` | Logic respawn process (restart tự động khi update) |
| `index.ts` | Export library API (dùng khi nhúng openclaw như thư viện) |
| `runtime.ts` | Khởi tạo runtime: load config, kết nối DB, bật gateway |
| `library.ts` | Public API cho embedding: `applyTemplate`, `createDefaultDeps`, v.v. |
| `version.ts` | Hằng số phiên bản |
| `globals.ts` | Global singletons (logger, config cache) |

### `gateway/`
**Control plane chính** — WebSocket server phục vụ Control UI và các channel.
- Xử lý auth (token, API key, allowed origins)
- RPC handlers: `update.run`, `agent.*`, `session.*`
- Broadcast event ra Control UI
- Origin-check policy cho remote connections
- Android/iOS capability policy

### `channels/`
**Core kênh nhắn tin** — boundary nội bộ, plugin authors không import trực tiếp.
- Mỗi channel là một plugin theo contract `channel-plugin-api`
- Xử lý ACK reactions, allowlist matching, account snapshot
- Bridge giữa channel events và gateway

### `plugins/`
**Plugin system** — discovery, manifest validation, loading, registry.
- Load plugin từ disk hoặc bundled
- Validate manifest (tên, version, entrypoints)
- Contract enforcement (boundary giữa plugin và core)
- LSP bundling cho autocomplete

### `plugin-sdk/`
**Public contract** cho plugin authors và bundled plugins.
- `core.ts` — exported API mà plugin được phép gọi
- `channel-contract.ts` — interface một channel plugin phải implement

### `extensions/` _(ở root, không trong src/)_
Plugin channel tích hợp sẵn — mỗi folder là 1 extension:

| Extension | Kênh |
|---|---|
| `telegram/` | Telegram Bot |
| `whatsapp/` | WhatsApp (via Baileys) |
| `slack/` | Slack App |
| `discord/` | Discord Bot |
| `msteams/` | Microsoft Teams |
| `matrix/` | Matrix protocol |
| `bluebubbles/` | iMessage via BlueBubbles |
| `mattermost/` | Mattermost |
| `feishu/` | Feishu / Lark |
| `zalo/` | Zalo |
| `irc/` | IRC |
| `amazon-bedrock/` | Amazon Bedrock AI provider |
| `anthropic/` | Anthropic Claude provider |
| `browser/` | Browser automation channel |
| `memory/` | Memory plugin |
| `diffs/` | Diff / patch plugin |
| `voice-call/` | Voice call integration |
| `acpx/` | ACP extension protocol |

### `agents/`
**Agent spawning và orchestration.**
- `acp-spawn.ts` — spawn agent qua ACP protocol
- `acp-spawn-parent-stream.ts` — stream kết quả từ spawned agent về parent

### `acp/`
**Agent Client Protocol (ACP) client.**
- Giao tiếp với spawned agents qua stdio / ndjson stream
- Request permission từ user khi agent cần
- `client.ts` — ClientSideConnection wrapper

### `daemon/`
**Service manager** — quản lý gateway/node như background service.
- Hỗ trợ: macOS LaunchAgent, Linux systemd, Windows Task Scheduler
- Constants: `GATEWAY_LAUNCH_AGENT_LABEL`, `GATEWAY_WINDOWS_TASK_NAME`...

### `cli/`
**CLI argument parsing và subcommands.**
- `argv.ts` — parse args, detect `--version`, `--help`
- `container-target.ts` — chọn Docker vs local execution
- `profile.ts` — multi-profile support
- `windows-argv.ts` — normalize Windows CLI args

### `commands/`
**Tất cả subcommand của openclaw CLI:**
- `agent/` — `openclaw agent run/list/stop`
- `sessions/` — session management
- `channels/` — channel setup
- `config/` — config commands
- Và các lệnh khác: `onboard`, `doctor`, `update`, `status`...

### `config/`
**Configuration system.**
- Load/save config từ disk (`~/.openclaw/config.json`)
- Agent dirs, allowed values, limits
- Runtime config validation

### `sessions/`
**Session management** — mỗi conversation với AI là một session.
- Session ID resolution
- Model overrides per-session
- Send policy (rate limiting, approval)
- Level overrides

### `routing/`
**Message routing** — định tuyến tin nhắn đến đúng account/agent.
- Account ID resolution
- Account lookup (từ channel user → openclaw account)
- Bindings: link channel user ↔ openclaw account

### `tasks/`
**Task executor** — xử lý long-running tasks bất đồng bộ.
- `task-executor.ts` — chạy task, emit progress events
- Domain views: cách task được expose ra UI
- Policy: ai được xem/cancel task nào

### `hooks/`
**Lifecycle hooks** — callback trước/sau các sự kiện quan trọng.
- Pre/post message hooks
- Agent event hooks

### `flows/`
**Interactive flows** — wizard-style onboarding flows.
- Channel setup flow
- Doctor health check flow
- Provider/model picker flow

### `wizard/`
**Onboarding wizard** (`openclaw onboard`).
- Step-by-step setup qua terminal (Clack prompter)
- Config gateway, channels, workspace
- Completion + finalize state

### `tui/`
**Terminal UI** — giao diện terminal (ink/clack-based).
- Gateway chat (chat ngay trong terminal)
- Components: spinner, status bars
- OSC8 hyperlinks trong terminal

### `mcp/`
**Model Context Protocol** — tích hợp MCP tools/servers.
- Channel bridge: expose MCP tools qua gateway
- Plugin tools serve

### `infra/`
**Infrastructure utilities** — các helper cơ sở:
- `env.ts` — read/normalize env vars
- `errors.ts` — format uncaught errors
- `path-env.ts` — ensure CLI trên PATH
- `abort-signal.ts` — abort pattern helpers
- `agent-events.ts` — event streaming
- `approval-*.ts` — approval workflow (native delivery)
- `warning-filter.ts` — suppress Node.js warnings

### `shared/`
**Shared types và logic** dùng chung giữa gateway và channels:
- Chat envelope/content types
- Assistant identity
- Avatar policy
- Error format

### `shared-core/` / `context-engine/`
**Context engine** — quản lý context window khi gửi cho AI.
- `init.ts` — khởi tạo context
- `delegate.ts` — delegate context building
- `legacy.ts` — compat với context format cũ

### `secrets/`
**Secrets management** — lưu trữ API key an toàn.
- Tích hợp 1Password CLI, macOS Keychain, env vars
- `secrets audit` — kiểm tra nơi lưu secrets

### `security/`
**Security utilities** — token validation, HMAC, origin policy.

### `auto-reply/`
**Auto-reply system** — trả lời tự động theo rules.
- Command auth: ai được ra lệnh gì
- Control commands (pause, resume, clear)
- Chunk processing cho streaming responses

### `cron/`
**Scheduled tasks** — cron jobs cho openclaw.
- Active job tracking
- Delivery plan (khi nào gửi message)
- Failure notifications

### `media/` `media-generation/` `media-understanding/`
**Media processing:**
- `media/` — upload/download, MIME types
- `media-generation/` — image/video/music generation via AI
- `media-understanding/` — image/video analysis

### `realtime-voice/` `realtime-transcription/` `tts/`
**Voice features:**
- `realtime-voice/` — real-time voice call integration
- `realtime-transcription/` — speech-to-text streaming
- `tts/` — text-to-speech

### `canvas-host/`
**Canvas server** — serve interactive Canvas (live HTML/JS từ AI).
- A2UI bridge (AI to UI)
- File resolver cho canvas assets
- WebSocket server cho live canvas updates

### `node-host/`
**Node.js runtime host** — sandbox để chạy code do AI generate.

### `memory-host-sdk/`
**Memory plugin SDK** — interface cho memory plugins.

### `pairing/`
**Device pairing** — ghép nối thiết bị (mobile ↔ gateway).

### `interactive/`
**Interactive approval** — khi AI cần xin phép user trước khi thực hiện action.

### `image-generation/` `video-generation/` `music-generation/`
**Generation modules** — wrapper gọi external AI APIs cho media generation.

### `link-understanding/`
**Link preview/understanding** — fetch và analyze URLs.

### `web-fetch/` `web-search/`
- `web-fetch/` — fetch trang web (tool cho AI)
- `web-search/` — search Google/Brave (tool cho AI)

### `markdown/`
**Markdown rendering** — format AI responses thành Markdown.

### `logging/` `logger.ts`
**Logging system** — structured logging với levels, transports.

### `i18n/`
**Internationalization** — string translations.

### `utils/` `utils.ts`
**General utilities** — helpers dùng mọi nơi.

### `process/`
**Process utilities** — child process bridge, IPC giữa main và worker.

### `bootstrap/`
**Startup bootstrap** — setup Node.js environment trước khi app chạy.
- Extra CA certs
- Startup env normalization

### `bindings/`
**Protocol bindings** — low-level records/structs.

### `compat/`
**Legacy compatibility** — mapping tên cũ → mới.

---

## `ui/` — Control UI (Web Frontend)

```
ui/
├── src/       ← React components, pages, stores
├── public/    ← Static assets
├── index.html ← Entry HTML
├── vite.config.ts
└── package.json
```

**Stack:** React + Vite + TypeScript. Đây là dashboard web bạn thấy khi mở `http://localhost:PORT`.
- Chat interface
- Channel management
- Agent task viewer
- Settings / config UI

---

## `apps/` — Native App Wrappers

| Folder | Platform |
|---|---|
| `ios/` | iOS app (Swift/React Native) |
| `android/` | Android app |
| `macos/` | macOS native wrapper |
| `shared/` | Code dùng chung giữa các native apps |

---

## `skills/` — Skill Scripts

Skills là scripts mở rộng khả năng của AI. Ví dụ:

| Skill | Chức năng |
|---|---|
| `canvas/` | Interactive canvas rendering |
| `coding-agent/` | AI coding agent |
| `gh-issues/` | GitHub Issues integration |
| `gemini/` | Google Gemini AI |
| `1password/` | 1Password secrets |
| `apple-notes/` | Apple Notes integration |
| `discord/` | Discord bot skills |
| `clawhub/` | ClaWhub plugin marketplace |

---

## `packages/` — Internal Packages

| Package | Chức năng |
|---|---|
| `clawdbot/` | Clawd bot core library |
| `moltbot/` | Molt bot implementation |
| `memory-host-sdk/` | SDK cho memory plugins |
| `plugin-package-contract/` | Contract types cho plugin packages |

---

## Mối quan hệ giữa các layer (upstream)

```
CLI (src/entry.ts)
  └── Gateway (src/gateway/server.ts)         ← WebSocket server
        ├── Channels (src/channels/)           ← Message in/out
        │     └── Extensions (extensions/*)   ← Telegram, WhatsApp...
        ├── Agents (src/agents/)               ← AI orchestration
        ├── Tasks (src/tasks/)                 ← Async task runner
        ├── Routing (src/routing/)             ← Account resolution
        └── Plugins (src/plugins/)             ← Plugin registry
              └── Plugin SDK (src/plugin-sdk/) ← Public contract

Control UI (ui/)  ←─── WebSocket ──────────→  Gateway
```

## Mối quan hệ giữa các layer (fork Electron)

```
NSIS .exe
  └── Electron Main Process  (dist/main/main.js)
        ├── spawn ELECTRON_RUN_AS_NODE=1
        │     └── Backend Launcher  (dist/backend/start.js)
        │           ├── allocate port
        │           ├── ensure auth token  (openclaw.json)
        │           ├── spawn openclaw CLI gateway  (node_modules/openclaw/dist/entry.js)
        │           └── write launcher-ready.json  { controlUiUrl, gatewayPort }
        │
        ├── poll launcher-ready.json
        ├── BrowserWindow.loadURL(controlUiUrl)   ← Control UI chạy trong Electron
        │     └── preload.js  (contextBridge window.openclawDesktop)
        │
        └── IPC handlers
              ├── desktop:update:check / download / install  ← electron-updater
              └── desktop:run-update-openclaw                ← npm run update:openclaw
```

---

## So sánh upstream vs npm package

| Nguồn | Files | Ghi chú |
|---|---|---|
| `.tmp-openclaw-upstream` (full source) | ~12.249 | Source, tests, docs, CI |
| `node_modules/openclaw` (npm pack) | 539 | Chỉ `dist/`, `scripts/`, `assets/`, `skills/` |
| File khác nội dung | **0** | Hoàn toàn nhất quán |

> **Kết luận:** npm package chỉ chứa compiled `dist/` + runtime assets.
> Toàn bộ TypeScript source, tests, docs chỉ có ở upstream repo.
> Xem chi tiết đầy đủ tại [compare-upstream.report.md](compare-upstream.report.md).

### Cấu trúc `node_modules/openclaw/` (những gì được pack vào .exe)

```
node_modules/openclaw/
├── dist/           ← Toàn bộ compiled JS (gateway, CLI, channels, plugins...)
│   ├── entry.js    ← CLI entrypoint
│   └── *.js        ← ~530 files bundled/chunked
├── scripts/
│   ├── postinstall-bundled-plugins.mjs  ← Cài bundled plugins sau npm install
│   └── npm-runner.mjs
├── assets/         ← Static assets (icons, fonts)
├── skills/         ← Built-in skill scripts
├── openclaw.mjs    ← Shell wrapper → dist/entry.js
├── CHANGELOG.md
└── package.json    ← version: 2026.4.5
```

---

## Quick reference: file nào làm gì

| File | Process | Chức năng |
|---|---|---|
| `dist/main/main.js` | Electron main | Cửa sổ app, IPC, auto-update, spawn backend |
| `dist/main/preload.js` | Renderer preload | Expose `window.openclawDesktop` API |
| `dist/backend/start.js` | Node (ELECTRON_RUN_AS_NODE) | Launcher: port + auth + spawn gateway |
| `dist/backend/config.js` | Node | ENV constants, path resolution, auth token |
| `dist/backend/ports.js` | Node | TCP port allocation và health-check |
| `dist/backend/process-registry.js` | Node | Track + shutdown child processes |
| `node_modules/openclaw/openclaw.mjs` | Node | OpenClaw CLI — gateway entry |
| `resources/workspace/` | — | Seed workspace khi lần đầu chạy |
| `openclaw-version.pin` | — | Version pin: "2026.4.5" |
| `openclaw-src.ref.json` | — | Audit: npmVersion, upstreamTag, syncedAt |

---

*Cập nhật: 2026-04-12 | Fork openclaw-electron pin v2026.4.5*
*Tài liệu liên quan: [electron-runtime-flow.md](electron-runtime-flow.md) · [dependencies.md](dependencies.md)*
