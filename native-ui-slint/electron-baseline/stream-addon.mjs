// Loaded with `node --import` into the repo's fake Claude CLI (tests/fixtures/fakeClaudeThread.mjs), unchanged. It adds
// one action: when `stream-<session>.json` appears in the fixture root, it streams reply.md the way Claude Code's
// stream-json does, 20 characters every 16 ms from a drift-corrected clock. Text goes out as text deltas inside one
// API message per run of text; each ```activity fence becomes a real tool call (title line -> tool_use, the rest -> its
// tool_result), so Sotto draws activity rows. Full frames are also appended to the session log, as the CLI does.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [, , root, ...args] = process.argv
const value = flag => args[args.indexOf(flag) + 1]
const session = args.includes('--no-session-persistence') ? null : value(args.includes('--resume') ? '--resume' : '--session-id')
const now = () => performance.timeOrigin + performance.now()

/** Text runs and activity fences, with the character offsets at which each tool event becomes known. */
function plan(reply) {
  const events = [] // { at, kind: 'tool-start' | 'tool-end', ... }
  const regions = [] // [start, end) of activity fences, which never stream as text
  const fence = /```activity\n([^\n]*)\n([\s\S]*?)```\n?/gu
  let match
  while ((match = fence.exec(reply))) {
    const start = match.index
    const titleEnd = start + '```activity\n'.length + match[1].length + 1
    const end = start + match[0].length
    regions.push([start, end])
    const id = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`
    events.push({ at: titleEnd, kind: 'tool-start', id, title: match[1] }, { at: end, kind: 'tool-end', id, title: match[1], output: match[2].replace(/\n$/u, '') })
  }
  return { regions, events }
}

/** A Claude Code tool call for an activity title: Ran -> Bash, Read -> Read, Searched -> Grep, Edited -> Edit. */
function tool(title) {
  let m
  if ((m = /^Ran (.*)$/u.exec(title))) return { name: 'Bash', input: { command: m[1] } }
  if ((m = /^Read (.*)$/u.exec(title))) return { name: 'Read', input: { file_path: m[1] } }
  if ((m = /^Searched for "(.*)" in (.*)$/u.exec(title))) return { name: 'Grep', input: { pattern: m[1], path: m[2] } }
  if ((m = /^Edited (.*)$/u.exec(title))) return { name: 'Edit', input: { file_path: m[1], old_string: '', new_string: '' } }
  return { name: 'Bash', input: { command: title } }
}

async function stream(control) {
  const reply = readFileSync(control.reply, 'utf8')
  const chunk = control.chunk ?? 20
  const interval = control.intervalMs ?? 16
  const { regions, events } = plan(reply)
  const folder = join(join(root, 'home'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/gu, '-'))
  const log = join(folder, `${session}.jsonl`)
  let parentUuid = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).findLast(f => f.uuid)?.uuid ?? null : null
  const persist = frame => {
    const stamped = { ...frame, timestamp: new Date().toISOString() }
    mkdirSync(folder, { recursive: true })
    appendFileSync(log, JSON.stringify({ ...stamped, parentUuid, isSidechain: false, cwd: process.cwd(), sessionId: session }) + '\n')
    parentUuid = frame.uuid ?? parentUuid
    return stamped
  }
  const out = frames => process.stdout.write(frames.map(f => JSON.stringify(f) + '\n').join(''))
  let message = null // { id, text }
  let lastText = ''
  const closeText = frames => {
    if (!message) return
    if (message.text) {
      frames.push(persist({ type: 'assistant', uuid: randomUUID(), session_id: session, message: { id: message.id, role: 'assistant', content: [{ type: 'text', text: message.text }] } }))
      lastText = message.text
    }
    message = null
  }
  const inRegion = offset => regions.some(([a, b]) => offset >= a && offset < b)
  const ticks = Math.ceil(reply.length / chunk)
  const lateness = []
  const t0 = performance.now()
  let started = 0
  for (let i = 0; i < ticks; i++) {
    const target = t0 + i * interval
    const wait = target - performance.now()
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    lateness.push(performance.now() - target)
    const from = i * chunk
    const to = Math.min(reply.length, from + chunk)
    const frames = []
    // Walk the chunk's characters in order, splitting at fence boundaries and tool events.
    let text = ''
    const flushDelta = () => {
      if (!text) return
      if (!message) {
        message = { id: `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`, text: '' }
        frames.push({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id: message.id, role: 'assistant' } } })
      }
      message.text += text
      frames.push({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
      text = ''
    }
    for (let offset = from; offset < to; offset++) {
      if (!inRegion(offset)) text += reply[offset]
      else if (text) flushDelta()
      for (const event of events.filter(e => e.at === offset + 1)) {
        flushDelta()
        if (event.kind === 'tool-start') {
          closeText(frames)
          const { name, input } = tool(event.title)
          const id = `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}`
          frames.push({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } })
          frames.push({ type: 'stream_event', session_id: session, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: event.id, name, input: {} } } })
          frames.push(persist({ type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [{ type: 'tool_use', id: event.id, name, input }] } }))
        } else {
          frames.push(persist({ type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: event.id, content: event.output }] },
            tool_use_result: { stdout: event.output, stderr: '', interrupted: false } }))
        }
      }
    }
    flushDelta()
    if (i === ticks - 1) {
      closeText(frames)
      frames.push({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: lastText })
    }
    out(frames)
    if (i === 0) { started = now(); writeFileSync(join(control.outDir, 'stream-started'), String(started)) }
  }
  const ended = now()
  lateness.sort((a, b) => a - b)
  writeFileSync(join(control.outDir, 'stream-times.json'), JSON.stringify({ startEpochMs: started, endEpochMs: ended, ticks, chunk, intervalMs: interval,
    characters: reply.length, tickLatenessMs: { median: lateness[Math.floor(lateness.length / 2)], p99: lateness[Math.floor(lateness.length * 0.99)], max: lateness.at(-1) } }))
}

if (session && root) {
  const path = join(root, `stream-${session}.json`)
  const timer = setInterval(() => {
    if (!existsSync(path)) return
    let control
    try { control = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
    unlinkSync(path)
    clearInterval(timer)
    void stream(control)
  }, 10)
  timer.unref()
}
