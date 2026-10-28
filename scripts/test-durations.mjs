// Writes tests/fixtures/testDurations.json, the per-file test time the shard sequencer balances by
// (tests/shardSequencer.ts), from the verbose logs of one CI run's Windows shards:
// node scripts/test-durations.mjs <run id>. Needs the gh CLI signed in.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'

const run = process.argv[2]
if (!/^\d+$/u.test(run ?? '')) throw new Error('Usage: node scripts/test-durations.mjs <run id>')
const gh = (...args) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const jobs = JSON.parse(gh(`repos/millZach/Sotto/actions/runs/${run}/jobs?per_page=100`)).jobs
  .filter(job => job.name.startsWith('Tests (Windows,') && job.conclusion === 'success')
if (jobs.length !== 6) throw new Error(`Run ${run} has ${jobs.length} passing Windows shards, not 6`)
const files = {}
for (const job of jobs) {
  for (const line of stripVTControlCharacters(gh(`repos/millZach/Sotto/actions/jobs/${job.id}/logs`)).split('\n')) {
    const match = /^\S+\s+[✓×]\s+(tests\/\S+?\.(?:test|spec)\.\w+)\s.*?(\d+)ms\s*$/u.exec(line)
    if (match) files[match[1]] = (files[match[1]] ?? 0) + Number(match[2])
  }
}
const sorted = Object.fromEntries(Object.keys(files).sort().map(file => [file, Math.round(files[file] / 100) * 100]))
writeFileSync('tests/fixtures/testDurations.json', JSON.stringify(sorted, null, 2) + '\n')
process.stdout.write(`${Object.keys(sorted).length} files from run ${run}\n`)
