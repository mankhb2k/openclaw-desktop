import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PATH_NAMES } from '../shared/paths';

/** Written by the main process before spawning the backend launcher. */
export const ENV_DATA_ROOT = 'OPENCLAW_DESKTOP_DATA_ROOT';

export interface DesktopPaths {
  dataRoot: string;
  workspaceDir: string;
  openclawDir: string;
  logsDir: string;
  openclawConfigFile: string;
  readyFile: string;
}

export function resolveDesktopPaths(dataRoot: string): DesktopPaths {
  const workspaceDir = path.join(dataRoot, PATH_NAMES.workspace);
  const openclawDir = path.join(dataRoot, PATH_NAMES.openclaw);
  const logsDir = path.join(dataRoot, PATH_NAMES.logs);
  return {
    dataRoot,
    workspaceDir,
    openclawDir,
    logsDir,
    openclawConfigFile: path.join(openclawDir, 'openclaw.json'),
    readyFile: path.join(dataRoot, 'launcher-ready.json'),
  };
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Normalizes `gateway.controlUi.basePath` for URL building (no trailing slash; empty = root). */
export function normalizeControlUiBasePath(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  return withSlash.replace(/\/+$/, '');
}

function loadOpenClawConfig(paths: DesktopPaths): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(paths.openclawConfigFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

export interface GatewayDesktopAuthResult {
  /** Fragment `#token=...` for Control UI when using token auth; empty if none/password/none mode. */
  tokenForUrl: string;
  basePath: string;
}

/** Override Control UI static root via env (absolute path to a directory containing `index.html`). */
export const ENV_DESKTOP_CONTROL_UI_ROOT = 'OPENCLAW_DESKTOP_CONTROL_UI_ROOT';
/** Set to `1` or `true` to force the bundled npm Control UI (ignore local fork builds). */
export const ENV_SKIP_CUSTOM_CONTROL_UI = 'OPENCLAW_DESKTOP_SKIP_CUSTOM_CONTROL_UI';
/** Set by Electron main when packaged: `process.resourcesPath` (optional `vendor/control-ui` lives here). */
export const ENV_DESKTOP_RESOURCES = 'OPENCLAW_DESKTOP_RESOURCES';

/**
 * If a local fork build exists, returns its absolute directory so the gateway can set `gateway.controlUi.root`.
 * Checks: `OPENCLAW_DESKTOP_CONTROL_UI_ROOT`, then `<resources>/vendor/control-ui` (packaged app),
 * then `<appRoot>/vendor/control-ui`, then `<appRoot>/dist/control-ui`.
 */
export function resolveDesktopControlUiRoot(appRoot: string): string | null {
  const skip = process.env[ENV_SKIP_CUSTOM_CONTROL_UI];
  if (skip === '1' || skip?.toLowerCase() === 'true') {
    return null;
  }
  const envRoot = process.env[ENV_DESKTOP_CONTROL_UI_ROOT]?.trim();
  if (envRoot) {
    const indexPath = path.join(envRoot, 'index.html');
    return fs.existsSync(indexPath) ? path.resolve(envRoot) : null;
  }
  const resources = process.env[ENV_DESKTOP_RESOURCES]?.trim();
  const unpackedBase =
    appRoot.toLowerCase().endsWith('.asar')
      ? path.join(path.dirname(appRoot), 'app.asar.unpacked')
      : null;

  const candidates = [
    ...(resources ? [path.join(resources, 'vendor', 'control-ui')] : []),
    ...(resources
      ? [
          path.join(resources, 'app.asar.unpacked', 'vendor', 'control-ui'),
          path.join(resources, 'app.asar.unpacked', 'dist', 'control-ui'),
        ]
      : []),
    path.join(appRoot, 'vendor', 'control-ui'),
    path.join(appRoot, 'dist', 'control-ui'),
    ...(unpackedBase
      ? [
          path.join(unpackedBase, 'vendor', 'control-ui'),
          path.join(unpackedBase, 'dist', 'control-ui'),
        ]
      : []),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return path.resolve(dir);
    }
  }
  return null;
}

function isProbablyBadControlUiRoot(rootPath: string): boolean {
  const s = rootPath.replace(/\//g, '\\').toLowerCase();
  if (s.includes('\\temp\\') || s.includes('\\local\\temp\\')) {
    return true;
  }
  const asarDist = s.includes('app.asar\\dist\\control-ui');
  const asarUnpackedDist = s.includes('app.asar.unpacked\\dist\\control-ui');
  if (asarDist && !asarUnpackedDist) {
    return true;
  }
  return false;
}

function controlUiRootManagedByDesktop(appRoot: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const unpackedBase =
    appRoot.toLowerCase().endsWith('.asar')
      ? path.join(path.dirname(appRoot), 'app.asar.unpacked')
      : null;
  const managed = [
    path.resolve(appRoot, 'vendor', 'control-ui'),
    path.resolve(appRoot, 'dist', 'control-ui'),
  ];
  const resources = process.env[ENV_DESKTOP_RESOURCES]?.trim();
  if (resources) {
    managed.push(path.resolve(resources, 'vendor', 'control-ui'));
    managed.push(path.resolve(resources, 'app.asar.unpacked', 'vendor', 'control-ui'));
    managed.push(path.resolve(resources, 'app.asar.unpacked', 'dist', 'control-ui'));
  }
  if (unpackedBase) {
    managed.push(path.resolve(unpackedBase, 'vendor', 'control-ui'));
    managed.push(path.resolve(unpackedBase, 'dist', 'control-ui'));
  }
  return managed.some((m) => resolvedRoot === m);
}

/**
 * Ensures loopback-friendly gateway auth: if config has no token auth, sets gateway.auth.mode=token
 * and generates gateway.auth.token. Respects explicit gateway.auth.mode none|password.
 * When a local Control UI build exists under the app root, sets `gateway.controlUi.root` to serve it.
 */
export function ensureGatewayDesktopAuth(paths: DesktopPaths, appRoot: string): GatewayDesktopAuthResult {
  const cfg = loadOpenClawConfig(paths);
  const gateway = asRecord(cfg.gateway);
  const auth = asRecord(gateway.auth);
  let controlUi = asRecord(gateway.controlUi);

  let needsWrite = false;

  if (typeof controlUi.root === 'string' && controlUi.root.trim()) {
    const rootAbs = path.resolve(String(controlUi.root));
    try {
      const indexPath = path.join(rootAbs, 'index.html');
      if (!fs.existsSync(indexPath) || isProbablyBadControlUiRoot(rootAbs)) {
        const next = { ...controlUi };
        delete next.root;
        controlUi = next;
        needsWrite = true;
      }
    } catch {
      const next = { ...controlUi };
      delete next.root;
      controlUi = next;
      needsWrite = true;
    }
  }

  const customRoot = resolveDesktopControlUiRoot(appRoot);
  if (customRoot) {
    const current =
      typeof controlUi.root === 'string' ? path.resolve(String(controlUi.root)) : '';
    if (current !== customRoot) {
      controlUi = { ...controlUi, root: customRoot };
      needsWrite = true;
    }
  } else if (
    typeof controlUi.root === 'string' &&
    controlUiRootManagedByDesktop(appRoot, String(controlUi.root))
  ) {
    const next = { ...controlUi };
    delete next.root;
    controlUi = next;
    needsWrite = true;
  }

  const hasConfiguredControlUiRoot =
    typeof controlUi.root === 'string' && controlUi.root.trim().length > 0;

  let effectiveBasePath = normalizeControlUiBasePath(
    typeof controlUi.basePath === 'string' ? controlUi.basePath : ''
  );

  if (effectiveBasePath !== '') {
    const rootIsDesktopManaged =
      customRoot != null && controlUiRootManagedByDesktop(appRoot, customRoot);
    const useBundledControlUi = !hasConfiguredControlUiRoot;
    if (rootIsDesktopManaged || useBundledControlUi) {
      if (typeof controlUi.basePath === 'string') {
        const next = { ...controlUi };
        delete next.basePath;
        controlUi = next;
        needsWrite = true;
      }
      effectiveBasePath = '';
    }
  }

  const mode = typeof auth.mode === 'string' ? auth.mode : '';
  let token = typeof auth.token === 'string' ? auth.token : '';

  if (mode === 'none' || mode === 'password') {
    if (needsWrite) {
      cfg.gateway = { ...gateway, auth, controlUi };
      writeJsonAtomic(paths.openclawConfigFile, cfg);
    }
    return { tokenForUrl: '', basePath: effectiveBasePath };
  }

  if (!token) {
    token = crypto.randomBytes(24).toString('base64url');
    Object.assign(auth, { mode: 'token', token });
    needsWrite = true;
  } else if (mode !== 'token') {
    Object.assign(auth, { mode: 'token' });
    needsWrite = true;
  }

  if (needsWrite) {
    cfg.gateway = { ...gateway, auth, controlUi };
    writeJsonAtomic(paths.openclawConfigFile, cfg);
  }

  return { tokenForUrl: token, basePath: effectiveBasePath };
}

/** HTTP origin for Control UI (no path fragment, no hash). */
export function buildControlUiHttpOrigin(port: number, basePath: string): string {
  const prefix = basePath === '' ? '' : basePath;
  return `http://127.0.0.1:${port}${prefix}/`;
}

/** Full URL Electron should load (includes #token when applicable). */
export function buildControlUiUrl(port: number, basePath: string, tokenForUrl: string): string {
  let url = buildControlUiHttpOrigin(port, basePath);
  if (tokenForUrl.length > 0) {
    url += `#token=${encodeURIComponent(tokenForUrl)}`;
  }
  return url;
}

/** Creates workspace / openclaw / logs and a minimal OpenClaw config file if missing. */
export function ensureDataLayout(paths: DesktopPaths): void {
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.mkdirSync(paths.openclawDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  if (!fs.existsSync(paths.openclawConfigFile)) {
    fs.writeFileSync(paths.openclawConfigFile, '{}\n', 'utf8');
  }
}

/**
 * Environment for the OpenClaw CLI (gateway). Paths stay under DATA_ROOT; optional gateway token
 * matches config so Control UI auto-auth works.
 */
export function buildOpenClawEnv(
  paths: DesktopPaths,
  gatewayToken: string | undefined,
  desktopAppRoot?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_DIR: paths.openclawDir,
    OPENCLAW_STATE_DIR: paths.openclawDir,
    WORKSPACE_DIR: paths.workspaceDir,
    OPENCLAW_WORKSPACE: paths.workspaceDir,
    OPENCLAW_CONFIG: paths.openclawConfigFile,
    OPENCLAW_CONFIG_PATH: paths.openclawConfigFile,
  };
  if (gatewayToken && gatewayToken.length > 0) {
    env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  }
  const root = desktopAppRoot?.trim();
  if (root) {
    env.OPENCLAW_DESKTOP_APP_ROOT = root;
  }
  if (!env.OLLAMA_API_KEY) {
    try {
      const raw = fs.readFileSync(paths.openclawConfigFile, 'utf8');
      const cfg = JSON.parse(raw) as { auth?: { profiles?: Record<string, unknown> } };
      const hasOllamaProfile = Object.keys(cfg?.auth?.profiles ?? {}).some((k) =>
        k.startsWith('ollama'),
      );
      if (hasOllamaProfile) {
        env.OLLAMA_API_KEY = 'ollama-local';
      }
    } catch {
      // Config unreadable — skip
    }
  }
  return env;
}
