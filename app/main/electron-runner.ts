import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Executable used for `spawn` with `ELECTRON_RUN_AS_NODE=1` (backend launcher).
 * Portable Windows builds extract to a temp folder; `process.execPath` can point at a path
 * that is not the real Electron binary (ENOENT on spawn). Prefer `app.getPath('exe')` when packaged.
 */
export function resolveElectronRunnerPath(): string {
  const candidates: string[] = [];
  try {
    if (app.isPackaged) {
      candidates.push(app.getPath('exe'));
    }
  } catch {
    /* e.g. app not ready — fall through */
  }
  candidates.push(process.execPath);

  const seen = new Set<string>();
  for (const raw of candidates) {
    const resolved = path.resolve(raw.trim());
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    try {
      if (fs.existsSync(resolved)) {
        try {
          return fs.realpathSync(resolved);
        } catch {
          return resolved;
        }
      }
    } catch {
      /* ignore */
    }
  }
  const fallback = path.resolve(process.execPath);
  try {
    return fs.realpathSync(fallback);
  } catch {
    return fallback;
  }
}
