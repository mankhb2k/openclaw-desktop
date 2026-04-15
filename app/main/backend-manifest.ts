/**
 * backend-manifest.ts
 *
 * Types và helpers cho backend-manifest.json (schema v3) — 1 layer duy nhất.
 *
 * Manifest được host trên GitHub tại:
 *   https://raw.githubusercontent.com/mankhb2k/openclaw-desktop/main/release/backend-manifest.json
 *
 * Local state: dataRoot/backend-version.json
 */
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// ── Manifest types (schema v3) ────────────────────────────────────────────────

export interface BackendManifest {
  schemaVersion: 3;
  /** openclaw version string, e.g. "2026.4.5" */
  version: string;
  /** SHA-256 hex digest của file tar.gz */
  sha256: string;
  /** Download URL (GitHub Releases) */
  url: string;
  /** Compressed size in bytes */
  compressedBytes: number;
  /** App version tối thiểu cần để dùng layer này */
  minAppVersion?: string;
  releaseNotes?: Record<string, string>;
}

// ── Local version tracking ────────────────────────────────────────────────────

export interface LocalBackendVersion {
  /** openclaw version đã cài, e.g. "2026.4.5" */
  version: string;
  /** Electron version mà binaries được build cho */
  electronVersion?: string;
  /** SHA-256 của layer tar.gz đã cài — dùng để detect repacked layers */
  sha256?: string;
}

const BACKEND_VERSION_FILE = 'backend-version.json';

/** Đọc backend-version.json, trả về null nếu chưa có hoặc invalid */
export function readLocalBackendVersion(dataRoot: string): LocalBackendVersion | null {
  const versionFile = path.join(dataRoot, BACKEND_VERSION_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      // schema v3: { version, electronVersion, sha256? }
      if (typeof p.version === 'string') {
        return {
          version: p.version,
          electronVersion: p.electronVersion as string | undefined,
          sha256: p.sha256 as string | undefined,
        };
      }
      // backward compat: old v2 format { "openclaw": "...", "root-runtime": "...", "electronVersion": "..." }
      if (typeof p.openclaw === 'string') {
        return { version: p.openclaw as string, electronVersion: p.electronVersion as string | undefined };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Ghi backend-version.json (atomic write) */
export function writeLocalBackendVersion(dataRoot: string, ver: LocalBackendVersion): void {
  const versionFile = path.join(dataRoot, BACKEND_VERSION_FILE);
  const tmp = `${versionFile}.tmp.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(ver, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, versionFile);
}

// ── Manifest fetch ────────────────────────────────────────────────────────────

/** Fetch và parse backend-manifest.json */
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

  if (m.schemaVersion !== 3) {
    throw new Error(
      `backend-manifest.json: unsupported schemaVersion=${m.schemaVersion} (expected 3)`,
    );
  }
  if (typeof m.version !== 'string' || !m.version) {
    throw new Error('backend-manifest.json: missing "version" field');
  }
  if (typeof m.sha256 !== 'string' || !m.sha256) {
    throw new Error('backend-manifest.json: missing "sha256" field');
  }
  if (typeof m.url !== 'string' || !m.url) {
    throw new Error('backend-manifest.json: missing "url" field');
  }

  return data as BackendManifest;
}

// ── Update check ──────────────────────────────────────────────────────────────

/**
 * Trả về true nếu cần download layer mới.
 * So sánh local version với manifest, và Electron version.
 */
export function needsUpdate(
  local: LocalBackendVersion | null,
  manifest: BackendManifest,
  currentElectronVersion: string,
): boolean {
  if (!local) return true;

  // Nếu Electron version không khớp → phải cài lại EXE, không update layer
  if (
    local.electronVersion &&
    local.electronVersion !== currentElectronVersion
  ) {
    console.warn(
      `[backend-manifest] Electron version mismatch: local=${local.electronVersion}, ` +
        `running=${currentElectronVersion}. Skipping layer update — EXE rebuild required.`,
    );
    return false;
  }

  if (local.version !== manifest.version) return true;

  // Same version but different SHA-256 → layer was repacked with fixes, need re-download
  if (local.sha256 && local.sha256 !== manifest.sha256) {
    console.warn(
      `[backend-manifest] SHA-256 mismatch for v${local.version}: ` +
        `local=${local.sha256.slice(0, 8)}… manifest=${manifest.sha256.slice(0, 8)}…`,
    );
    return true;
  }

  return false;
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
