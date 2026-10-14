// Usage: node tools/verify-certified-detail.mjs (after npm run build); captures both gate states in real Electron.
import { spawnSync } from 'node:child_process'
import process from 'node:process'
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', 'tests/e2e/certified-detail.spec.ts'], { stdio: 'inherit', env: process.env })
process.exitCode = result.status ?? 1
