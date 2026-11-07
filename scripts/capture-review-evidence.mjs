// Captures the real running app in real, busy states, for side-by-side review and as "before" images for later changes.
// node scripts/capture-review-evidence.mjs <outDir> [--states a,b] [--boxes-from <composer/boxes.json>] [--no-build]
// See tests/e2e/review-evidence-capture.spec.ts for the states. Never touches a committed baseline or the user's profile.
import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args.splice(at, 2)[1] }
const states = option('--states'), boxes = option('--boxes-from')
const skipBuild = args.includes('--no-build')
const outDir = args.find(argument => !argument.startsWith('--'))
if (!outDir) {
  process.stderr.write('Say where the images go: node scripts/capture-review-evidence.mjs <outDir> [--states a,b] [--boxes-from <file>] [--no-build]\n')
  process.exit(2)
}

if (!skipBuild) {
  const built = spawnSync(process.execPath, [resolve('node_modules/electron-vite/bin/electron-vite.js'), 'build'], { stdio: 'inherit', windowsHide: true })
  if (built.status !== 0) process.exit(built.status ?? 1)
}

const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', 'tests/e2e/review-evidence-capture.spec.ts', '--workers=1'], {
  env: {
    ...process.env,
    // The zone and locale the fixture era's clock times are written for, as the design captures pin them.
    TZ: 'America/Los_Angeles',
    SOTTO_REVIEW_EVIDENCE_OUT: resolve(outDir),
    ...(states ? { SOTTO_REVIEW_EVIDENCE_STATES: states } : {}),
    ...(boxes ? { SOTTO_REVIEW_EVIDENCE_BOXES: resolve(boxes) } : {}),
  },
  stdio: 'inherit',
  windowsHide: true,
})
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
