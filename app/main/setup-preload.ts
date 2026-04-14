/**
 * setup-preload.ts
 *
 * Preload script cho setup window (first-run backend download).
 * Expose `window.setupAPI` với 2 methods:
 *   - startDownload(): gửi signal lên main process để bắt đầu download
 *   - onProgress(cb): nhận progress updates từ main process
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { LayerUpdateState } from './layer-updater';

contextBridge.exposeInMainWorld('setupAPI', {
  /** Renderer gọi khi user bấm nút "Tải backend" */
  startDownload: (): void => {
    ipcRenderer.send('setup:start-download');
  },

  /** Đăng ký callback nhận progress từ main process */
  onProgress: (cb: (state: LayerUpdateState) => void): void => {
    ipcRenderer.on('setup:progress', (_event, state: LayerUpdateState) => cb(state));
  },
});
