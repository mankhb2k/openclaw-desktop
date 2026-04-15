/**
 * layer-updater.ts
 *
 * Single-layer backend update pipeline (schema v3).
 *
 * Flow:
 *   1. Fetch backend-manifest.json
 *   2. Check minAppVersion
 *   3. Compare local version — nếu up-to-date, return 'complete'
 *   4. Download layer-backend-v{ver}.tar.gz → backend-dl/
 *   5. Verify SHA-256
 *   6. Extract → backend-new/node_modules/
 *   7. Smoke-check: openclaw.mjs tồn tại
 *   8. Atomic swap: backend-new/ → backend/
 *   9. Ghi backend-version.json
 *  10. Return 'complete'
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';
import { extract } from 'tar';
import {
  type BackendManifest,
  type LocalBackendVersion,
  fetchBackendManifest,
  getBackendDir,
  getBackendNewDir,
  getBackendOldDir,
  getDownloadDir,
  needsUpdate,
  readLocalBackendVersion,
  writeLocalBackendVersion,
} from './backend-manifest';

// ── IPC event name ─────────────────────────────────────────────────────────────
export const BACKEND_LAYER_UPDATE_EVENT = 'backend:layer-update-state';

// ── State types ───────────────────────────────────────────────────────────────

export type LayerUpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'swapping'
  | 'complete'
  | 'error';

export interface LayerUpdateState {
  phase: LayerUpdatePhase;
  /** 0–100, có khi downloading */
  progressPercent?: number;
  /** Human-readable message */
  message?: string;
  /** Error message nếu phase === 'error' */
  error?: string;
  /** Version đã cài thành công */
  installedVersion?: string;
}

export type LayerUpdateProgressCallback = (state: LayerUpdateState) => void;

// ── Split mode readiness ──────────────────────────────────────────────────────

/**
 * Kiểm tra xem backend/ đã sẵn sàng chưa:
 * backend/node_modules/openclaw/openclaw.mjs phải tồn tại.
 */
export function isSplitModeReady(dataRoot: string): boolean {
  const openclawMjs = path.join(
    getBackendDir(dataRoot),
    'node_modules',
    'openclaw',
    'openclaw.mjs',
  );
  return fs.existsSync(openclawMjs);
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadLayer(
  url: string,
  destPath: string,
  onProgress: LayerUpdateProgressCallback,
): Promise<void> {
  const partialPath = `${destPath}.partial`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const res = await axios.get<import('stream').Readable>(url, {
    responseType: 'stream',
    timeout: 600_000, // 10 phút
    headers: { 'User-Agent': 'openclaw-desktop-updater' },
  });

  const totalBytes = parseInt(String(res.headers['content-length'] ?? '0'), 10) || 0;
  let downloadedBytes = 0;
  let lastReportedPct = -1;

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(partialPath);
    res.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const pct = Math.floor((downloadedBytes / totalBytes) * 100);
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress({
            phase: 'downloading',
            progressPercent: pct,
            message: `Downloading ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`,
          });
        }
      }
    });
    res.data.pipe(out);
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });

  fs.renameSync(partialPath, destPath);
}

// ── SHA-256 verify ────────────────────────────────────────────────────────────

async function verifySha256(filePath: string, expected: string): Promise<void> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const s = fs.createReadStream(filePath);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('end', resolve);
    s.on('error', reject);
  });
  const actual = hash.digest('hex');
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

// ── Extract ───────────────────────────────────────────────────────────────────

async function extractLayer(tarPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await extract({ file: tarPath, cwd: destDir });
}

// ── Smoke-check ───────────────────────────────────────────────────────────────

function smokeCheckBackend(backendDir: string): void {
  const openclawMjs = path.join(backendDir, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(openclawMjs)) {
    throw new Error(`Smoke check failed: openclaw.mjs not found at ${openclawMjs}`);
  }
}

// ── Atomic swap ───────────────────────────────────────────────────────────────

function atomicSwap(dataRoot: string): void {
  const backendDir = getBackendDir(dataRoot);
  const backendNewDir = getBackendNewDir(dataRoot);
  const backendOldDir = getBackendOldDir(dataRoot);

  if (fs.existsSync(backendOldDir)) {
    fs.rmSync(backendOldDir, { recursive: true, force: true });
  }
  if (fs.existsSync(backendDir)) {
    fs.renameSync(backendDir, backendOldDir);
  }
  fs.renameSync(backendNewDir, backendDir);
}

// ── Main update pipeline ──────────────────────────────────────────────────────

export interface UpdateLayersOptions {
  dataRoot: string;
  /** URL của backend-manifest.json */
  manifestUrl: string;
  /** Running app version */
  appVersion: string;
  /** Running Electron version string */
  electronVersion: string;
  /** Callback mỗi khi state thay đổi */
  onProgress: LayerUpdateProgressCallback;
  /** Nếu true: chỉ check có update không, không download */
  checkOnly?: boolean;
}

export async function updateBackendLayers(opts: UpdateLayersOptions): Promise<void> {
  const { dataRoot, manifestUrl, appVersion, electronVersion, onProgress, checkOnly } = opts;

  try {
    // ── Step 1: Fetch manifest ──────────────────────────────────────────────
    onProgress({ phase: 'checking', message: 'Fetching backend manifest...' });
    let manifest: BackendManifest;
    try {
      manifest = await fetchBackendManifest(manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const errMsg = `Failed to fetch manifest: ${msg}`;
      throw new Error(errMsg);
    }

    // ── Step 2: Check minAppVersion ─────────────────────────────────────────
    if (manifest.minAppVersion && appVersion < manifest.minAppVersion) {
      throw new Error(
        `App version ${appVersion} is too old (requires ${manifest.minAppVersion}). Update the app first.`,
      );
    }

    // ── Step 3: Diff with local ─────────────────────────────────────────────
    const local = readLocalBackendVersion(dataRoot);
    if (!needsUpdate(local, manifest, electronVersion)) {
      onProgress({
        phase: 'complete',
        message: 'Backend is up to date.',
        installedVersion: local?.version,
      });
      return;
    }

    if (checkOnly) {
      onProgress({
        phase: 'complete',
        message: `Update available: ${manifest.version}`,
      });
      return;
    }

    console.log(`[layer-updater] Updating backend: ${local?.version ?? 'none'} → ${manifest.version}`);

    // ── Step 4: Download ────────────────────────────────────────────────────
    const downloadDir = getDownloadDir(dataRoot);
    const layerFileName = path.basename(manifest.url);
    const tarPath = path.join(downloadDir, layerFileName);

    // Remove stale partial/previous downloads
    try {
      if (fs.existsSync(tarPath)) fs.rmSync(tarPath, { force: true });
      if (fs.existsSync(`${tarPath}.partial`)) fs.rmSync(`${tarPath}.partial`, { force: true });
    } catch { /* ignore */ }

    await downloadLayer(manifest.url, tarPath, onProgress);
    console.log(`[layer-updater] Downloaded: ${layerFileName}`);

    // ── Step 5: Verify SHA-256 ──────────────────────────────────────────────
    onProgress({ phase: 'verifying', message: 'Verifying download...' });
    await verifySha256(tarPath, manifest.sha256);
    console.log('[layer-updater] SHA-256 verified');

    // ── Step 6: Extract → backend-new/ ─────────────────────────────────────
    onProgress({ phase: 'extracting', message: 'Extracting backend...' });
    const backendNewDir = getBackendNewDir(dataRoot);

    // Clean previous partial extraction
    if (fs.existsSync(backendNewDir)) {
      fs.rmSync(backendNewDir, { recursive: true, force: true });
    }

    await extractLayer(tarPath, backendNewDir);
    console.log('[layer-updater] Extracted');

    // Clean up downloaded tar
    try { fs.rmSync(tarPath, { force: true }); } catch { /* ignore */ }

    // ── Step 7: Smoke-check ─────────────────────────────────────────────────
    smokeCheckBackend(backendNewDir);
    console.log('[layer-updater] Smoke check passed');

    // ── Step 8: Atomic swap ─────────────────────────────────────────────────
    onProgress({ phase: 'swapping', message: 'Applying update...' });
    atomicSwap(dataRoot);
    console.log('[layer-updater] Atomic swap: backend-new/ → backend/');

    // ── Step 9: Write version file ──────────────────────────────────────────
    const newVer: LocalBackendVersion = {
      version: manifest.version,
      electronVersion,
    };
    writeLocalBackendVersion(dataRoot, newVer);

    // ── Step 10: Cleanup backend-old/ ──────────────────────────────────────
    const backendOldDir = getBackendOldDir(dataRoot);
    setTimeout(() => {
      try {
        if (fs.existsSync(backendOldDir)) {
          fs.rmSync(backendOldDir, { recursive: true, force: true });
          console.log('[layer-updater] Cleaned up backend-old/');
        }
      } catch { /* non-critical */ }
    }, 5_000).unref();

    onProgress({
      phase: 'complete',
      message: `Backend updated successfully (v${manifest.version}).`,
      installedVersion: manifest.version,
    });
    console.log('[layer-updater] Update complete:', manifest.version);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[layer-updater] Update failed:', msg);
    onProgress({ phase: 'error', error: msg, message: `Lỗi: ${msg}` });

    // Clean up partial state
    try {
      const backendNewDir = getBackendNewDir(dataRoot);
      if (fs.existsSync(backendNewDir)) {
        fs.rmSync(backendNewDir, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
}
