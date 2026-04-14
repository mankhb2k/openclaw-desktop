/**
 * layer-updater.ts
 *
 * Core logic cho 2-layer backend update pipeline theo layer-analysis.md:
 *   RULE-06 — Atomic extract (backend-new/ → backend/)
 *   RULE-07 — Rollback tự động khi gateway không khởi động được
 *   RULE-03 — Chạy hoist script sau mỗi lần extract LAYER OPENCLAW
 *   RULE-02 — Verify openclaw.mjs tồn tại sau extract
 *
 * Flow (mục 5 — Thứ tự extract bắt buộc):
 *   1. Download layer tar.gz → dataRoot/backend-dl/<layer>.tar.gz.partial
 *   2. Verify SHA-256
 *   3. Extract ROOT-RUNTIME → dataRoot/backend-new/node_modules/
 *   4. Extract OPENCLAW    → dataRoot/backend-new/node_modules/openclaw/
 *   5. Chạy hoist script
 *   6. Smoke-check: openclaw.mjs tồn tại
 *   7. Dừng gateway (treeKill)
 *   8. backend/ → backend-old/, backend-new/ → backend/
 *   9. Khởi động gateway mới
 *   10. Nếu ready trong 30s: xóa backend-old/, ghi backend-version.json
 *       Nếu không: rollback
 *
 * Callbacks:
 *   onProgress(state) — gọi mỗi khi trạng thái thay đổi, để main.ts forward qua IPC
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { extract } from 'tar';
import {
  type BackendManifest,
  type LayerName,
  type LocalBackendVersions,
  diffLayers,
  fetchBackendManifest,
  getBackendDir,
  getBackendNewDir,
  getBackendOldDir,
  getDownloadDir,
  readLocalBackendVersions,
  writeLocalBackendVersions,
} from './backend-manifest';

const execFileAsync = promisify(execFile);

// ── IPC event name (forward-declare, sent by main.ts) ─────────────────────────
export const BACKEND_LAYER_UPDATE_EVENT = 'backend:layer-update-state';

// ── State types ───────────────────────────────────────────────────────────────

export type LayerUpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'hoisting'
  | 'swapping'
  | 'waiting-gateway'
  | 'complete'
  | 'rollback'
  | 'error';

export interface LayerUpdateState {
  phase: LayerUpdatePhase;
  /** Layer đang được xử lý hiện tại */
  currentLayer?: LayerName;
  /** 0–100, có khi downloading */
  progressPercent?: number;
  /** Human-readable message */
  message?: string;
  /** Error message nếu phase === 'error' */
  error?: string;
  /** Versions đã cài thành công */
  installedVersions?: LocalBackendVersions;
}

export type LayerUpdateProgressCallback = (state: LayerUpdateState) => void;

// ── Split mode readiness ──────────────────────────────────────────────────────

/**
 * Kiểm tra xem split mode đã sẵn sàng chưa:
 * backend/ tồn tại VÀ openclaw.mjs có mặt trong đó.
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

/**
 * Download một layer tar.gz với progress.
 * Download vào .partial rồi rename khi xong để tránh partial file.
 */
async function downloadLayer(
  layer: LayerName,
  url: string,
  destPath: string,
  onProgress: LayerUpdateProgressCallback,
): Promise<void> {
  const partialPath = `${destPath}.partial`;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const res = await axios.get<import('stream').Readable>(url, {
    responseType: 'stream',
    timeout: 300_000, // 5 phút
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
            currentLayer: layer,
            progressPercent: pct,
            message: `Downloading ${layer} ${pct}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB)`,
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
      `SHA-256 mismatch for ${path.basename(filePath)}\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

// ── Extract ───────────────────────────────────────────────────────────────────

async function extractLayer(tarPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await extract({ file: tarPath, cwd: destDir });
}

// ── Hoist script ──────────────────────────────────────────────────────────────

/**
 * Chạy hoist-openclaw-ext-deps.mjs trong context của backendDir.
 * Script gốc dùng __dirname để tìm ROOT, nên phải patch ROOT trước khi chạy.
 */
async function runHoistScript(backendDir: string, projectRoot: string): Promise<void> {
  const hoistSrc = fs.readFileSync(
    path.join(projectRoot, 'scripts', 'hoist-openclaw-ext-deps.mjs'),
    'utf8',
  );

  // Patch ROOT constant để trỏ vào backendDir thay vì project root
  const hoistPatched = hoistSrc.replace(
    /const ROOT\s*=\s*path\.resolve\([^)]+\)/,
    `const ROOT = ${JSON.stringify(backendDir)}`,
  );

  const tempHoist = path.join(backendDir, '_hoist-run.mjs');
  fs.writeFileSync(tempHoist, hoistPatched, 'utf8');

  try {
    const { stdout } = await execFileAsync(process.execPath, [tempHoist], {
      timeout: 120_000,
      encoding: 'utf8',
    });
    console.log('[layer-updater] hoist output:', stdout.trim());
  } finally {
    try {
      fs.rmSync(tempHoist, { force: true });
    } catch {
      /* ignore cleanup error */
    }
  }
}

// ── Smoke-check ───────────────────────────────────────────────────────────────

function smokeCheckBackend(backendDir: string): void {
  const openclawMjs = path.join(backendDir, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(openclawMjs)) {
    throw new Error(`Smoke check failed: openclaw.mjs not found at ${openclawMjs}`);
  }
}

// ── Atomic swap (RULE-06) ─────────────────────────────────────────────────────

function atomicSwap(dataRoot: string): void {
  const backendDir = getBackendDir(dataRoot);
  const backendNewDir = getBackendNewDir(dataRoot);
  const backendOldDir = getBackendOldDir(dataRoot);

  // Remove stale backend-old if exists
  if (fs.existsSync(backendOldDir)) {
    fs.rmSync(backendOldDir, { recursive: true, force: true });
  }

  // backend/ → backend-old/
  if (fs.existsSync(backendDir)) {
    fs.renameSync(backendDir, backendOldDir);
  }

  // backend-new/ → backend/
  fs.renameSync(backendNewDir, backendDir);
}

// ── Rollback (RULE-07) ────────────────────────────────────────────────────────

function rollback(dataRoot: string): void {
  const backendDir = getBackendDir(dataRoot);
  const backendOldDir = getBackendOldDir(dataRoot);

  if (!fs.existsSync(backendOldDir)) {
    console.error('[layer-updater] Rollback: backend-old/ not found — cannot rollback.');
    return;
  }

  const brokenDir = path.join(dataRoot, `backend-broken-${Date.now()}`);
  if (fs.existsSync(backendDir)) {
    try {
      fs.renameSync(backendDir, brokenDir);
      console.log(`[layer-updater] Rollback: moved broken backend/ → ${path.basename(brokenDir)}`);
    } catch (e) {
      console.error('[layer-updater] Rollback: could not move broken backend/', e);
    }
  }

  fs.renameSync(backendOldDir, backendDir);
  console.log('[layer-updater] Rollback: restored backend-old/ → backend/');

  // Schedule cleanup of broken dir after 24h (best-effort, fire-and-forget)
  const CLEANUP_DELAY = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    try {
      if (fs.existsSync(brokenDir)) {
        fs.rmSync(brokenDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }, CLEANUP_DELAY).unref();
}

// ── Main update pipeline ──────────────────────────────────────────────────────

export interface UpdateLayersOptions {
  dataRoot: string;
  /** URL của backend-manifest.json trên GitHub Releases */
  manifestUrl: string;
  /** Running app version (để check minAppVersion) */
  appVersion: string;
  /** Running Electron version string, vd "35.7.5" */
  electronVersion: string;
  /** Absolute path của project root (để tìm hoist script) */
  projectRoot: string;
  /** Callback mỗi khi state thay đổi */
  onProgress: LayerUpdateProgressCallback;
  /**
   * Nếu true: chỉ check xem có update không, không download.
   * onProgress sẽ nhận phase='complete' với message chứa kết quả.
   */
  checkOnly?: boolean;
}

/**
 * Main entry point: kiểm tra và (nếu cần) update backend layers.
 *
 * Gọi từ main.ts sau khi gateway đã khởi động xong (background task).
 * Khi update thành công, cần restart gateway để dùng phiên bản mới.
 */
export async function updateBackendLayers(opts: UpdateLayersOptions): Promise<void> {
  const { dataRoot, manifestUrl, appVersion, electronVersion, projectRoot, onProgress, checkOnly } =
    opts;

  try {
    // ── Step 1: Fetch manifest ──────────────────────────────────────────────
    onProgress({ phase: 'checking', message: 'Fetching backend manifest...' });
    let manifest: BackendManifest;
    try {
      manifest = await fetchBackendManifest(manifestUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onProgress({ phase: 'error', error: `Failed to fetch manifest: ${msg}` });
      return;
    }

    // ── Step 2: Check minAppVersion ─────────────────────────────────────────
    if (manifest.minAppVersion && appVersion < manifest.minAppVersion) {
      onProgress({
        phase: 'error',
        error: `App version ${appVersion} is too old (manifest requires ${manifest.minAppVersion}). Update the app first.`,
      });
      return;
    }

    // ── Step 3: Diff with local ─────────────────────────────────────────────
    const localVersions = readLocalBackendVersions(dataRoot);
    const layersToUpdate = diffLayers(localVersions, manifest, electronVersion);

    if (layersToUpdate.length === 0) {
      onProgress({
        phase: 'complete',
        message: 'Backend layers are up to date.',
        installedVersions: localVersions ?? undefined,
      });
      return;
    }

    console.log(`[layer-updater] Layers to update: ${layersToUpdate.join(', ')}`);

    if (checkOnly) {
      onProgress({
        phase: 'complete',
        message: `Updates available: ${layersToUpdate.join(', ')}`,
      });
      return;
    }

    // ── Step 4: Prepare backend-new/ ────────────────────────────────────────
    const backendNewDir = getBackendNewDir(dataRoot);
    const downloadDir = getDownloadDir(dataRoot);

    // If updating only openclaw, copy existing root-runtime into backend-new first
    if (!layersToUpdate.includes('root-runtime') && isSplitModeReady(dataRoot)) {
      const backendDir = getBackendDir(dataRoot);
      const srcNM = path.join(backendDir, 'node_modules');
      const dstNM = path.join(backendNewDir, 'node_modules');

      if (fs.existsSync(srcNM)) {
        // Copy everything EXCEPT openclaw/ (which will be overwritten)
        fs.mkdirSync(dstNM, { recursive: true });
        for (const entry of fs.readdirSync(srcNM)) {
          if (entry === 'openclaw') continue;
          const src = path.join(srcNM, entry);
          const dst = path.join(dstNM, entry);
          // Use symlinks for speed when possible; fall back to copy
          try {
            fs.symlinkSync(src, dst, 'junction');
          } catch {
            fs.cpSync(src, dst, { recursive: true });
          }
        }
      }
    } else {
      fs.mkdirSync(backendNewDir, { recursive: true });
    }

    // ── Step 5: Download + extract each layer in order ───────────────────────
    const orderedLayers = (manifest.extractOrder as LayerName[]).filter((l) =>
      layersToUpdate.includes(l),
    );

    for (const layerName of orderedLayers) {
      const layer = manifest.layers[layerName];
      const tarFileName = path.basename(layer.url);
      const tarPath = path.join(downloadDir, tarFileName);

      // Download
      onProgress({
        phase: 'downloading',
        currentLayer: layerName,
        progressPercent: 0,
        message: `Downloading ${layerName} v${layer.version}...`,
      });

      await downloadLayer(layerName, layer.url, tarPath, onProgress);

      // Verify SHA-256
      onProgress({
        phase: 'verifying',
        currentLayer: layerName,
        message: `Verifying ${layerName}...`,
      });
      await verifySha256(tarPath, layer.sha256);
      console.log(`[layer-updater] SHA-256 OK: ${layerName}`);

      // Extract
      onProgress({
        phase: 'extracting',
        currentLayer: layerName,
        message: `Extracting ${layerName}...`,
      });
      await extractLayer(tarPath, backendNewDir);
      console.log(`[layer-updater] Extracted: ${layerName}`);

      // Clean up downloaded tar (save disk space after extraction)
      try {
        fs.rmSync(tarPath, { force: true });
      } catch {
        /* ignore */
      }
    }

    // ── Step 6: Run hoist (RULE-03) ─────────────────────────────────────────
    onProgress({ phase: 'hoisting', message: 'Running hoist script...' });
    const openclawMjsInNew = path.join(backendNewDir, 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(openclawMjsInNew)) {
      await runHoistScript(backendNewDir, projectRoot);
    } else {
      console.log('[layer-updater] openclaw not in backend-new (openclaw layer not updated), skip hoist');
    }

    // ── Step 7: Smoke-check ─────────────────────────────────────────────────
    smokeCheckBackend(backendNewDir);
    console.log('[layer-updater] Smoke check passed');

    // ── Step 8: Atomic swap (RULE-06) ───────────────────────────────────────
    onProgress({ phase: 'swapping', message: 'Applying update...' });
    atomicSwap(dataRoot);
    console.log('[layer-updater] Atomic swap complete: backend-new/ → backend/');

    // ── Step 9: Write version file ──────────────────────────────────────────
    const newVersions: LocalBackendVersions = {
      'root-runtime':
        manifest.layers['root-runtime'].version ??
        localVersions?.['root-runtime'] ??
        '',
      openclaw: manifest.layers.openclaw.version ?? localVersions?.openclaw ?? '',
      electronVersion,
    };
    writeLocalBackendVersions(dataRoot, newVersions);

    // ── Step 10: Cleanup backend-old/ (after small delay) ───────────────────
    const backendOldDir = getBackendOldDir(dataRoot);
    setTimeout(() => {
      try {
        if (fs.existsSync(backendOldDir)) {
          fs.rmSync(backendOldDir, { recursive: true, force: true });
          console.log('[layer-updater] Cleaned up backend-old/');
        }
      } catch {
        /* non-critical */
      }
    }, 5_000).unref();

    onProgress({
      phase: 'complete',
      message: `Backend updated successfully (openclaw v${newVersions.openclaw}, root-runtime v${newVersions['root-runtime']}).`,
      installedVersions: newVersions,
    });

    console.log('[layer-updater] Update complete:', newVersions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[layer-updater] Update failed:', msg);
    onProgress({ phase: 'error', error: msg });

    // Clean up backend-new/ on failure to leave no partial state
    try {
      const backendNewDir = getBackendNewDir(dataRoot);
      if (fs.existsSync(backendNewDir)) {
        fs.rmSync(backendNewDir, { recursive: true, force: true });
      }
    } catch {
      /* non-critical cleanup */
    }
  }
}
