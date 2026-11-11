#!/usr/bin/env node
/**
 * What a running Sotto host sends an iPhone, in bytes, by message type.
 *
 * Pairs a throwaway phone with the host on this machine, sends the iPhone's own hello (its `accepts` read from the Swift
 * source beside this script), and counts what arrives: the hello's answer, a stretch on the Threads list, one thread
 * opened, and a stretch with that thread open. The pairing is removed when the run ends, however it ends.
 *
 * It sends nothing but hello, observe and pings: no prompt, no answer, no command. It opens only a thread that carries no
 * unread mark, since observing a thread clears that mark for every client. It prints counts, sizes and field names, and
 * keeps no message text.
 *
 *   node scripts/perf-bench/phone-wire-probe.mjs --data ~/.sotto --list-seconds 60 --thread-seconds 60
 *
 * `--data` is the host's data folder (its `host-listener.json` holds the admin port and token, which are never printed).
 * `--no-open` leaves out the opened thread. Run it on the host's own machine.
 */
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { clearInterval, setInterval, setTimeout } from 'node:timers'
import { deflateRawSync, constants as zlib } from 'node:zlib'
// The iPhone's hello `accepts`, read from its source so this never drifts from the app; the benchmarks read it the same way.
import { iphoneAccepts } from '../../tests/fixtures/iphoneAccepts.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1] }
const data = String(option('data', join(homedir(), '.sotto'))).replace(/^~/u, homedir())
const listSeconds = Number(option('list-seconds', 60)), threadSeconds = Number(option('thread-seconds', 60))
const open = !args.includes('--no-open')

function post(port, path, token, body) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) } }, response => {
      const parts = []
      response.on('data', part => parts.push(part))
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error(`${path} answered ${response.statusCode}`)); return }
        try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch { reject(new Error(`${path} answered something that is not JSON`)) }
      })
    })
    request.on('error', reject); request.end(text)
  })
}

const size = value => Buffer.byteLength(JSON.stringify(value))
/** Adds the size of each part of a shell's state to `into`: its own parts, the host's, and Watcher's page's. */
function addStateParts(state, into, { host = 'host', watcher = 'watcher', own = '' } = {}) {
  const add = (table, key, value) => { table[key] = (table[key] ?? 0) + size(value) }
  for (const [key, value] of Object.entries(state ?? {})) {
    if (key === 'host') for (const [inner, innerValue] of Object.entries(value ?? {})) add(into[host], inner, innerValue)
    else if (key === 'watcher') for (const [inner, innerValue] of Object.entries(value ?? {})) add(into[watcher], inner, innerValue)
    else add(into[own], key, value)
  }
}
const deflated = buffer => buffer.length < 1024 ? buffer.length : Math.min(buffer.length, deflateRawSync(buffer, { level: 6, finishFlush: zlib.Z_SYNC_FLUSH }).length)

/** A WebSocket client that offers no extension, as a phone the host does not compress for, and counts what it is sent. */
function socket(port, session, onMessage) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/v1/socket', headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Authorization: `Bearer ${session}` } })
    request.on('error', reject)
    request.on('response', response => reject(new Error(`The socket upgrade answered ${response.statusCode}`)))
    request.on('upgrade', (_response, stream, head) => {
      let buffer = Buffer.from(head), fragments = null
      const write = (opcode, payload) => {
        const mask = randomBytes(4), length = payload.length
        const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : length < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255]) : (() => { const wide = Buffer.alloc(10); wide[0] = 0x80 | opcode; wide[1] = 0x80 | 127; wide.writeBigUInt64BE(BigInt(length), 2); return wide })()
        const masked = Buffer.from(payload); for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4]
        stream.write(Buffer.concat([header, mask, masked]))
      }
      const read = () => {
        for (;;) {
          if (buffer.length < 2) return
          const opcode = buffer[0] & 15, fin = (buffer[0] & 128) !== 0
          let length = buffer[1] & 127, header = 2
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); header = 4 }
          else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); header = 10 }
          if (buffer.length < header + length) return
          const payload = buffer.subarray(header, header + length)
          buffer = buffer.subarray(header + length)
          if (opcode === 9) { write(10, payload); continue }
          if (opcode === 10) continue
          if (opcode === 8) { stream.end(); return }
          if (opcode === 0) { if (fragments) fragments.push(payload) } else fragments = [payload]
          if (fin && fragments) { const whole = Buffer.concat(fragments); fragments = null; onMessage(whole) }
        }
      }
      stream.on('data', part => { buffer = buffer.length ? Buffer.concat([buffer, part]) : part; read() })
      stream.on('error', () => undefined)
      resolve({ send: message => write(1, Buffer.from(JSON.stringify(message))), ping: () => write(9, Buffer.alloc(0)), close: () => { write(8, Buffer.alloc(0)); stream.end() }, closed: new Promise(done => stream.on('close', done)) })
      read()
    })
    request.end()
  })
}

const fresh = () => ({ events: {}, shellFields: {}, hostFields: {}, watcherFields: {}, changedRecords: 0 })
function tallyMessage(tally, raw) {
  const message = JSON.parse(raw.toString('utf8'))
  const name = message.event ?? (message.id ? 'reply' : 'other')
  const entry = tally.events[name] ??= { frames: 0, bytes: 0, deflatedBytes: 0, maxBytes: 0 }
  entry.frames++; entry.bytes += raw.length; entry.deflatedBytes += deflated(raw); entry.maxBytes = Math.max(entry.maxBytes, raw.length)
  if (name === 'shell') {
    addStateParts(message.state, tally, { host: 'hostFields', watcher: 'watcherFields', own: 'shellFields' })
    if (message.threads) { tally.shellFields['(changed thread records)'] = (tally.shellFields['(changed thread records)'] ?? 0) + size(message.threads); tally.changedRecords += message.threads.changed?.length ?? 0 }
  }
  return message
}
const top = (table, limit = 12) => Object.fromEntries(Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, limit))
const summed = tally => {
  const totals = Object.values(tally.events).reduce((sum, entry) => ({ frames: sum.frames + entry.frames, bytes: sum.bytes + entry.bytes, deflatedBytes: sum.deflatedBytes + entry.deflatedBytes }), { frames: 0, bytes: 0, deflatedBytes: 0 })
  return { ...totals, events: tally.events, changedThreadRecords: tally.changedRecords, shellBytesByField: top(tally.shellFields), shellHostBytesByField: top(tally.hostFields), shellWatcherPageBytesByField: top(tally.watcherFields) }
}
const wait = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000))

const listener = JSON.parse(readFileSync(join(data, 'host-listener.json'), 'utf8'))
let phonePort = listener.port
try { phonePort = JSON.parse(readFileSync(join(data, 'phone-access.json'), 'utf8')).port ?? phonePort } catch { /* a host with no tailnet listener serves a phone on its own */ }
const accepts = iphoneAccepts()
const report = { hostVersion: listener.sottoVersion, accepts: accepts.length }
let clientId
/** Removes the throwaway pairing. It runs when the probe ends, fails, or is stopped with Ctrl-C or a signal. */
const unpair = async () => {
  if (!clientId) return
  const id = clientId; clientId = undefined
  const gone = await post(listener.port, '/v1/admin/revoke-client', listener.adminToken, { clientId: id }).catch(error => ({ revoked: false, error: String(error) }))
  report.pairingRemoved = gone.revoked === true
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void unpair().finally(() => process.exit(130)) })
try {
  const { code } = await post(listener.port, '/v1/admin/pairing-code', listener.adminToken)
  const paired = await post(phonePort, '/v1/pair', undefined, { v: 1, code, name: 'Audit probe (temporary)' }).catch(() => post(listener.port, '/v1/pair', undefined, { v: 1, code, name: 'Audit probe (temporary)' }))
  clientId = paired.clientId
  const { session } = await post(phonePort, '/v1/session', paired.token)
  let tally = fresh(), waiting = new Map()
  const peer = await socket(phonePort, session, raw => { const message = tallyMessage(tally, raw); const done = message.id && waiting.get(message.id); if (done) { waiting.delete(message.id); done({ message, bytes: raw.length, deflatedBytes: deflated(raw) }) } })
  const ask = (id, operation) => new Promise((resolve, reject) => { waiting.set(id, resolve); setTimeout(() => reject(new Error(`No answer to ${id}`)), 60_000).unref(); peer.send({ v: 1, id, session, ...operation }) })
  const pings = setInterval(() => peer.ping(), 25_000)

  // Connecting: hello, then observe with no thread open, as the app sends when it opens on Threads.
  const hello = await ask('hello', { op: 'hello', afterSeq: 9_007_199_254_740_991, accepts })
  if (!hello.message.ok) throw new Error('The host refused the hello')
  const shell = hello.message.result?.shell ?? hello.message.result?.state ?? hello.message.result
  const state = shell?.state ?? shell
  const threads = state?.host?.threads ?? []
  const parts = { own: {}, host: {}, watcher: {} }
  addStateParts(state, parts, { own: 'own' })
  const helloParts = { ...parts.own, ...Object.fromEntries(Object.entries(parts.host).map(([key, bytes]) => [`host.${key}`, bytes])), ...Object.fromEntries(Object.entries(parts.watcher).map(([key, bytes]) => [`watcher.${key}`, bytes])) }
  report.hello = { bytes: hello.bytes, deflatedBytes: hello.deflatedBytes, threadsListed: threads.length, settledHeldBack: state?.settledHeldBack ?? null, models: state?.host?.models?.length ?? null, bytesByField: top(helloParts, 14) }
  await ask('observe-none', { op: 'observe', threadIds: [] })
  await wait(2)
  report.connect = summed(tally)

  // On the Threads list.
  tally = fresh()
  await wait(listSeconds)
  report.onThreadsList = { seconds: listSeconds, ...summed(tally) }

  if (open) {
    // A working thread with no unread mark if there is one, else any thread with none.
    const eligible = threads.filter(thread => thread.finishedUnread !== true && thread.kind !== 'watcher')
    const target = eligible.find(thread => thread.status === 'running') ?? eligible[0]
    if (target) {
      tally = fresh()
      const observed = await ask('observe-one', { op: 'observe', threadIds: [target.id] })
      await wait(3)
      const opened = summed(tally)
      report.openThread = { working: target.status === 'running', answerBytes: observed.bytes, ...opened }
      tally = fresh()
      await wait(threadSeconds)
      report.threadOpen = { seconds: threadSeconds, working: target.status === 'running', ...summed(tally) }
      await ask('observe-end', { op: 'observe', threadIds: [] })
    } else report.openThread = { skipped: 'no thread without an unread mark' }
  }
  clearInterval(pings); peer.close()
} finally {
  await unpair()
}
console.log(JSON.stringify(report, null, 1))
