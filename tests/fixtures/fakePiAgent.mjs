import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { setInterval, clearInterval } from 'node:timers'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const root = process.argv[2]
const args = process.argv.slice(3)
const scriptPath = join(root, 'script.json')
const script = () => { try { return JSON.parse(readFileSync(scriptPath, 'utf8')) } catch { return {} } }
if (args.includes('--version')) { process.stdout.write((script().cliVersion ?? '1.5.2') + '\n'); process.exit(0) }
const arg = name => args[args.indexOf(name) + 1]
const sessionId = args.includes('--session') ? arg('--session') : randomUUID()
const sessionDir = arg('--session-dir')
mkdirSync(sessionDir, { recursive: true })
const sessionFile = join(sessionDir, sessionId + '.json')
const saved = () => { try { return JSON.parse(readFileSync(sessionFile, 'utf8')) } catch { return { messages: [] } } }
let messages = saved().messages
let modelId = arg('--model'), thinkingLevel = 'medium', running = false
const pendingStats = []
const record = data => appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ ...data, process: process.pid }) + '\n')
const send = data => process.stdout.write(JSON.stringify(data) + '\n')
const state = () => { const cut = modelId.indexOf('/'); return { sessionId, model: { provider: modelId.slice(0, cut), id: modelId.slice(cut + 1) }, thinkingLevel, isStreaming: running, messageCount: messages.length } }
const save = () => writeFileSync(sessionFile, JSON.stringify({ messages }))
record({ method: 'fixture/process', params: { args, environment: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE, PI_TELEMETRY: process.env.PI_TELEMETRY, OPENAI_API_KEY: process.env.OPENAI_API_KEY } } })
record({ method: 'fixture/session-resident', params: { sessionId, resident: true } })
if (args.includes('--session')) record({ method: 'resume', params: { sessionId } })
function finish(text, aborted = false) {
  if (!aborted) {
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text.slice(0, 3) } })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text.slice(3) } })
    const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 100, output: 20, cacheRead: 5 } }
    messages.push(message); send({ type: 'message_end', message })
  }
  running = false; save()
  send({ type: 'agent_end', willRetry: false }); send({ type: 'agent_settled', aborted })
}
function command(frame) {
  record({ id: frame.id, method: frame.type, params: frame })
  const reply = data => send({ id: frame.id, type: 'response', command: frame.type, success: true, ...(data === undefined ? {} : { data }) })
  switch (frame.type) {
    case 'get_state': reply(state()); break
    case 'get_session_stats': { const answer = () => reply({ tokens: { input: 100, output: 20 }, contextUsage: { tokens: 6200, contextWindow: 131072 } }); if (script().holdStats) pendingStats.push(answer); else answer(); break }
    case 'set_model': modelId = frame.provider + '/' + frame.modelId; reply(state().model); break
    case 'set_thinking_level': thinkingLevel = frame.level; reply({ level: thinkingLevel }); break
    case 'set_auto_compaction': case 'set_auto_retry': case 'clear_queue': reply(); break
    case 'prompt': {
      if (script().rejectPrompt) { send({ id: frame.id, type: 'response', command: frame.type, success: false, error: 'private rejected content' }); break }
      running = true; messages.push({ role: 'user', content: [{ type: 'text', text: frame.message }] }); save()
      if (script().dropPromptAck) { writeFileSync(scriptPath, JSON.stringify({ ...script(), dropPromptAck: false })); break }
      reply({ disposition: 'started' }); send({ type: 'agent_start' }); send({ type: 'message_end', message: messages.at(-1) }); break
    }
    case 'abort': finish('', true); reply(); break
    default: send({ id: frame.id, type: 'response', command: frame.type, success: false, error: 'unsupported' })
  }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); command(JSON.parse(line)) } })
const timer = setInterval(() => {
  const path = join(root, 'control.json')
  if (!existsSync(path)) return
  let action
  try { action = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
  if (action.sessionId !== sessionId) return
  unlinkSync(path)
  if (action.type === 'release-stats') for (const answer of pendingStats.splice(0)) answer()
  if (action.type === 'complete') finish(action.text)
  if (action.type === 'takeover') { const message = { role: 'user', content: action.text }; messages.push(message); save(); send({ type: 'message_end', message }) }
  if (action.type === 'event') send(action.event)
}, 10)
process.stdin.on('end', () => { clearInterval(timer); record({ method: 'fixture/session-resident', params: { sessionId, resident: false } }); process.exit(0) })
