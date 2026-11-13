#!/usr/bin/env node
/**
 * What Show earlier messages costs a running Sotto host on an iPhone's behalf (ADR-0194, November 12, 2026).
 *
 * Pairs a throwaway phone with the host on this machine, sends the iPhone's own hello (its `accepts` read from the Swift
 * source), opens one thread, reads its detail, then presses Show earlier messages as the iPhone does (`earlier-steps`)
 * until nothing more is above the window or `--presses` runs out. For each it prints the time the host took to answer,
 * the answer's size, its revision and its counts of messages and steps. The pairing is removed when the run ends,
 * however it ends.
 *
 * It sends nothing but hello, observe, detail and earlier-steps: no prompt, no answer, no command. Observing a thread
 * clears its unread mark for every client, so it refuses a thread that carries one. It prints counts, sizes and
 * revisions, never anything a thread said.
 *
 *   node scripts/perf-bench/earlier-steps-probe.mjs --data ~/.sotto --thread <thread ID> --presses 12
 *
 * `--data` is the host's data folder (its `host-listener.json` holds the admin port and token, which are never printed).
 * Run it on the host's own machine. An answer at the revision the phone already holds is what the iPhone takes in place
 * of its copy, so the page must not key what it shows on the revision alone.
 */
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { iphoneAccepts } from '../../tests/fixtures/iphoneAccepts.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1] }
const data = String(option('data', join(homedir(), '.sotto'))).replace(/^~/u, homedir())
const threadId = option('thread', '')
const presses = Number(option('presses', 12))
if (!threadId) { console.error('Name the thread to open with --thread <thread ID>.'); process.exit(2) }

const listener = JSON.parse(readFileSync(join(data, 'host-listener.json'), 'utf8'))
const base = `http://127.0.0.1:${listener.port}`
async function post(path, bearer, body) {
  const response = await globalThis.fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body ?? {}) })
  const answer = await response.json()
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${answer.error?.code ?? ''}`)
  return answer
}
const steps = detail => (detail.activities ?? []).filter(record => record.kind !== 'turn').length
const describe = detail => detail ? `revision ${detail.revision}, ${detail.messages.length} messages, ${steps(detail)} steps, ${detail.earlierSteps ?? 0} steps above${detail.earlierAvailable ? '' : ', nothing earlier'}` : 'no such thread'

const { code } = await post('/v1/admin/pairing-code', listener.adminToken)
const pairing = await post('/v1/pair', null, { v: 1, code, name: 'earlier-steps-probe' })
let socket
try {
  const { session } = await post('/v1/session', pairing.token)
  socket = new globalThis.WebSocket(`ws://127.0.0.1:${listener.port}/v1/socket`, { headers: { Authorization: `Bearer ${session}` } })
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('The socket did not open')) })
  const waiting = new Map()
  socket.onmessage = event => {
    const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
    const message = JSON.parse(text)
    const answer = message.id === undefined ? undefined : waiting.get(message.id)
    if (answer) { waiting.delete(message.id); answer({ message, bytes: Buffer.byteLength(text) }) }
  }
  let next = 0
  const call = (op, fields = {}) => new Promise(resolve => {
    const id = `probe-${++next}`
    waiting.set(id, resolve)
    socket.send(JSON.stringify({ v: 1, id, session, op, ...fields }))
  })
  const timed = async (op, fields) => { const start = performance.now(); const answer = await call(op, fields); return { ...answer, ms: performance.now() - start } }

  const hello = await call('hello', { afterSeq: Number.MAX_SAFE_INTEGER, accepts: iphoneAccepts() })
  if (hello.message.error) throw new Error(`hello was refused: ${hello.message.error.code}`)
  if (!hello.message.result.features.includes('step-window')) throw new Error('This host does not cut threads to a step window')
  const listed = hello.message.result.shell?.host?.threads?.find(thread => thread.id === threadId)
  if (listed?.finishedUnread === true) throw new Error('That thread carries an unread mark, which opening it would clear')
  await call('observe', { threadIds: [threadId] })
  const opened = await timed('detail', { threadId })
  console.log(`open: ${opened.ms.toFixed(0)} ms, ${(opened.bytes / 1024).toFixed(0)} KB, ${describe(opened.message.result)}`)
  for (let press = 1; press <= presses; press++) {
    const answer = await timed('earlier-steps', { threadId })
    if (answer.message.error) { console.log(`press ${press}: refused with ${answer.message.error.code} after ${answer.ms.toFixed(0)} ms`); break }
    console.log(`press ${press}: ${answer.ms.toFixed(0)} ms, ${(answer.bytes / 1024).toFixed(0)} KB, ${describe(answer.message.result)}`)
    if (!answer.message.result?.earlierAvailable) break
  }
  await call('observe', { threadIds: [] })
} finally {
  try { socket?.close() } catch { /* closing a socket that never opened */ }
  await post('/v1/admin/revoke-client', listener.adminToken, { clientId: pairing.clientId })
}
