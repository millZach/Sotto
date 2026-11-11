#!/usr/bin/env node
/**
 * Why each provider session under a running Sotto host is still held (#2398), beside the process that holds it.
 *
 * Asks the host on this machine for the sessions its adapters hold (`POST /v1/admin/held-sessions`): for each, the
 * provider, the Sotto thread ID, how long since its last activity and every rule keeping it. Then reads /proc for each of
 * the host's child processes, its name, age and memory, and with `--seconds` the CPU it used over that many seconds, and
 * matches each process to its session by process ID. It prints names, ages, sizes, rule names and IDs, never a command
 * line, a title or anything a thread said.
 *
 *   node scripts/perf-bench/held-sessions.mjs --data ~/.sotto --seconds 60
 *
 * `--data` is the host's data folder: its `host-listener.json` holds the host's process ID and the admin port and token,
 * and the token is never printed. Linux only; run it on the host's own machine. A host whose release has no such read yet
 * still gets its process table, with every session unknown.
 *
 * The rules: `busy` a turn, a start or a command mid-dispatch; `request` a request nobody has answered; `background` a live
 * watch or background work (Claude Code); `compaction` a compaction running or unconfirmed; `reading` an owned history
 * read; `watched` the adapter's watched set; `live-session` Claude Code's live-session set. `recent` means no rule holds
 * it and its 30 minutes have not run out; `none` that the next sweep, at most five minutes away, stops it.
 */
import { Buffer } from 'node:buffer'
import { readdirSync, readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1] }
const data = String(option('data', join(homedir(), '.sotto'))).replace(/^~/u, homedir())
const seconds = Number(option('seconds', 0))
/** Linux counts process times in USER_HZ, which is 100 on every architecture Sotto runs on. */
const TICKS_PER_SECOND = 100

function post(port, path, token) {
  return new Promise((resolve, reject) => {
    const text = '{}'
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, response => {
      const parts = []
      response.on('data', part => parts.push(part))
      response.on('end', () => {
        let body
        try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { body = undefined }
        resolve({ status: response.statusCode, body })
      })
    })
    request.on('error', reject)
    request.end(text)
  })
}

/** The host's child processes: name, CPU ticks, start in ticks since boot, and resident memory in KB. */
function children(host) {
  const found = new Map()
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(rest[1]) !== host) continue
      const rss = Number(/VmRSS:\s+(\d+)/u.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))?.[1] ?? 0)
      found.set(Number(entry), { name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), ticks: Number(rest[11]) + Number(rest[12]), start: Number(rest[19]), rss })
    } catch { /* Gone while it was read. */ }
  }
  return found
}

const descriptor = JSON.parse(readFileSync(join(data, 'host-listener.json'), 'utf8'))
if (!Number.isInteger(descriptor.pid) || !Number.isInteger(descriptor.port) || typeof descriptor.adminToken !== 'string') {
  console.error('The host descriptor has no process ID, port or admin token. Start the host and try again.')
  process.exit(1)
}
const before = children(descriptor.pid)
if (seconds > 0) await sleep(seconds * 1000)
// The sessions are read once the sampling is over, beside the second look at the processes, so a session that was
// replaced while it ran is not shown as held and its replacement as untracked.
const answer = await post(descriptor.port, '/v1/admin/held-sessions', descriptor.adminToken)
let sessions
if (answer.status === 200 && Array.isArray(answer.body?.sessions)) sessions = answer.body.sessions
else if (answer.status === 400) console.log('This host has no held-sessions read yet (it needs a release with #2398). Its processes follow, with sessions unknown.\n')
else { console.error(`The host refused the read (${answer.status} ${answer.body?.error?.code ?? 'no answer'}). Nothing was changed.`); process.exit(1) }
const after = seconds > 0 ? children(descriptor.pid) : before
const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
const minutes = ms => `${Math.round(ms / 60_000)}`
const rows = []
const matched = new Set()
for (const [pid, child] of [...after].sort((a, b) => b[1].rss - a[1].rss)) {
  const session = sessions?.find(item => item.pid === pid)
  if (session) matched.add(session)
  const earlier = before.get(pid)
  rows.push({
    process: child.name, pid: String(pid), age: minutes((uptime - child.start / TICKS_PER_SECOND) * 1000), memory: `${Math.round(child.rss / 1024)}`,
    cpu: seconds > 0 ? (earlier ? ((child.ticks - earlier.ticks) / TICKS_PER_SECOND).toFixed(2) : 'new') : '',
    provider: session?.provider ?? (sessions ? 'no session' : '?'), thread: session?.threadId ?? '', idle: session ? minutes(session.idleMs) : '', holds: session?.holds.join(' ') ?? '',
  })
}
for (const session of sessions ?? []) {
  if (matched.has(session)) continue
  rows.push({ process: '-', pid: session.pid === undefined ? '' : String(session.pid), age: '', memory: '', cpu: '', provider: session.provider,
    thread: session.threadId ?? '(no thread)', idle: minutes(session.idleMs), holds: session.holds.join(' ') })
}

const columns = [['process', 'Process'], ['pid', 'PID'], ['age', 'Age min'], ['memory', 'Memory MB'], ...seconds > 0 ? [['cpu', `CPU in ${seconds} s`]] : [],
  ['provider', 'Provider'], ['thread', 'Thread'], ['idle', 'Idle min'], ['holds', 'Held by']]
const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map(row => row[key].length)))
const line = values => values.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd()
console.log(line(columns.map(([, title]) => title)))
for (const row of rows) console.log(line(columns.map(([key]) => row[key])))
const total = [...after.values()].reduce((sum, child) => sum + child.rss, 0)
console.log(`\n${after.size} processes, ${Math.round(total / 1024)} MB; ${sessions ? `${sessions.length} sessions held` : 'sessions unknown'}`)
if (sessions) {
  const counts = new Map()
  for (const session of sessions) for (const hold of session.holds) counts.set(hold, (counts.get(hold) ?? 0) + 1)
  console.log([...counts].map(([hold, count]) => `${hold} ${count}`).join(', '))
}
