/**
 * Electron main process: spawns the OpenClaw gateway launcher (ELECTRON_RUN_AS_NODE),
 * then loads the official Control UI in a BrowserWindow.
 */
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  type Event as ElectronEvent,
  type WebContents,
  type WebContentsConsoleMessageEventParams,
} from "electron";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import treeKill from "tree-kill";
import {
  autoUpdater,
  type NsisUpdater,
  type ProgressInfo,
} from "electron-updater";
import { ENV_DATA_ROOT, ENV_DESKTOP_RESOURCES } from "../backend/config";
import { resolveWindowIconPath } from "./app-icon";
import { resolveElectronRunnerPath } from "./electron-runner";
import {
  isSplitModeReady,
  updateBackendLayers,
  BACKEND_LAYER_UPDATE_EVENT,
  type LayerUpdateState,
} from "./layer-updater";

const ENV_ELECTRON_RUNNER = "OPENCLAW_ELECTRON_RUNNER";

const PACKAGED_DEVTOOLS_FLAG = "openclaw-desktop.devtools";
const ENV_PORTABLE_EXE_DIR = "PORTABLE_EXECUTABLE_DIR";
const ENV_PORTABLE_EXE_FILE = "PORTABLE_EXECUTABLE_FILE";

const MAIN_WINDOW_MIN_WIDTH = 1180;
const MAIN_WINDOW_MIN_HEIGHT = 700;

let mainWindow: BrowserWindow | null = null;
/** WebSocket URL của gateway hiện tại — được set sau khi backend ready */
let currentGatewayWsUrl: string | null = null;
const DESKTOP_UPDATE_EVENT = "desktop:update-state";
const UPDATE_NOTICE_URL =
  "https://raw.githubusercontent.com/mankhb2k/openclaw-1click/main/update/update-notice.json";

/** URL của backend-manifest.json — commit vào repo openclaw-desktop nhánh main, thư mục release/ */
const BACKEND_MANIFEST_URL =
  process.env.OPENCLAW_BACKEND_MANIFEST_URL?.trim() ||
  "https://raw.githubusercontent.com/mankhb2k/openclaw-desktop/main/release/backend-manifest.json";

type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "error"
  | "unsupported";
type DesktopUpdateState = {
  isPackaged: boolean;
  enabled: boolean;
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  announcementTitle: string | null;
  announcementDescription: string | null;
  progressPercent: number | null;
  message: string | null;
};

let desktopUpdateState: DesktopUpdateState = {
  isPackaged: app.isPackaged,
  enabled: false,
  phase: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  announcementTitle: null,
  announcementDescription: null,
  progressPercent: null,
  message: null,
};

function publishDesktopUpdateState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(DESKTOP_UPDATE_EVENT, desktopUpdateState);
}

function setDesktopUpdateState(next: Partial<DesktopUpdateState>): void {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...next,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
  };
  publishDesktopUpdateState();
}

function getDesktopUpdatePhaseNow(): DesktopUpdatePhase {
  return desktopUpdateState.phase;
}

function normalizeLocale(locale: string): string[] {
  const raw = (locale || "").trim().toLowerCase();
  if (!raw) {
    return ["en"];
  }
  const base = raw.split(/[-_]/)[0] ?? "";
  const candidates = [raw];
  if (base && base !== raw) {
    candidates.push(base);
  }
  candidates.push("en");
  return [...new Set(candidates)];
}

function applyUpdateNoticePlaceholders(
  text: string,
  params?: { newVersion?: string | null; currentVersion?: string | null },
): string {
  return text
    .replaceAll("{newVersion}", params?.newVersion ?? "")
    .replaceAll("{currentVersion}", params?.currentVersion ?? "")
    .trim();
}

function getMessagesTable(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as Record<string, unknown>;
  if (root.messages && typeof root.messages === "object") {
    return root.messages as Record<string, unknown>;
  }
  return root;
}

function pickLocalizedNoticeField(
  messages: Record<string, unknown>,
  locale: string,
  field: "title" | "description",
  params?: { newVersion?: string | null; currentVersion?: string | null },
): string | null {
  const candidates = normalizeLocale(locale);
  for (const key of candidates) {
    const entry = messages[key];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const raw = (entry as Record<string, unknown>)[field];
    if (typeof raw === "string" && raw.trim()) {
      return applyUpdateNoticePlaceholders(raw, params);
    }
  }
  return null;
}

async function fetchLocalizedUpdateNotice(params?: {
  newVersion?: string | null;
  currentVersion?: string | null;
}): Promise<{ title: string | null; description: string | null }> {
  try {
    const locale = app.getLocale();
    const response = await axios.get(UPDATE_NOTICE_URL, {
      timeout: 5000,
      responseType: "json",
    });
    const table = getMessagesTable(response.data);
    if (!table) {
      return { title: null, description: null };
    }
    return {
      title: pickLocalizedNoticeField(table, locale, "title", params),
      description: pickLocalizedNoticeField(
        table,
        locale,
        "description",
        params,
      ),
    };
  } catch {
    return { title: null, description: null };
  }
}

function isPortableRuntime(): boolean {
  return Boolean(
    process.env[ENV_PORTABLE_EXE_FILE] || process.env[ENV_PORTABLE_EXE_DIR],
  );
}

function isElectronUpdaterEnabled(): boolean {
  return app.isPackaged && process.platform === "win32" && !isPortableRuntime();
}

function shouldSkipWindowsUpdateSignatureVerify(): boolean {
  return process.env.OPENCLAW_SKIP_WINDOWS_UPDATE_SIGNATURE === "1";
}

let desktopDownloadInFlight: Promise<void> | null = null;

async function checkDesktopUpdates(): Promise<void> {
  if (!isElectronUpdaterEnabled()) {
    return;
  }
  if (
    desktopUpdateState.phase === "downloading" ||
    desktopUpdateState.phase === "downloaded"
  ) {
    return;
  }
  setDesktopUpdateState({
    enabled: true,
    phase: "checking",
    availableVersion: null,
    announcementTitle: null,
    announcementDescription: null,
    progressPercent: null,
    message: null,
  });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setDesktopUpdateState({ phase: "error", message });
  }
}

async function downloadDesktopUpdate(): Promise<void> {
  if (!isElectronUpdaterEnabled()) {
    return;
  }
  if (desktopUpdateState.phase === "downloaded") {
    return;
  }
  if (desktopUpdateState.phase === "downloading") {
    if (desktopDownloadInFlight) {
      await desktopDownloadInFlight;
    }
    return;
  }
  if (desktopUpdateState.phase !== "available") {
    return;
  }
  const run = async () => {
    setDesktopUpdateState({
      phase: "downloading",
      progressPercent: 0,
      message: null,
    });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDesktopUpdateState({ phase: "error", message, progressPercent: null });
      throw error;
    }
  };
  desktopDownloadInFlight = run().finally(() => {
    desktopDownloadInFlight = null;
  });
  await desktopDownloadInFlight;
}

function installDesktopUpdate(): void {
  if (
    !isElectronUpdaterEnabled() ||
    desktopUpdateState.phase !== "downloaded"
  ) {
    return;
  }
  autoUpdater.quitAndInstall(true, true);
}

function initDesktopUpdater(): void {
  if (!app.isPackaged) {
    return;
  }
  if (!isElectronUpdaterEnabled()) {
    setDesktopUpdateState({
      enabled: false,
      phase: "unsupported",
      availableVersion: null,
      announcementTitle: null,
      announcementDescription: null,
      progressPercent: null,
      message:
        "Auto-update chỉ hỗ trợ bản cài NSIS, không hỗ trợ bản portable.",
    });
    return;
  }

  setDesktopUpdateState({ enabled: true, phase: "idle", message: null });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  if (shouldSkipWindowsUpdateSignatureVerify()) {
    (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = async () => null;
  }

  autoUpdater.on("checking-for-update", () => {
    if (
      desktopUpdateState.phase === "downloading" ||
      desktopUpdateState.phase === "downloaded"
    ) {
      return;
    }
    setDesktopUpdateState({
      phase: "checking",
      availableVersion: null,
      announcementTitle: null,
      announcementDescription: null,
      progressPercent: null,
      message: null,
    });
  });
  autoUpdater.on("update-not-available", () => {
    if (
      desktopUpdateState.phase === "downloading" ||
      desktopUpdateState.phase === "downloaded"
    ) {
      return;
    }
    setDesktopUpdateState({
      phase: "idle",
      availableVersion: null,
      announcementTitle: null,
      announcementDescription: null,
      progressPercent: null,
      message: null,
    });
  });
  autoUpdater.on("update-available", async (info) => {
    if (
      getDesktopUpdatePhaseNow() === "downloading" ||
      getDesktopUpdatePhaseNow() === "downloaded"
    ) {
      return;
    }
    const { title, description } = await fetchLocalizedUpdateNotice({
      newVersion: info.version ?? null,
      currentVersion: app.getVersion(),
    });
    if (
      getDesktopUpdatePhaseNow() === "downloading" ||
      getDesktopUpdatePhaseNow() === "downloaded"
    ) {
      return;
    }
    setDesktopUpdateState({
      phase: "available",
      availableVersion: info.version ?? null,
      announcementTitle: title,
      announcementDescription: description,
      progressPercent: null,
      message: null,
    });
  });
  autoUpdater.on("download-progress", (progress: ProgressInfo) => {
    if (getDesktopUpdatePhaseNow() === "downloaded") {
      return;
    }
    setDesktopUpdateState({
      phase: "downloading",
      progressPercent: Number.isFinite(progress.percent)
        ? progress.percent
        : null,
    });
  });
  autoUpdater.on("update-downloaded", () => {
    setDesktopUpdateState({
      phase: "downloaded",
      progressPercent: 100,
      message:
        "Bản cập nhật đã tải xong. Nhấn Update lần nữa để cài đặt và khởi động lại.",
    });
  });
  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    setDesktopUpdateState({ phase: "error", message, progressPercent: null });
  });
}

if (app.isPackaged) {
  process.env[ENV_DESKTOP_RESOURCES] = process.resourcesPath;
}

if (process.env.OPENCLAW_DESKTOP_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
}

let backendLauncher: ChildProcess | null = null;

function getProjectRoot(): string {
  if (app.isPackaged) {
    return app.getAppPath();
  }
  return path.resolve(__dirname, "..", "..");
}

function getDataRoot(): string {
  const override = process.env[ENV_DATA_ROOT]?.trim();
  if (override) return path.resolve(override);
  if (!app.isPackaged) {
    return path.resolve(getProjectRoot(), ".openclaw-desktop-data");
  }
  return app.getPath("userData");
}

function packagedDevtoolsFlagPaths(): string[] {
  const raw: string[] = [];
  const portableDir = process.env[ENV_PORTABLE_EXE_DIR]?.trim();
  if (portableDir) {
    raw.push(path.join(portableDir, PACKAGED_DEVTOOLS_FLAG));
  }
  const portableFile = process.env[ENV_PORTABLE_EXE_FILE]?.trim();
  if (portableFile) {
    raw.push(path.join(path.dirname(portableFile), PACKAGED_DEVTOOLS_FLAG));
  }
  try {
    raw.push(
      path.join(path.dirname(app.getPath("exe")), PACKAGED_DEVTOOLS_FLAG),
    );
  } catch {
    /* ignore */
  }
  try {
    raw.push(path.join(app.getPath("userData"), PACKAGED_DEVTOOLS_FLAG));
  } catch {
    /* ignore */
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const key = path.resolve(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function isPackagedDevtoolsEnabled(): boolean {
  if (!app.isPackaged) return false;
  if (process.env.OPENCLAW_DESKTOP_DEVTOOLS === "1") return true;
  for (const p of packagedDevtoolsFlagPaths()) {
    try {
      if (fs.existsSync(p)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function resolveOpenClawCliScript(appRoot: string): string {
  return path.join(appRoot, "node_modules", "openclaw", "openclaw.mjs");
}

function readReadyState(dataRoot: string): {
  controlUiUrl: string;
  gatewayPort: number;
} {
  const readyFile = path.join(dataRoot, "launcher-ready.json");
  const raw = fs.readFileSync(readyFile, "utf8");
  const parsed = JSON.parse(raw) as {
    controlUiUrl?: string;
    /** @deprecated */
    dashboardUrl?: string;
    gatewayPort?: number;
  };
  const controlUiUrl = parsed.controlUiUrl || parsed.dashboardUrl;
  if (!controlUiUrl || typeof parsed.gatewayPort !== "number") {
    throw new Error("Invalid launcher-ready.json");
  }
  return { controlUiUrl, gatewayPort: parsed.gatewayPort };
}

async function waitForLauncherReady(
  dataRoot: string,
  timeoutMs: number,
): Promise<void> {
  const readyFile = path.join(dataRoot, "launcher-ready.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(readyFile)) {
        readReadyState(dataRoot);
        return;
      }
    } catch {
      /* keep waiting until JSON is valid */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Backend launcher did not become ready in time");
}

async function ensureBackendAndGetUrl(dataRoot: string): Promise<string> {
  const readyFile = path.join(dataRoot, "launcher-ready.json");
  if (
    backendLauncher &&
    backendLauncher.exitCode === null &&
    fs.existsSync(readyFile)
  ) {
    try {
      return readReadyState(dataRoot).controlUiUrl;
    } catch {
      /* stale file; restart launcher below */
    }
  }
  startBackendLauncher(dataRoot);
  await waitForLauncherReady(dataRoot, 90_000);
  return readReadyState(dataRoot).controlUiUrl;
}

function startBackendLauncher(dataRoot: string): void {
  const startScript = path.join(__dirname, "..", "backend", "start.js");

  // Split mode (RULE-06): nếu backend/ đã được extract vào userData, dùng nó thay vì bundled app.
  // isSplitModeReady() kiểm tra xem openclaw.mjs có tồn tại trong dataRoot/backend/ không.
  const splitReady = app.isPackaged && isSplitModeReady(dataRoot);
  const appRoot = splitReady
    ? path.join(dataRoot, "backend")
    : getProjectRoot();
  const cliScript = resolveOpenClawCliScript(appRoot);

  if (splitReady) {
    console.log("[main] Split mode: using backend from", appRoot);
  }

  fs.mkdirSync(dataRoot, { recursive: true });

  try {
    if (fs.existsSync(path.join(dataRoot, "launcher-ready.json"))) {
      fs.unlinkSync(path.join(dataRoot, "launcher-ready.json"));
    }
  } catch {
    /* ignore */
  }

  const seedWorkspace = app.isPackaged
    ? path.join(process.resourcesPath, "resources", "workspace")
    : path.resolve(getProjectRoot(), "resources", "workspace");

  const electronRunner = resolveElectronRunnerPath();
  const backendCwd = path.dirname(electronRunner);
  backendLauncher = spawn(electronRunner, [startScript], {
    cwd: backendCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      [ENV_DATA_ROOT]: dataRoot,
      OPENCLAW_APP_ROOT: appRoot,
      OPENCLAW_CLI_SCRIPT: cliScript,
      OPENCLAW_SEED_WORKSPACE: fs.existsSync(seedWorkspace)
        ? seedWorkspace
        : "",
      [ENV_ELECTRON_RUNNER]: electronRunner,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const forward = (label: string, chunk: Buffer) => {
    process.stdout.write(`[backend] ${label} ${chunk.toString()}`);
  };
  backendLauncher.stdout?.on("data", (c) => forward("out", c));
  backendLauncher.stderr?.on("data", (c) => forward("err", c));
  backendLauncher.on("exit", (code, signal) => {
    console.error(`[backend] launcher exited code=${code} signal=${signal}`);
    backendLauncher = null;
  });
}

/**
 * Chạy background check và (nếu cần) download 2-layer backend update.
 * Gọi sau khi gateway đã sẵn sàng để không block startup.
 * Progress được forward tới renderer qua IPC (BACKEND_LAYER_UPDATE_EVENT).
 */
function scheduleBackendLayerCheck(dataRoot: string): void {
  if (!app.isPackaged) return; // chỉ chạy ở packaged mode

  // Delay 10 giây sau startup để UI load xong trước
  setTimeout(() => {
    void updateBackendLayers({
      dataRoot,
      manifestUrl: BACKEND_MANIFEST_URL,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? "35.7.5",
      projectRoot: getProjectRoot(),
      onProgress: (state: LayerUpdateState) => {
        console.log(
          "[layer-update]",
          state.phase,
          state.message ?? state.error ?? "",
        );
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(BACKEND_LAYER_UPDATE_EVENT, state);
        }
      },
    });
  }, 10_000).unref();
}

async function openControlUiInBrowser(): Promise<void> {
  const dataRoot = getDataRoot();
  const readyPath = path.join(dataRoot, "launcher-ready.json");
  if (!fs.existsSync(readyPath)) {
    dialog.showErrorBox(
      "OpenClaw Control UI",
      "launcher-ready.json was not found. Wait until the app has finished starting the backend.",
    );
    return;
  }
  let controlUiUrl: string;
  try {
    ({ controlUiUrl } = readReadyState(dataRoot));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dialog.showErrorBox(
      "OpenClaw Control UI",
      `Could not read launcher state: ${msg}`,
    );
    return;
  }
  try {
    await shell.openExternal(controlUiUrl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dialog.showErrorBox(
      "OpenClaw Control UI",
      `Could not open browser: ${msg}`,
    );
  }
}

function buildApplicationMenu(): void {
  if (process.platform === "darwin") {
    const openControlUi: Electron.MenuItemConstructorOptions = {
      label: "Open OpenClaw Control UI in browser…",
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => {
        void openControlUiInBrowser();
      },
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            openControlUi,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
          ],
        },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function registerGlobalShortcuts(): void {
  if (process.platform === "darwin") return;
  const registered = globalShortcut.register("CommandOrControl+Shift+O", () => {
    void openControlUiInBrowser();
  });
  if (!registered) {
    console.warn(
      "[main] Could not register global shortcut CommandOrControl+Shift+O",
    );
  }
}

function isHttpOrHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function wireControlUiExternalLinks(
  wc: WebContents,
  controlUiUrl: string,
): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttpOrHttpsUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  let sameOrigin: string;
  try {
    sameOrigin = new URL(controlUiUrl).origin;
  } catch {
    return;
  }

  wc.on("will-navigate", (event, url) => {
    try {
      const target = new URL(url);
      if (target.origin === sameOrigin) {
        return;
      }
      if (isHttpOrHttpsUrl(url)) {
        event.preventDefault();
        void shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URL */
    }
  });
}

function registerDesktopUpdateHandler(): void {
  // Synchronous gateway URL query from preload (used by forked control-ui)
  ipcMain.removeAllListeners("desktop:get-gateway-url");
  ipcMain.on("desktop:get-gateway-url", (event) => {
    event.returnValue = currentGatewayWsUrl ?? "";
  });
  ipcMain.removeHandler("desktop:run-update-openclaw");
  ipcMain.removeHandler("desktop:update:get-state");
  ipcMain.removeHandler("desktop:update:check");
  ipcMain.removeHandler("desktop:update:download");
  ipcMain.removeHandler("desktop:update:install");
  ipcMain.handle("desktop:update:get-state", async () => desktopUpdateState);
  ipcMain.handle("desktop:update:check", async () => {
    await checkDesktopUpdates();
    return desktopUpdateState;
  });
  ipcMain.handle("desktop:update:download", async () => {
    await downloadDesktopUpdate();
    return desktopUpdateState;
  });
  ipcMain.handle("desktop:update:install", async () => {
    installDesktopUpdate();
    return { ok: true as const };
  });
  ipcMain.handle("desktop:run-update-openclaw", async () => {
    if (app.isPackaged) {
      if (!isElectronUpdaterEnabled()) {
        return {
          ok: false as const,
          error:
            "Auto-update chỉ hỗ trợ bản cài NSIS. Bản portable vui lòng tải bản mới từ GitHub Releases.",
        };
      }
      if (desktopUpdateState.phase === "downloaded") {
        installDesktopUpdate();
        return {
          ok: true as const,
          message: "Đang cài đặt bản mới và khởi động lại ứng dụng.",
        };
      }
      await downloadDesktopUpdate();
      return {
        ok: true as const,
        message:
          desktopUpdateState.phase === "downloading"
            ? "Đang tải bản cập nhật..."
            : "Chưa có bản cập nhật sẵn sàng.",
      };
    }
    const appRoot = getProjectRoot();
    const pkgPath = path.join(appRoot, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return {
        ok: false as const,
        error: "Không tìm thấy package.json tại thư mục ứng dụng.",
      };
    }
    return await new Promise<
      | { ok: true; message?: string }
      | { ok: false; error?: string; stderrTail?: string }
    >((resolve) => {
      const child = spawn("npm", ["run", "update:openclaw"], {
        cwd: appRoot,
        shell: true,
        windowsHide: true,
        env: { ...process.env },
      });
      let stderr = "";
      let stdout = "";
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
        if (stderr.length > 24_000) stderr = stderr.slice(-24_000);
      });
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString();
        if (stdout.length > 16_000) stdout = stdout.slice(-16_000);
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        const tail = (stderr.trim() || stdout.trim() || `exit ${code}`).slice(
          -4000,
        );
        resolve({
          ok: false,
          error: `npm run update:openclaw thất bại (mã ${code}).`,
          stderrTail: tail,
        });
      });
    });
  });
}

function killBackendTree(): void {
  if (backendLauncher?.pid) {
    try {
      treeKill(backendLauncher.pid, "SIGTERM", (err) => {
        if (err) console.error("[backend] tree-kill:", err.message);
      });
    } catch (e) {
      console.error("[backend] kill failed", e);
    }
  }
  backendLauncher = null;
}

function dashboardWindowTitle(): string {
  return `OpenClaw Dashboard v${app.getVersion()}`;
}

async function createWindow(): Promise<void> {
  const dataRoot = getDataRoot();
  const controlUiUrl = await ensureBackendAndGetUrl(dataRoot);
  // Derive WebSocket gateway URL from controlUiUrl (http→ws, https→wss)
  currentGatewayWsUrl = controlUiUrl.replace(/^http(s?):\/\//, (_, s) => `ws${s}://`);

  const windowIcon = resolveWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    backgroundColor: "#0e1015",
    title: dashboardWindowTitle(),
    ...(process.platform === "win32"
      ? { icon: nativeImage.createEmpty() }
      : windowIcon
        ? { icon: windowIcon }
        : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload-control-ui.js"),
    },
  });

  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    mainWindow?.setTitle(dashboardWindowTitle());
  });

  wireControlUiExternalLinks(mainWindow.webContents, controlUiUrl);

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error("[main] Control UI failed to load:", {
          errorCode,
          errorDescription,
          validatedURL,
        });
      }
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[main] renderer crashed:", details);
  });
  mainWindow.webContents.on(
    "console-message",
    (e: ElectronEvent<WebContentsConsoleMessageEventParams>) => {
      if (e.level === "warning" || e.level === "error") {
        console.error(
          "[control-ui]",
          e.message,
          e.sourceId ? `(${e.sourceId}:${e.lineNumber})` : "",
        );
      }
    },
  );

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(controlUiUrl);
  mainWindow.setTitle(dashboardWindowTitle());
  publishDesktopUpdateState();

  const devShortcuts = !app.isPackaged || isPackagedDevtoolsEnabled();
  const autoOpenDevtools =
    (!app.isPackaged && process.env.OPENCLAW_DESKTOP_DEVTOOLS === "1") ||
    isPackagedDevtoolsEnabled();
  if (autoOpenDevtools) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  if (devShortcuts) {
    mainWindow.webContents.on("before-input-event", (_event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F12") {
        mainWindow?.webContents.toggleDevTools();
        return;
      }
      const mod = process.platform === "darwin" ? input.meta : input.control;
      if (mod && input.shift && input.key.toLowerCase() === "i") {
        mainWindow?.webContents.toggleDevTools();
      }
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    nativeTheme.themeSource = "system";
    registerDesktopUpdateHandler();
    initDesktopUpdater();
    void checkDesktopUpdates();
    buildApplicationMenu();
    registerGlobalShortcuts();
    void createWindow()
      .then(() => {
        scheduleBackendLayerCheck(getDataRoot());
      })
      .catch((err) => {
        console.error(err);
        app.quit();
      });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch(console.error);
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
  });

  app.on("before-quit", () => {
    killBackendTree();
  });
}
