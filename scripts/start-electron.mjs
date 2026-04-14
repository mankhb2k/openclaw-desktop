#!/usr/bin/env node
/**
 * start-electron.mjs
 *
 * Cross-platform launcher cho Electron dev mode.
 * Xóa ELECTRON_RUN_AS_NODE khỏi env trước khi spawn Electron.
 *
 * Claude Code (và một số CI runner) inject ELECTRON_RUN_AS_NODE=1 vào môi trường
 * để dùng Electron như Node.js runtime. Nếu không xóa, `require("electron")` trong
 * main process sẽ trả về module thiếu `app`, `BrowserWindow`, v.v.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBin, ['.'], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
