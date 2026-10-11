import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

if (process.platform !== 'win32') throw new Error('The desktop smoke check must run on Windows.')
const npm = process.env.npm_execpath
if (!npm) throw new Error('Start this check with npm run test:desktop-smoke.')
const root = fileURLToPath(new URL('..', import.meta.url))
const performanceData = join(root, 'artifacts/review-393/absent-perf-data')
if (existsSync(performanceData)) throw new Error('The desktop check requires its performance data path to be absent.')
const env = { ...process.env, SOTTO_PERF_DATA: performanceData, SOTTO_E2E_ARTIFACT_ROOT: join(root, 'artifacts/review-393/desktop-run') }
for (const key of Object.keys(env)) if (/^SOTTO_.*_LIVE$/.test(key)) delete env[key]
// The command builds this checkout; a caller's diagnostic override must not launch another app.
delete env.SOTTO_E2E_MAIN_ENTRY
delete env.SOTTO_PERF_BENCH
delete env.SOTTO_PERF_ASSERT

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run([npm, 'run', 'test:recovery'])
run([join(root, 'node_modules/@playwright/test/cli.js'), 'test',
  'tests/e2e/daily-workspace.spec.ts', 'tests/e2e/settings-index.spec.ts', 'tests/e2e/widget-dictation.spec.ts', '--workers=1'])
