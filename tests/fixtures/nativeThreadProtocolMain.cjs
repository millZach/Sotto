// Observational launcher only: forwards installed Codex bytes unchanged.
/* global require, process, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app } = require('electron')
const { appendFileSync, realpathSync } = require('node:fs')
const { basename, dirname, isAbsolute, join, relative, sep } = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const childProcess = require('node:child_process')

if (app.isPackaged || process.env.SOTTO_NATIVE_PHASE2_LIVE !== '1') throw new Error('Explicit Phase 2 opt-in required.')
const root = realpathSync(process.env.SOTTO_NATIVE_THREADS_ROOT || '')
if (dirname(root) !== realpathSync(tmpdir()) || !/^sotto-e2e-native-[A-Za-z0-9_-]+$/.test(basename(root))) throw new Error('Unsafe native evidence root.')
for (const child of ['profile', 'project']) {
  if (realpathSync(join(root, child)) !== join(root, child)) throw new Error('Synthetic directories must not be redirected.')
}
const destination = join(root, 'wire.jsonl')
const hash = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined
const localPath = value => {
  if (typeof value !== 'string') return undefined
  const path = relative(root, value)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) ? path.split(sep).join('/') : '<outside-owned-root>'
}
const watched = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'skills/list'])
const record = value => appendFileSync(destination, `${JSON.stringify({ at: Date.now(), ...value })}\n`)
const spawn = childProcess.spawn
childProcess.spawn = function (...args) {
  const child = spawn.apply(this, args)
  if (!Array.isArray(args[1]) || !args[1].includes('app-server')) return child
  record({ direction: 'connection' })
  const pending = new Map()
  const buffers = { request: '', response: '' }
  const observe = (direction, chunk) => {
    buffers[direction] += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    let newline
    while ((newline = buffers[direction].indexOf('\n')) >= 0) {
      const line = buffers[direction].slice(0, newline)
      buffers[direction] = buffers[direction].slice(newline + 1)
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      const params = frame.params || {}
      if (direction === 'request' && watched.has(frame.method)) {
        pending.set(frame.id, frame.method)
        record({ direction, method: frame.method, thread: hash(params.threadId), expectedTurn: hash(params.expectedTurnId),
          cwd: localPath(params.cwd), cwds: params.cwds?.map(localPath), model: params.model,
          inputs: params.input?.map(item => item.type === 'skill'
            ? { type: item.type, name: item.name.startsWith('sotto-native-') ? item.name : '<redacted>', path: localPath(item.path) }
            : { type: item.type }) })
      } else if (direction === 'response' && pending.has(frame.id)) {
        const method = pending.get(frame.id); pending.delete(frame.id)
        record({ direction, method, accepted: frame.error === undefined,
          errorCode: frame.error?.code, thread: hash(frame.result?.thread?.id),
          turn: hash(frame.result?.turn?.id || frame.result?.turnId), status: frame.result?.turn?.status })
      } else if (direction === 'response' && ['turn/started', 'turn/completed', 'thread/status/changed'].includes(frame.method)) {
        record({ direction: 'notification', method: frame.method, thread: hash(params.threadId), turn: hash(params.turn?.id), status: params.turn?.status || params.status?.type })
      }
    }
  }
  const write = child.stdin.write
  child.stdin.write = function (chunk, ...rest) { observe('request', chunk); return write.call(this, chunk, ...rest) }
  child.stdout.on('data', chunk => observe('response', chunk))
  return child
}
require('./nativeThreadsMain.cjs')
