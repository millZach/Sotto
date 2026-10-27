// A stand-in for DeepSeek Harness's CLI (`dsh`), shaped on the frames `dsh` 0.2.1-rc.2 sent live (ADR-0138,
// docs/research/2026-10-24-deepseek-harness-acp-probe.md). `node fakeDeepSeekAgent.mjs <root> --version` answers as
// the client does; `node fakeDeepSeekAgent.mjs <root> --profile acp --patch <file>` speaks ACP on stdio as one
// thread's process. Sessions are kept one file each under <root>/sessions, so `session/resume` in a later process
// finds them; a resume replays nothing, as the real one's does not. The model catalog is read from the patch
// overlay Sotto generated, the way the harness reads its routes from it. script.json may name `cliVersion`,
// `dropPromptAck` (lose the next prompt's first sign of work), `rejectResume` and `rejectSettings`.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'

const root = process.argv[2]
const args = process.argv.slice(3)
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const violation = reason => appendFileSync(path('violations.jsonl'), JSON.stringify({ reason }) + '\n')
const startup = read('script.json', {})
const version = startup.cliVersion ?? '0.2.1-rc.2'

if (args.includes('--version')) { process.stdout.write(`${version}\n`); process.exit(0) }

/** The routes the patch overlay declares: each provider key, its display name, and its models with their efforts. */
function patchCatalog() {
  const at = args.indexOf('--patch')
  const text = at >= 0 ? readFileSync(args[at + 1], 'utf8') : ''
  const routes = []
  let route
  for (const line of text.split('\n')) {
    const provider = /^ {6}"([^"]+)":$/u.exec(line)
    if (provider) { route = { id: provider[1], name: provider[1], models: [] }; routes.push(route); continue }
    const display = /^ {8}displayName: "([^"]*)"$/u.exec(line)
    if (display && route) { route.name = display[1]; continue }
    const model = /^ {10}- id: "([^"]*)"$/u.exec(line)
    if (model && route) { route.models.push({ id: model[1], name: model[1], efforts: [] }); continue }
    const named = /^ {12}name: "([^"]*)"$/u.exec(line)
    if (named && route?.models.length) { route.models.at(-1).name = named[1]; continue }
    const effort = /^ {14}(off|low|high|max):/u.exec(line)
    if (effort && route?.models.length) route.models.at(-1).efforts.push(effort[1])
  }
  return routes
}
const ROUTES = patchCatalog()
const routeModel = (routeId, modelId) => ROUTES.find(route => route.id === routeId)?.models.find(model => model.id === modelId)
const firstPair = () => { const route = ROUTES[0]; return route ? JSON.stringify([route.id, route.models[0]?.id ?? '']) : '' }

const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
const ownKeys = Object.keys(process.env).filter(name => name.startsWith('SOTTO_OWN_'))
record({ method: 'fixture/process', params: { pid: process.pid, version, args, cwd: process.cwd(), environment: {
  DSH_HOME: process.env.DSH_HOME, DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ownKeys } } })

mkdirSync(path('sessions'), { recursive: true })
const sessionFile = id => path(`sessions/${id}.json`)
const sessions = new Map()
const resident = new Set()
const loadSession = id => { if (sessions.has(id)) return sessions.get(id); try { const session = JSON.parse(readFileSync(sessionFile(id), 'utf8')); sessions.set(id, session); return session } catch { return undefined } }
const save = id => writeFileSync(sessionFile(id), JSON.stringify(sessions.get(id)))
const pairOf = session => { try { const pair = JSON.parse(session.model); return Array.isArray(pair) ? pair : [] } catch { return [] } }
const configOptions = session => {
  const [routeId, modelId] = pairOf(session)
  const model = routeModel(routeId, modelId)
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: session.model,
      options: ROUTES.map(route => ({ group: route.id, name: route.name, options: route.models.map(entry => ({ value: JSON.stringify([route.id, entry.id]), name: entry.name })) })) },
    ...(model?.efforts.length ? [{ id: 'reasoning_effort', name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: session.effort ?? '',
      options: [{ value: '', name: 'Default' }, ...model.efforts.map(value => ({ value, name: value }))] }] : []),
  ]
}
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } })

const pending = new Map(); let serial = 0
let prompt
function finish(reason) {
  if (!prompt) return
  send({ id: prompt.id, result: { stopReason: reason } })
  prompt = undefined
}
function validate(frame, request) {
  const outcome = frame.result?.outcome
  if (frame.error) return 'A request Sotto reads is answered, not refused'
  if (!outcome || typeof outcome.outcome !== 'string') return 'Expected an outcome'
  if (request.kind === 'permission') {
    if (!['selected', 'cancelled'].includes(outcome.outcome)) return 'Expected selected or cancelled'
    if (outcome.outcome === 'selected' && !['allow-once', 'reject-once'].includes(outcome.optionId)) return `Sotto must answer allow-once or reject-once, not ${outcome.optionId}`
  }
  return undefined
}

createInterface({ input: process.stdin }).on('line', line => {
  check()
  const frame = JSON.parse(line)
  record(frame)
  if (!frame.method) {
    const request = pending.get(frame.id)
    if (!request) { violation('Unknown or repeated response ID'); return }
    pending.delete(frame.id)
    const reason = validate(frame, request)
    if (reason) violation(reason)
    return
  }
  const p = frame.params ?? {}
  const script = read('script.json', {})
  if (frame.method === 'initialize') {
    if (p.clientCapabilities?.fs?.writeTextFile !== false || p.clientCapabilities?.terminal !== false) violation('Sotto offers no file or terminal capability')
    const ready = () => send({ id: frame.id, result: { protocolVersion: script.protocolVersion ?? 1,
      agentCapabilities: { mcpCapabilities: { http: script.httpMcp !== false }, promptCapabilities: { image: script.images === true, audio: false, embeddedContext: false },
        sessionCapabilities: { close: {}, list: {}, resume: {} } },
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' }, authMethods: [] } })
    if (script.startDelayMs) setTimeout(ready, script.startDelayMs); else ready()
  } else if (frame.method === 'session/new') {
    const sessionId = randomUUID()
    sessions.set(sessionId, { cwd: p.cwd, model: firstPair(), effort: '', mcpServers: (p.mcpServers ?? []).map(server => server.name), prompts: [] })
    save(sessionId); resident.add(sessionId)
    record({ method: 'fixture/session-resident', params: { sessionId, resident: true } })
    send({ id: frame.id, result: { sessionId, configOptions: configOptions(sessions.get(sessionId)) } })
  } else if (frame.method === 'session/resume') {
    const session = loadSession(p.sessionId)
    if (!session || script.rejectResume) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    resident.add(p.sessionId); session.mcpServers = (p.mcpServers ?? []).map(server => server.name); save(p.sessionId)
    record({ method: 'fixture/session-resident', params: { sessionId: p.sessionId, resident: true } })
    // A resumed session replays nothing, as the real one's does not.
    send({ id: frame.id, result: { configOptions: configOptions(session) } })
  } else if (frame.method === 'session/close') {
    if (!loadSession(p.sessionId)) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    resident.delete(p.sessionId)
    record({ method: 'fixture/session-resident', params: { sessionId: p.sessionId, resident: false } })
    send({ id: frame.id, result: {} })
  } else if (frame.method === 'session/list') {
    send({ id: frame.id, result: { sessions: [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, cwd: session.cwd })) } })
  } else if (frame.method === 'session/set_config_option') {
    const session = loadSession(p.sessionId)
    if (!session) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    if (script.rejectSettings) { send({ id: frame.id, error: { code: -32602, message: 'Rejected' } }); return }
    if (p.configId === 'model') {
      let pair
      try { pair = JSON.parse(p.value) } catch { pair = undefined }
      if (!Array.isArray(pair) || !routeModel(pair[0], pair[1])) { send({ id: frame.id, error: { code: -32602, message: 'Unknown model' } }); return }
      session.model = p.value; session.effort = ''
    } else if (p.configId === 'reasoning_effort') {
      const [routeId, modelId] = pairOf(session)
      const model = routeModel(routeId, modelId)
      if (p.value !== '' && !model?.efforts.includes(p.value)) { send({ id: frame.id, error: { code: -32602, message: `Invalid params: unknown reasoning effort for ${routeId}/${modelId}: ${p.value}` } }); return }
      session.effort = p.value
    } else { send({ id: frame.id, error: { code: -32602, message: 'Unknown option' } }); return }
    save(p.sessionId)
    send({ id: frame.id, result: { configOptions: configOptions(session) } })
  } else if (frame.method === 'session/prompt') {
    const session = loadSession(p.sessionId)
    if (!session || !resident.has(p.sessionId)) { violation('Prompt for a session this process has not opened'); send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    const text = p.prompt.filter(part => part.type === 'text').map(part => part.text).join('')
    session.prompts.push(text); save(p.sessionId)
    prompt = { id: frame.id, sessionId: p.sessionId }
    // The first committed usage is the first sign the prompt was taken. `dropPromptAck` loses that sign for one
    // prompt: the fake shows nothing of it until a test moves its turn on.
    if (!script.dropPromptAck) update(p.sessionId, { sessionUpdate: 'usage_update', used: 6142, size: 131072 })
    // A drop is spent once, rewritten whole so a process starting meanwhile never reads half a file.
    if (script.dropPromptAck) { const staged = path(`script.json.${process.pid}.tmp`); writeFileSync(staged, JSON.stringify({ ...script, dropPromptAck: undefined })); renameSync(staged, path('script.json')) }
  } else if (frame.method === 'session/cancel') {
    finish('cancelled')
  } else if (frame.id !== undefined) send({ id: frame.id, error: { code: -32601, message: 'Method not found' } })
}).on('close', () => {
  clearInterval(control)
  for (const sessionId of resident) record({ method: 'fixture/session-resident', params: { sessionId, resident: false } })
  process.exit(0)
})

// A test drives a session through control.json; the process holding the session carries the command out once.
let last
function check() {
  if (!existsSync(path('control.json'))) return
  const command = read('control.json', {})
  if (!command.id || command.id === last || !resident.has(command.sessionId)) return
  last = command.id
  try { mkdirSync(path('control-claims'), { recursive: true }); writeFileSync(path(`control-claims/${command.id}`), String(process.pid), { flag: 'wx' }) } catch { return }
  run(command)
}
const control = setInterval(check, 10)
function ask(kind, method, params) {
  const id = `deepseek-${++serial}`
  pending.set(id, { kind })
  send({ id, method, params })
}
function run(command) {
  const sessionId = command.sessionId
  if (command.type === 'complete') {
    if (command.thought) update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: command.thought } })
    // Committed whole, as the harness sends a reply: one message chunk, then its usage.
    if (command.text) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: command.text } })
    update(sessionId, { sessionUpdate: 'usage_update', used: 6200, size: 131072 })
    finish(command.reason ?? 'end_turn')
  }
  if (command.type === 'takeover') update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: command.text } })
  if (command.type === 'tool') {
    const toolCallId = `call_${randomUUID()}`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'bash', kind: 'other', status: 'pending', rawInput: { command: command.command, description: 'Fixture command' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: command.output ?? '' } }] })
  }
  if (command.type === 'permission') {
    // An escalation as the harness sends it: the denied call, its retry naming the boundary it asks to cross, then
    // the request, which carries nothing but the retry's ID and its two one-shot choices.
    const first = `call_${randomUUID()}`, retry = `call_${randomUUID()}`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: first, title: 'bash', kind: 'other', status: 'pending', rawInput: { command: command.text, description: 'Fixture command' } })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: first, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Sandbox denied the write.' } }] })
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: retry, title: 'bash', kind: 'other', status: 'pending',
      rawInput: { command: command.text, description: 'Fixture command', sandbox_permissions: 'workspace-write', justification: 'The fixture asks to cross.' } })
    ask('permission', 'session/request_permission', { sessionId, toolCall: { toolCallId: retry },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
  }
  // No question action: elicitation is outside this surface, and the contract skips its question case here.
}
