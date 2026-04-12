import * as fs from 'fs';
import * as path from 'path';

/**
 * Windows: child_process cwd must be a real directory. Packaged `OPENCLAW_APP_ROOT` is
 * `...\resources\app.asar` (a file) — using it as cwd breaks spawn (often ENOENT on the exe).
 */
export function resolveSpawnCwd(appRoot: string, electronExe: string): string {
  if (process.platform !== 'win32') {
    return appRoot;
  }
  const normalized = path.normalize(appRoot);
  if (normalized.toLowerCase().endsWith('.asar')) {
    return path.dirname(normalized);
  }
  try {
    if (fs.existsSync(normalized)) {
      const st = fs.statSync(normalized);
      if (!st.isDirectory()) {
        return path.dirname(normalized);
      }
      return appRoot;
    }
  } catch {
    return path.dirname(normalized);
  }
  return path.dirname(electronExe);
}
