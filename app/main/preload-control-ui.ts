import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export type RunUpdateOpenclawResult =
  | { ok: true; message?: string }
  | { ok: false; error?: string; stderrTail?: string };
export type DesktopUpdateState = {
  isPackaged: boolean;
  enabled: boolean;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unsupported';
  currentVersion: string;
  availableVersion: string | null;
  announcementTitle: string | null;
  announcementDescription: string | null;
  progressPercent: number | null;
  message: string | null;
};

contextBridge.exposeInMainWorld('openclawDesktop', {
  runUpdateOpenclaw: (): Promise<RunUpdateOpenclawResult> =>
    ipcRenderer.invoke('desktop:run-update-openclaw'),
  getUpdateState: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('desktop:update:get-state'),
  checkForUpdates: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('desktop:update:check'),
  downloadUpdate: (): Promise<DesktopUpdateState> => ipcRenderer.invoke('desktop:update:download'),
  installUpdate: (): Promise<{ ok: true }> => ipcRenderer.invoke('desktop:update:install'),
  onUpdateState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: DesktopUpdateState) => {
      listener(payload);
    };
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
});
