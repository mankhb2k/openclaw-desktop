/**
 * Backend launcher entry: spawned by Electron main with ELECTRON_RUN_AS_NODE=1.
 * Starts only the OpenClaw gateway (serves the official Control UI).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  ENV_DATA_ROOT,
  buildControlUiUrl,
  buildOpenClawEnv,
  ensureDataLayout,
  ensureGatewayDesktopAuth,
  resolveDesktopPaths,
} from './config';
import { resolveSpawnCwd } from '../shared/spawn-cwd';
import { allocateGatewayPort, waitForTcpPort } from './ports';
import { registerChildProcess, shutdownChildren } from './process-registry';

const ENV_APP_ROOT = 'OPENCLAW_APP_ROOT';

function requireAppRoot(): string {
  const root = process.env[ENV_APP_ROOT]?.trim();
  if (!root) {
    throw new Error(`${ENV_APP_ROOT} is not set`);
  }
  return root;
}
const ENV_OPENCLAW_CLI = 'OPENCLAW_CLI_SCRIPT';
const ENV_SEED_WORKSPACE = 'OPENCLAW_SEED_WORKSPACE';
/** Optional: absolute path to Node.js 22.12+ for gateway only (when Electron still ships Node 20). */
const ENV_GATEWAY_NODE = 'OPENCLAW_GATEWAY_NODE';
/** Set by Electron main so gateway spawn uses the real exe (fixes portable / Temp ENOENT). */
const ENV_ELECTRON_RUNNER = 'OPENCLAW_ELECTRON_RUNNER';

function resolveElectronExeForGateway(): string {
  const fromEnv = process.env[ENV_ELECTRON_RUNNER]?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) {
    try {
      return fs.realpathSync(fromEnv);
    } catch {
      return fromEnv;
    }
  }
  try {
    return fs.realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function maybeSeedWorkspace(workspaceDir: string, seedDir: string | undefined): void {
  if (!seedDir || !fs.existsSync(seedDir)) return;
  try {
    if (fs.readdirSync(workspaceDir).length > 0) return;
    for (const name of fs.readdirSync(seedDir)) {
      fs.cpSync(path.join(seedDir, name), path.join(workspaceDir, name), { recursive: true });
    }
  } catch {
    /* non-fatal */
  }
}

function logLine(paths: { logsDir: string }, level: 'info' | 'error', message: string): void {
  const line = `[${new Date().toISOString()}] [launcher] ${message}\n`;
  try {
    fs.appendFileSync(path.join(paths.logsDir, 'launcher.log'), line, 'utf8');
  } catch {
    /* ignore file errors */
  }
  if (level === 'error') console.error(line.trim());
  else console.log(line.trim());
}

function resolveOpenClawCliScript(): string {
  const fromEnv = process.env[ENV_OPENCLAW_CLI]?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const appRoot = process.env[ENV_APP_ROOT]?.trim();
  if (!appRoot) throw new Error(`${ENV_APP_ROOT} is not set`);
  const candidate = path.join(appRoot, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(candidate)) {
    throw new Error(`OpenClaw CLI not found at ${candidate}`);
  }
  return candidate;
}

async function main(): Promise<void> {
  const dataRoot = process.env[ENV_DATA_ROOT]?.trim();
  if (!dataRoot) {
    console.error(`${ENV_DATA_ROOT} is required`);
    process.exit(1);
  }

  const paths = resolveDesktopPaths(dataRoot);
  ensureDataLayout(paths);
  maybeSeedWorkspace(paths.workspaceDir, process.env[ENV_SEED_WORKSPACE]?.trim());

  const appRoot = requireAppRoot();
  const { tokenForUrl, basePath } = ensureGatewayDesktopAuth(paths, appRoot);
  const gatewayPort = await allocateGatewayPort(18789);
  const gatewayTokenEnv = tokenForUrl.length > 0 ? tokenForUrl : undefined;
  const baseEnv = buildOpenClawEnv(paths, gatewayTokenEnv, appRoot);

  const electronExe = resolveElectronExeForGateway();
  const nodeEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: '1',
  };

  const cliScript = resolveOpenClawCliScript();
  const gatewayNodeBin = process.env[ENV_GATEWAY_NODE]?.trim();
  const useSystemNodeForGateway = Boolean(gatewayNodeBin && fs.existsSync(gatewayNodeBin));
  const gatewayRunner = useSystemNodeForGateway ? gatewayNodeBin! : electronExe;
  const gatewayEnv: NodeJS.ProcessEnv = { ...nodeEnv };
  if (useSystemNodeForGateway) {
    delete gatewayEnv.ELECTRON_RUN_AS_NODE;
  } else {
    gatewayEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  const gatewayCwd = resolveSpawnCwd(appRoot, electronExe);

  logLine(
    paths,
    'info',
    `Starting OpenClaw gateway on port ${gatewayPort} (node: ${useSystemNodeForGateway ? gatewayRunner : 'Electron'})`
  );
  const gatewayChild = spawn(
    gatewayRunner,
    [cliScript, 'gateway', 'run', '--port', String(gatewayPort), '--allow-unconfigured'],
    {
      cwd: gatewayCwd,
      env: gatewayEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );
  registerChildProcess(gatewayChild);
  gatewayChild.stdout?.on('data', (chunk: Buffer) => {
    fs.appendFileSync(path.join(paths.logsDir, 'openclaw-gateway.log'), chunk);
  });
  gatewayChild.stderr?.on('data', (chunk: Buffer) => {
    fs.appendFileSync(path.join(paths.logsDir, 'openclaw-gateway.log'), chunk);
  });
  gatewayChild.on('error', (err) => logLine(paths, 'error', `openclaw spawn error: ${err.message}`));
  gatewayChild.on('exit', (code, signal) => {
    const whySignal =
      signal == null
        ? 'signal=null means the process exited on its own (exit code), not killed by SIGTERM/SIGKILL'
        : `killed by signal ${signal}`;
    logLine(paths, 'error', `openclaw gateway exited code=${code} (${whySignal})`);
    if (code === 1) {
      logLine(
        paths,
        'error',
        'If log shows "Node.js v22.12+ is required": Electron may still ship Node 20 — quit the app, run "npm install" (Electron 35+), or set env OPENCLAW_GATEWAY_NODE to Node 22+ binary path.'
      );
    }
  });

  try {
    await waitForTcpPort('127.0.0.1', gatewayPort, 120_000);
    logLine(paths, 'info', `Gateway is listening on 127.0.0.1:${gatewayPort}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine(paths, 'error', msg);
    shutdownChildren();
    process.exit(1);
  }

  const controlUiUrl = buildControlUiUrl(gatewayPort, basePath, tokenForUrl);
  const readyPayload = {
    gatewayPort,
    controlUiUrl,
    /** @deprecated use controlUiUrl */
    dashboardUrl: controlUiUrl,
    startedAt: new Date().toISOString(),
    pids: {
      openclawGateway: gatewayChild.pid,
    },
  };
  fs.writeFileSync(paths.readyFile, JSON.stringify(readyPayload, null, 2), 'utf8');
  logLine(paths, 'info', `Wrote ${paths.readyFile} (Control UI ready)`);

  const keepAlive = setInterval(() => {}, 60_000);

  const onShutdown = () => {
    clearInterval(keepAlive);
    shutdownChildren();
    try {
      if (fs.existsSync(paths.readyFile)) fs.unlinkSync(paths.readyFile);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', onShutdown);
  process.on('SIGTERM', onShutdown);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
