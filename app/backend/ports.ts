import * as net from 'net';

/**
 * Probe 0.0.0.0 so we do not pick a port already taken by another IPv4 listener
 * (matches gateway bind; avoids EADDRINUSE on Windows).
 */
function listenOnce(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Unexpected server address'));
        return;
      }
      const chosen = addr.port;
      server.close(() => resolve(chosen));
    });
  });
}

/**
 * Resolves when something accepts TCP connections on host:port (gateway HTTP up).
 * Avoids Electron loadURL while the process has spawned but not yet listening.
 */
export function waitForTcpPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = (): void => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${host}:${port}`));
        return;
      }
      const socket = net.createConnection({ host, port }, () => {
        socket.destroy();
        resolve();
      });
      socket.setTimeout(2000);
      socket.once('error', () => {
        socket.destroy();
        setTimeout(tryConnect, 150);
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

/** Default OpenClaw gateway WebSocket / Control UI HTTP port range start. */
export async function allocateGatewayPort(preferred = 18789): Promise<number> {
  const host = '0.0.0.0';
  for (let p = preferred; p < preferred + 40; p++) {
    try {
      return await listenOnce(p, host);
    } catch {
      /* try next */
    }
  }
  return listenOnce(0, host);
}
