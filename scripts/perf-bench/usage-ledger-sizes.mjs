#!/usr/bin/env node
/**
 * How many usage ledgers a Sotto data folder holds, how large they are, and how long parsing them takes (#1937).
 *
 *   node scripts/perf-bench/usage-ledger-sizes.mjs ~/.sotto
 *
 * It reads each ledger and parses it once. It prints counts, sizes and times, and writes nothing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const data = (process.argv[2] ?? join(homedir(), '.sotto')).replace(/^~/u, homedir())
let files = 0, characters = 0, parseMs = 0, longestMs = 0
for (const folder of ['claude-usage', 'codex-usage']) {
  const names = (() => { try { return readdirSync(join(data, folder), { recursive: true }) } catch { return [] } })()
  for (const name of names) {
    const path = join(data, folder, String(name))
    if (!path.endsWith('.json') || !statSync(path).isFile()) continue
    const text = readFileSync(path, 'utf8')
    const started = process.hrtime.bigint()
    try { JSON.parse(text) } catch { /* a ledger that does not parse still cost its read */ }
    const took = Number(process.hrtime.bigint() - started) / 1e6
    files++; characters += text.length; parseMs += took; longestMs = Math.max(longestMs, took)
  }
}
console.log(JSON.stringify({ ledgers: files, characters, parseMs: Number(parseMs.toFixed(1)), longestParseMs: Number(longestMs.toFixed(1)) }))
