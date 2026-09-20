import { randomUUID } from 'node:crypto'
import { clearInterval } from 'node:timers'
import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Synthetic ACP peer grounded in the native 3000.10.31 experiment. Only fixture data is recorded.
const root = process.argv[2]
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const write = (name, value) => writeFileSync(path(name), JSON.stringify(value))
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify(frame) + '\n')
const violate = reason => appendFileSync(path('violations.jsonl'), JSON.stringify({ reason }) + '\n')
if (process.argv.includes('--version')) { process.stdout.write('devin 3000.10.31 (b98cc431)\n'); process.exit(0) }
if (process.argv.includes('plugins') && process.argv.includes('list')) { process.stdout.write('No plugins installed.\n'); process.exit(0) }
if (process.argv.includes('mcp') && process.argv.includes('list')) {
 process.stdout.write(read('integrations.json', {}).enabledMcp
  ? 'Configured MCP servers:\n\n  \u2022 synthetic\n    Command: synthetic-command\n'
  : "No MCP servers configured. Use 'devin mcp add' to add servers.\n")
 process.exit(0)
}
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const result = (id, value = {}) => { if (id !== undefined) send({ id, result: value }) }
const reject = (id, code = -32602) => send({ id, error: { code, message: 'Synthetic rejection' } })
const sessions = new Set()
const active = new Map()
const pending = new Map()
const handled = new Set()
let serial = 0
const nativePath = id => `native-${id}.json`
const ownerPath = id => `owner-${id}.json`
function owner(id) {
 const pid = read(ownerPath(id), null)
 if (!pid) return null
 try { process.kill(pid, 0); return pid } catch { return null }
}
function acquire(id) {
 if (owner(id) && owner(id) !== process.pid) return false
 if (!sessions.has(id)) record({ method: 'fixture/ownership-started', params: { sessionId: id, pid: process.pid } })
 write(ownerPath(id), process.pid); sessions.add(id); return true
}
function configOptions(session) {
 return [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'accept-edits', options: [{ value: 'accept-edits', name: 'Code' }, { value: 'ask', name: 'Ask' }] },
  { id: 'model', name: 'Model', type: 'select', currentValue: session.model, options: [{ value: 'fixture-model', name: 'Fixture Devin' }] }]
}
function applyScriptedPolicyChange(script, operation) {
 if (script[operation === 'new' ? 'enableMcpAfterNew' : 'enableMcpAfterLoad']) write('integrations.json', { enabledMcp: true })
 if (operation === 'new' && script.changePolicyAfterNew) {
  const configPath = process.argv[process.argv.indexOf('--config') + 1]
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.permissions.ask = []
  writeFileSync(configPath, JSON.stringify(config))
 }
}
function sessionInfo(session) {
 return { modes: { currentModeId: 'accept-edits', availableModes: [{ id: 'accept-edits', name: 'Code' }, { id: 'ask', name: 'Ask' }] }, configOptions: configOptions(session) }
}
function update(sessionId, value) { send({ method: 'session/update', params: { sessionId, update: value } }) }
function saveMessage(sessionId, message) {
 const session = read(nativePath(sessionId), null)
 if (!session) throw new Error('Missing fixture session')
 session.messages.push(message); write(nativePath(sessionId), session)
}
function replay(sessionId) {
 const session = read(nativePath(sessionId), null)
 for (const message of session.messages) {
  if (message.visibleAfter > Date.now()) continue
  update(sessionId, { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text: message.text },
   _meta: { ...(message.role === 'user' ? { 'cognition.ai/clientMessageId': message.id, 'cognition.ai/messageSubIndex': 0 } : {}), 'cognition.ai/timestamp': message.timestamp } })
 }
}
function complete(sessionId, text, stopReason = 'end_turn') {
 if (text) {
  const timestamp = new Date().toISOString()
  saveMessage(sessionId, { role: 'assistant', text, timestamp })
  // Streaming arrives in chunks; replay coalesces them into the saved assistant message.
  const middle = Math.max(1, Math.floor(text.length / 2))
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(0, middle) } })
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: text.slice(middle) } })
 }
 const id = active.get(sessionId)
 if (id !== undefined) { active.delete(sessionId); result(id, { stopReason }) }
 for (const request of pending.values()) if (request.sessionId === sessionId) request.cancelled = true
}
function validateReply(frame) {
 const request = pending.get(frame.id)
 if (!request || handled.has(frame.id)) { violate('Unknown or duplicate response ID'); return }
 if (frame.error?.code === -32602) { handled.add(frame.id); pending.delete(frame.id); return }
 const value = frame.result
 let valid
 if (request.kind === 'permission') {
  const outcome = value?.outcome
  valid = Object.keys(value ?? {}).join() === 'outcome' && (outcome?.outcome === 'cancelled'
   ? Object.keys(outcome).join() === 'outcome'
   : outcome?.outcome === 'selected' && Object.keys(outcome).sort().join() === 'optionId,outcome' && ['allow-once', 'deny-once'].includes(outcome.optionId))
  if (request.cancelled && outcome?.optionId === 'allow-once') valid = false
 } else {
  valid = value?.action === 'decline' && Object.keys(value).join() === 'action'
   || !request.cancelled && value?.action === 'accept' && Object.keys(value).sort().join() === 'action,content'
    && Object.keys(value.content ?? {}).join() === 'answer' && typeof value.content.answer === 'string'
 }
 if (!valid) violate('Invalid native request answer')
 handled.add(frame.id); pending.delete(frame.id)
}
createInterface({ input: process.stdin }).on('line', line => {
 let frame
 try { frame = JSON.parse(line) } catch { violate('Invalid JSON sent to Devin'); return }
 record(frame)
 if (!frame.method) { validateReply(frame); return }
 const p = frame.params ?? {}
 const script = read('script.json', {})
 if (frame.method === 'initialize') {
  if (p.protocolVersion !== 1 || p.clientInfo?.name !== 'sotto' || p.clientCapabilities?.terminal !== false) violate('Untruthful or unsupported ACP initialization')
  result(frame.id, { protocolVersion: script.protocolVersion ?? 1, agentInfo: { name: 'affogato', title: 'Devin Agent', version: '0.0.0-dev' },
   agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { list: {}, delete: {} } },
   authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }] })
 } else if (frame.method === '_cognition.ai/config/read') {
  const configPath = process.argv[process.argv.indexOf('--config') + 1]
  let config = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf8')) } catch { violate('Missing owned config') }
  result(frame.id, { config, configPath })
 } else if (frame.method === 'session/new') {
  if (!p.cwd || !Array.isArray(p.mcpServers) || p.mcpServers.length) violate('Invalid session setup')
  const sessionId = randomUUID(); const session = { cwd: p.cwd, model: 'fixture-model', messages: [] }
  write(nativePath(sessionId), session); acquire(sessionId)
  applyScriptedPolicyChange(script, 'new')
  if (script.delayCreate) setTimeout(() => result(frame.id, { sessionId, ...sessionInfo(session) }), script.delayCreate)
  else result(frame.id, { sessionId, ...sessionInfo(session) })
 } else if (frame.method === 'session/load') {
  const session = read(nativePath(p.sessionId), null)
  if (!session || script.rejectLoad) { reject(frame.id, -32016); return }
  // Native Devin first persists a session when it receives its first prompt.
  if (session.messages.length === 0) { reject(frame.id, -32016); return }
  if (script.rejectLoadAfterPrompt && session.messages.some(message => message.role === 'user')) { reject(frame.id); return }
  applyScriptedPolicyChange(script, 'load')
  replay(p.sessionId)
  if (!acquire(p.sessionId)) reject(frame.id, -32015)
  else result(frame.id, sessionInfo(script.loadModel ? { ...session, model: script.loadModel } : session))
 } else if (frame.method === 'session/set_config_option') {
  const session = read(nativePath(p.sessionId), null)
  if (!session || owner(p.sessionId) !== process.pid || p.configId !== 'model' || p.value !== 'fixture-model') { reject(frame.id); return }
  session.model = p.value; write(nativePath(p.sessionId), session)
  result(frame.id, { configOptions: configOptions(session) })
 } else if (frame.method === 'session/prompt') {
  if (owner(p.sessionId) !== process.pid || active.has(p.sessionId)) { reject(frame.id, -32015); return }
  const id = p._meta?.['cognition.ai/clientMessageId']
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id ?? '') || p.prompt?.length !== 1 || p.prompt[0]?.type !== 'text') { violate('Invalid authored prompt identity or content'); reject(frame.id); return }
  active.set(p.sessionId, frame.id)
  saveMessage(p.sessionId, { role: 'user', id, text: p.prompt[0].text, timestamp: new Date().toISOString(), visibleAfter: Date.now() + (script.delayPrompt ?? 0) })
  if (script.delayPrompt) write('script.json', {})
  // Native Devin does not emit a live user echo; only a later load proves acceptance.
 } else if (frame.method === 'session/cancel') { complete(p.sessionId, '', 'cancelled'); result(frame.id) }
 else if (frame.method === 'session/delete') { result(frame.id); }
 else reject(frame.id, -32601)
}).on('close', () => { clearInterval(control); process.exit(0) })
process.on('exit', () => {
 for (const id of sessions) if (read(ownerPath(id), null) === process.pid) {
  try { unlinkSync(path(ownerPath(id))) } catch { /* Already released. */ }
  record({ method: 'fixture/ownership-stopped', params: { sessionId: id, pid: process.pid } })
 }
})
const seen = new Set()
const control = setInterval(() => {
 for (const sessionId of sessions) {
  const command = read(`control-${sessionId}.json`, null)
  if (!command || seen.has(command.id)) continue
  seen.add(command.id)
  if (command.type === 'malformed') process.stdout.write('{invalid json}\n')
  if (command.type === 'complete') complete(sessionId, command.text, command.reason)
  if (command.type === 'changed-permission') {
   const prior = [...pending].find(([, value]) => value.kind === 'permission' && value.sessionId === sessionId)
   if (prior) {
    const [id] = prior
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: command.text, rawInput: { command: command.text } })
    send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: id }, options: [
     { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny-once', name: 'Deny', kind: 'reject_once' }] } })
   }
  }
  if (command.type === 'permission' || command.type === 'question') {
   const id = `${process.pid}-${++serial}`
   pending.set(id, { kind: command.type, sessionId })
   if (command.type === 'permission') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: id, kind: 'execute', title: command.text, rawInput: { command: command.text } })
    send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: id }, options: [
     { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny-once', name: 'Deny', kind: 'reject_once' }] } })
   } else send({ id, method: 'elicitation/create', params: { sessionId, mode: 'form', message: command.text,
    requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } } })
  }
 }
}, 10)
