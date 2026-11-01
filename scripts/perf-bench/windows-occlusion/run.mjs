// What a covered, minimized or hidden Sotto window costs on Windows, with Chromium's occlusion detection off and on
// (#993, ADR-0020's November 1, 2026 amendment). Windows only, and outside CI: it launches the built app directly with
// Electron, not through Playwright, whose launcher keeps a covered or minimized window drawing at 60 frames a second
// whatever its switches say, so occlusion cannot be seen there.
//
//   npm run build
//   node scripts/perf-bench/windows-occlusion/run.mjs cpu off 1
//   node scripts/perf-bench/windows-occlusion/run.mjs cpu on 1
//
// Alternate off and on, three runs each, so whatever else the computer is doing falls on both sides alike. `cpu` streams
// two panes and samples renderer, main and GPU CPU in six window states; `capture` opens a probe page with the agent
// browser tool in the browser player, hidden, in Tools > Browser, on the test iPhone and with the phone hidden, and in
// every window state checks navigation, capture, and that a click or tap, a scroll or swipe and typing reach the page.
// It exits non-zero on any failure but the one already known with detection off (#1999). Each run uses an e2e profile
// of its own in the temporary folder, never the user's, and writes `results/<mode>-<side>-run<run>.json` beside this file.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [mode, side, run = '1'] = process.argv.slice(2)
if (process.platform !== 'win32') throw new Error('This benchmark measures Windows occlusion and runs only on Windows.')
if (!['cpu', 'capture'].includes(mode) || !['off', 'on'].includes(side)) throw new Error('Usage: run.mjs <cpu|capture> <off|on> [run]')
const here = dirname(fileURLToPath(import.meta.url))
const built = resolve('out/main/index.js')
if (!existsSync(built)) throw new Error('Build the app first: npm run build')
// The entry and driver sit beside the built main bundle, so the app resolves its own files as it always does.
copyFileSync(join(here, 'entry.cjs'), resolve('out/main/occlusion-entry.cjs'))
copyFileSync(join(here, 'driver.cjs'), resolve('out/main/occlusion-driver.cjs'))
mkdirSync(join(here, 'results'), { recursive: true })
const out = join(here, 'results', `${mode}-${side}-run${run}.json`)
rmSync(out, { force: true })

// The whole computer's busy share over five seconds before the launch, kept with the result.
const times = () => cpus().reduce((sum, core) => ({ idle: sum.idle + core.times.idle, total: sum.total + core.times.user + core.times.nice + core.times.sys + core.times.idle + core.times.irq }), { idle: 0, total: 0 })
const before = times(); await new Promise(done => setTimeout(done, 5_000)); const after = times()
const preRunSystemPercent = Math.round((1 - (after.idle - before.idle) / (after.total - before.total)) * 1000) / 10

const profile = mkdtempSync(join(tmpdir(), 'sotto-e2e-occlusion-'))
const env = { ...process.env, SOTTO_E2E: '1', SOTTO_E2E_SCENARIO: mode === 'cpu' ? 'phase3-workspace' : 'success', SOTTO_E2E_USER_DATA: profile,
  OCCLUSION_DRIVE: mode, OCCLUSION_SIDE: side, OCCLUSION_RUN: run, OCCLUSION_OUT: out }
delete env.ELECTRON_RUN_AS_NODE
const started = Date.now()
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('out/main/occlusion-entry.cjs')], { env, stdio: 'ignore' })
console.log(`${mode} ${side} run ${run}: computer ${preRunSystemPercent}% busy before launch, Electron pid ${child.pid}`)
const limit = setTimeout(() => { console.log(`Stopping pid ${child.pid}: no result after six minutes.`); child.kill() }, 360_000)
const code = await new Promise(done => child.on('exit', done))
clearTimeout(limit)
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
if (!existsSync(out)) { console.log(`No result (exit ${code}).`); process.exit(1) }
const report = JSON.parse(readFileSync(out, 'utf8'))
report.preRunSystemPercent = preRunSystemPercent
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
console.log(`Exit ${code} after ${Math.round((Date.now() - started) / 1000)} s, ok=${report.ok}${report.error ? ` ${report.error.split('\n')[0]}` : ''}`)
for (const line of report.log) console.log(`  ${line.replace(/^\S+ /, '')}`)
if (report.unexpected?.length) console.log(`Unexpected failures: ${report.unexpected.join('; ')}`)
// A run that could not finish, or a capture or input that failed other than the known minimized one (#1999), fails.
if (!report.ok) process.exit(1)
