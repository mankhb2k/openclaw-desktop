/**
 * Directory names under DATA_ROOT (userData in production, .openclaw-desktop-data in dev).
 * Keeps workspace, OpenClaw state, and logs separate from application code.
 */
export const PATH_NAMES = {
  workspace: 'workspace',
  openclaw: 'openclaw',
  logs: 'logs',
} as const;
