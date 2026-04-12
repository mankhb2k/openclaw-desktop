import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const ICON_ICO = 'icon.ico';

/**
 * OpenClaw BrowserWindow / taskbar icon.
 * Looks for assets/icon.ico relative to the app root or dist/main directory.
 * Place a 256x256 .ico file at assets/icon.ico in the project root.
 *
 * Packaged Windows: paths inside `app.asar` are not valid for native icon APIs.
 */
export function resolveWindowIconPath(): string | undefined {
  if (process.platform === 'win32' && app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'assets',
      ICON_ICO,
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
  }

  const candidates = [
    path.join(__dirname, '..', '..', 'assets', ICON_ICO),
    path.join(__dirname, 'assets', ICON_ICO),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return undefined;
}
