// Run with dictation idle, the selected model ready, and the Dictate room open.
// Measures Sotto's installed processes, including its speech and key helpers;
// external provider tools are excluded. No command arguments or identities are saved.
//   node scripts/measure-dictation-idle.mjs --out release/dictation-baseline-idle.json
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { out: { type: 'string' } } })
if (process.platform !== 'darwin') throw new Error('This measurement requires the installed macOS app')
function snapshot() {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,cputime=,rss=,comm='], { encoding: 'utf8' })
    .split('\n').map(line => line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .filter(row => row[4].startsWith('/Applications/Sotto.app/Contents/'))
  if (!rows.some(row => row[4] === '/Applications/Sotto.app/Contents/MacOS/Sotto')) {
    throw new Error('The installed Sotto app is not running')
  }
  return rows.map(row => {
    const parts = row[2].split(':').map(Number)
    if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error('Unexpected ps CPU-time format')
    return { pid: Number(row[1]), cpuSeconds: parts[0] * 60 + parts[1], rssKiB: Number(row[3]) }
  })
}
const startedAt = performance.now()
const before = snapshot()
await sleep(30_000)
const after = snapshot()
const durationMs = performance.now() - startedAt
if (before.length !== after.length || before.some(row => !after.some(end => end.pid === row.pid))) {
  throw new Error('Sotto processes changed during the idle measurement; no result saved')
}
const rounded = value => Math.round(value * 1000) / 1000
const result = {
  durationMs: rounded(durationMs),
  processes: after.length,
  cpuPercentage: rounded((after.reduce((sum, row) => sum + row.cpuSeconds, 0)
    - before.reduce((sum, row) => sum + row.cpuSeconds, 0)) / (durationMs / 1000) * 100),
  rssStartMiB: rounded(before.reduce((sum, row) => sum + row.rssKiB, 0) / 1024),
  rssEndMiB: rounded(after.reduce((sum, row) => sum + row.rssKiB, 0) / 1024),
}
if (values.out) writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify(result)}\n`)
