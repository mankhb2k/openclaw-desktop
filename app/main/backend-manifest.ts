/**
 * backend-manifest.ts
 *
 * Types và helpers để làm việc với backend-manifest.json (schema v2) theo layer-analysis.md mục 8.
 *
 * Manifest được host trên GitHub Releases và mô tả 2 layers cần download:
 *   - root-runtime: ~35 MB nén, thay đổi ít (vài tháng 1 lần)
 *   - openclaw:     ~380 MB nén, thay đổi mỗi khi openclaw bump version
 *
 * Local state được lưu ở: dataRoot/backend-version.json
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// ── Manifest types ────────────────────────────────────────────────────────────

export interface LayerInfo {
  /** Semantic version string. root-runtime dùng integer string "1","2"...; openclaw dùng npm version "2026.4.5" */
  version: string;
  /** SHA-256 hex digest của file tar.gz */
  sha256: string;
  /** Download URL (phải là GitHub Releases, theo RULE-08) */
  url: string;
  /** Compressed size in bytes */
  compressedBytes: number;
  /** Uncompressed size in bytes (0 nếu chưa đo) */
  uncompressedBytes: number;
  /** Relative path inside dataRoot/backend/ to extract to */
  extractTo: 'node_modules';
  /** Nếu true: chạy hoistScript sau khi extract */
  requiresHoist: boolean;
  /** Path to hoist script relative to project root (chỉ có ở openclaw layer) */
  hoistScript?: string;
  /** Version trước đó (để log changelog), null nếu là lần đầu */
  changedFrom: string | null;
}

export interface BackendManifest {
  schemaVersion: 2;
  generatedAt: string;
  /** Electron version mà NATIVE binaries được build cho — phải match với running app */
  electronVersion: string;
  platform: string;
  arch: string;
  layers: {
    'root-runtime': LayerInfo;
    openclaw: LayerInfo;
  };
  /** Thứ tự extract bắt buộc (root-runtime trước, openclaw sau) */
  extractOrder: string[];
  /** Version EXE tối thiểu cần để dùng layers này */
  minAppVersion: string;
  releaseNotes?: Record<string, string>;
}

// ── Local version tracking ────────────────────────────────────────────────────

export interface LocalBackendVersions {
  'root-runtime': string;
  openclaw: string;
  /** Electron version mà các NATIVE binaries trong backend/ được build cho */
  electronVersion?: string;
}

const BACKEND_VERSION_FILE = 'backend-version.json';

/** Đọc backend-version.json từ dataRoot, trả về null nếu chưa tồn tại hoặc invalid */
export function readLocalBackendVersions(dataRoot: string): LocalBackendVersions | null {
  const versionFile = path.join(dataRoot, BACKEND_VERSION_FILE);
  try {
    const raw = fs.readFileSync(versionFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'openclaw' in parsed &&
      'root-runtime' in parsed
    ) {
      return parsed as LocalBackendVersions;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ghi backend-version.json vào dataRoot (atomic write) */
export function writeLocalBackendVersions(
  dataRoot: string,
  versions: LocalBackendVersions,
): void {
  const versionFile = path.join(dataRoot, BACKEND_VERSION_FILE);
  const tmp = `${versionFile}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(versions, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, versionFile);
}

// ── Manifest fetch ────────────────────────────────────────────────────────────

/** Fetch và parse backend-manifest.json từ GitHub Releases URL */
export async function fetchBackendManifest(url: string): Promise<BackendManifest> {
  const res = await axios.get<unknown>(url, {
    timeout: 15_000,
    headers: { 'Cache-Control': 'no-cache' },
  });
  const data = res.data;

  if (!data || typeof data !== 'object') {
    throw new Error('backend-manifest.json: not a JSON object');
  }
  const m = data as Record<string, unknown>;

  if (m.schemaVersion !== 2) {
    throw new Error(
      `backend-manifest.json: unsupported schemaVersion=${m.schemaVersion} (expected 2)`,
    );
  }
  if (!m.layers || typeof m.layers !== 'object') {
    throw new Error('backend-manifest.json: missing "layers" field');
  }

  return data as BackendManifest;
}

// ── Layer diff ────────────────────────────────────────────────────────────────

export type LayerName = 'root-runtime' | 'openclaw';

/**
 * So sánh local versions với manifest và trả về danh sách layers cần update.
 * Theo extractOrder của manifest để đảm bảo đúng thứ tự.
 */
export function diffLayers(
  local: LocalBackendVersions | null,
  manifest: BackendManifest,
  currentElectronVersion: string,
): LayerName[] {
  const needsUpdate: LayerName[] = [];

  // Nếu NATIVE binaries (electronVersion) không khớp → cần rebuild EXE, không download layers
  // (RULE-01: không được release chỉ layer khi Electron đã đổi version)
  if (
    local?.electronVersion &&
    local.electronVersion !== currentElectronVersion &&
    manifest.electronVersion !== currentElectronVersion
  ) {
    console.warn(
      `[backend-manifest] Electron version mismatch: local=${local.electronVersion}, ` +
        `manifest=${manifest.electronVersion}, running=${currentElectronVersion}. ` +
        `Skipping layer update — EXE rebuild required.`,
    );
    return [];
  }

  const order = (manifest.extractOrder || ['root-runtime', 'openclaw']) as LayerName[];
  for (const layerName of order) {
    const remoteLayer = manifest.layers[layerName];
    if (!remoteLayer) continue;

    const localVersion = local?.[layerName];
    if (!localVersion || localVersion !== remoteLayer.version) {
      needsUpdate.push(layerName);
    }
  }

  return needsUpdate;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

export function getBackendDir(dataRoot: string): string {
  return path.join(dataRoot, 'backend');
}

export function getBackendNewDir(dataRoot: string): string {
  return path.join(dataRoot, 'backend-new');
}

export function getBackendOldDir(dataRoot: string): string {
  return path.join(dataRoot, 'backend-old');
}

export function getDownloadDir(dataRoot: string): string {
  return path.join(dataRoot, 'backend-dl');
}
