import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// Only synthetic fixture input enters this log. The production adapter never logs protocol bodies.
const directory = process.env.SOTTO_FAKE_CODEX_DIR ?? process.argv[2]
const file = name => join(directory, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(file(name), 'utf8')) } catch { return fallback } }
const state = read('state.json', { threads: {} })
const save = () => { writeFileSync(file('state.tmp'), JSON.stringify(state)); renameSync(file('state.tmp'), file('state.json')) }
const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
const notify = (method, params) => emit({ method, params })
const record = message => appendFileSync(file('requests.jsonl'), JSON.stringify(message) + '\n')
let requestId = 10000
const pending = new Map()
function complete(thread, text, status = 'completed') {
  const turn = thread.turns.at(-1)
  if (!turn) return
  const item = { type: 'agentMessage', id: randomUUID(), text }
  turn.items.push(item)
  notify('item/started', { threadId: thread.id, turnId: turn.id, item: { ...item, text: '' } })
  notify('item/agentMessage/delta', { threadId: thread.id, turnId: turn.id, itemId: item.id, delta: text })
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
  turn.status = status
  thread.status = { type: status === 'failed' ? 'systemError' : 'idle' }
  save()
  notify('turn/completed', { threadId: thread.id, turn })
}
function raise(thread, kind, text, method, overrides = {}) {
  const id = ++requestId
  const turnId = thread.turns.at(-1)?.id ?? 'turn'
  const itemId = randomUUID()
  method ??= kind === 'permission' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput'
  const params = { threadId: thread.id, turnId, itemId, startedAtMs: Date.now(),
    ...(kind === 'permission' ? { command: text, reason: text, permissions: { network: { enabled: true } }, cwd: thread.cwd }
      : { isBlocking: true, questions: [{ id: 'choice', header: 'Choice', question: text, options: [{ label: 'Blue', description: 'Blue option' }] }] }) }
  if (method === 'mcpServer/elicitation/request') Object.assign(params, { mode: 'form', serverName: 'fixture', message: text,
    requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['Blue', 'Green'] } }, required: ['choice'] } })
  pending.set(id, thread.id)
  emit({ id, method, params: { ...params, ...overrides } })
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  record(message)
  if (!message.method) {
    const threadId = pending.get(message.id)
    pending.delete(message.id)
    if (threadId) notify('serverRequest/resolved', { threadId, requestId: message.id })
    return
  }
  const { id, method, params = {} } = message
  if (method === 'initialized') return
  const script = read('script.json', {})
  const delay = script.delay?.method === method ? script.delay.ms : 0
  if (delay) { delete script.delay; writeFileSync(file('script.json'), JSON.stringify(script)) }
  const reply = result => setTimeout(() => emit({ id, result }), delay)
  if (script.reject === method) { delete script.reject; writeFileSync(file('script.json'), JSON.stringify(script)); setTimeout(() => emit({ id, error: { code: -32000, message: 'Synthetic rejection' } }), delay); return }
  if (method === 'initialize') reply({ userAgent: 'codex/0.154.0', codexHome: process.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' })
  else if (method === 'model/list') reply({ data: [{ id: 'model', model: 'fixture-model', displayName: 'Fixture Codex', isDefault: true }], nextCursor: null })
  else if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: params.cwd, model: params.model, createdAt: Math.floor(Date.now() / 1000), status: { type: 'idle' }, turns: [] }
    state.threads[thread.id] = thread
    save()
    notify('thread/started', { thread })
    reply({ thread, model: params.model, cwd: params.cwd, approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } })
  } else if (method === 'thread/resume' || method === 'thread/read') {
    const thread = state.threads[params.threadId]
    if (thread) reply({ thread, model: thread.model })
    else emit({ id, error: { code: -32000, message: 'Unknown thread' } })
  } else if (method === 'turn/start') {
    const thread = state.threads[params.threadId]
    const item = { type: 'userMessage', id: randomUUID(), clientId: params.clientUserMessageId, content: params.input }
    const turn = { id: randomUUID(), status: 'inProgress', items: [item], startedAt: Math.floor(Date.now() / 1000) }
    thread.turns.push(turn)
    thread.status = { type: 'active', activeFlags: [] }
    save()
    if (!script.suppressNotifications) {
      notify('turn/started', { threadId: thread.id, turn: { ...turn, items: [] } })
      notify('item/started', { threadId: thread.id, turnId: turn.id, item })
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
    }
    reply({ turn })
    if (script.question) raise(thread, 'question', script.question)
    if (script.permission) raise(thread, 'permission', script.permission)
    if (script.reply || script.fail) complete(thread, script.reply ?? 'Failed', script.fail ? 'failed' : 'completed')
  } else if (method === 'turn/interrupt') {
    const thread = state.threads[params.threadId]
    const turn = thread.turns.find(turn => turn.id === params.turnId)
    if (turn) { turn.status = 'interrupted'; thread.status = { type: 'idle' }; save(); notify('turn/completed', { threadId: thread.id, turn }) }
    reply({})
  } else emit({ id, error: { code: -32601, message: 'Unknown method' } })
})
setInterval(() => {
  if (!existsSync(file('control.json'))) return
  const action = read('control.json', null)
  if (!action || action.id === state.lastControl) return
  state.lastControl = action.id
  save()
  const thread = state.threads[action.threadId]
  if (action.type === 'exit') process.exit(0)
  if (!thread) return
  if (action.type === 'complete') complete(thread, action.text, action.status)
  else if (action.type === 'notify') notify(action.method, { threadId: thread.id, ...action.params })
  else raise(thread, action.type, action.text, action.method, action.params)
}, 10)
