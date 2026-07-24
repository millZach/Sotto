import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const update = process.argv.includes('--update')
const cli = resolve(process.cwd(), 'node_modules/@playwright/test/cli.js')
const child = spawn(process.execPath, [cli, 'test', 'tests/e2e/design-capture.spec.ts', '--workers=1'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SOTTO_DESIGN_CAPTURE: '1',
    SOTTO_UPDATE_DESIGN_BASELINES: update ? '1' : '0',
  },
  stdio: 'inherit',
  windowsHide: true,
})

child.once('error', (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Design capture could not start'}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal !== null) {
    process.stderr.write(`Design capture stopped by ${signal}\n`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
