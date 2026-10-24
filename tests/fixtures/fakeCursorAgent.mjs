// A stand-in for Cursor's CLI (`agent`), shaped on the frames Cursor 2026.10.22-27dcf5f sent live (ADR-0127,
// docs/research/cursor-cli.md Appendix B). `node fakeCursorAgent.mjs <root> [flags] acp` speaks ACP on stdio as one
// thread's process; `--version`, `status --format json`, `login`, `logout` and `update` answer as Cursor's do.
// Sessions are kept one file each under <root>/sessions, so `session/load` in a later process replays them.
// script.json may name `models` (Cursor's own list shape) and `commands` (the skills a session lists), and `httpMcp: false`
// says the client takes no HTTP MCP servers. The `mcp-call` action calls one tool on one of a session's servers over HTTP,
// as Cursor's model would, and records `fixture/mcp-call` with what the server answered.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearInterval, setInterval } from 'node:timers'

const root = process.argv[2]
const args = process.argv.slice(3)
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const violation = reason => appendFileSync(path('violations.jsonl'), JSON.stringify({ reason }) + '\n')
const startup = read('script.json', {})
const version = startup.cliVersion ?? '2026.10.22-27dcf5f'

if (args.includes('--version')) { process.stdout.write(`${version}\n`); process.exit(0) }
if (args[0] === 'status') {
  appendFileSync(path('commands.jsonl'), JSON.stringify({ command: 'status', env: { CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR } }) + '\n')
  const signedOut = startup.signedOut === true || existsSync(path('signed-out'))
  process.stdout.write(JSON.stringify({ status: signedOut ? 'unauthenticated' : 'authenticated', isAuthenticated: !signedOut, userInfo: { email: 'fixture@example.com' } }, null, 2) + '\n')
  process.exit(0)
}
if (args[0] === 'logout') { writeFileSync(path('signed-out'), ''); appendFileSync(path('commands.jsonl'), JSON.stringify({ command: 'logout' }) + '\n'); process.exit(0) }
if (args[0] === 'update') { appendFileSync(path('commands.jsonl'), JSON.stringify({ command: 'update', env: { CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR } }) + '\n'); process.exit(0) }
if (args[0] === 'login') {
  appendFileSync(path('commands.jsonl'), JSON.stringify({ command: 'login', env: { NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER, CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR } }) + '\n')
  const login = read('login.json', {})
  if (login.fail) { process.stderr.write('Login failed\n'); process.exit(1) }
  process.stdout.write('\nCursor Agent\n\nPress any key to sign in...\n')
  process.stdout.write(`Open this link to sign in: ${login.page ?? 'https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login'}\n`)
  // Signed in once the test says so, the way Cursor's login finishes once the user signs in on the page.
  const timer = setInterval(() => { if (existsSync(path('login-done'))) { clearInterval(timer); rmSync(path('signed-out'), { force: true }); process.exit(0) } }, 20)
  process.stdin.resume()
  await new Promise(() => {})
}

const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
record({ method: 'fixture/process', params: { pid: process.pid, version, args, cwd: process.cwd(), environment: {
  CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, NO_OPEN_BROWSER: process.env.NO_OPEN_BROWSER, CURSOR_INVOKED_AS: process.env.CURSOR_INVOKED_AS,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY, CURSOR_AUTH_TOKEN: process.env.CURSOR_AUTH_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY } } })

const effort = (id, current, values) => ({ id, name: 'Reasoning', category: 'thought_level', type: 'select', currentValue: current, options: values.map(value => ({ value, name: value })) })
const CATALOG = startup.models ?? [
  { value: 'default', name: 'Auto', configOptions: [] },
  { value: 'gpt-fixture', name: 'GPT Fixture', configOptions: [effort('reasoning', 'medium', ['none', 'low', 'medium', 'high']),
    { id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] }] },
  { value: 'claude-fixture', name: 'Claude Fixture', configOptions: [{ id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] },
    effort('effort', 'high', ['low', 'medium', 'high', 'max'])] },
]
const modelOf = id => CATALOG.find(model => model.value === id)
const effortOf = model => model?.configOptions.find(option => option.category === 'thought_level' && option.id !== 'thinking')

mkdirSync(path('sessions'), { recursive: true })
const sessionFile = id => path(`sessions/${id}.json`)
const sessions = new Map()
const resident = new Set()
const loadSession = id => { if (sessions.has(id)) return sessions.get(id); try { const session = JSON.parse(readFileSync(sessionFile(id), 'utf8')); sessions.set(id, session); return session } catch { return undefined } }
const save = id => writeFileSync(sessionFile(id), JSON.stringify(sessions.get(id)))
const configOptions = session => {
  const model = modelOf(session.model), option = effortOf(model)
  return [{ id: 'mode', category: 'mode', type: 'select', currentValue: session.mode, options: ['agent', 'plan', 'ask'].map(value => ({ value, name: value })) },
    { id: 'model', category: 'model', type: 'select', currentValue: session.model, options: CATALOG.map(entry => ({ value: entry.value, name: entry.name })) },
    ...(option ? [{ ...option, currentValue: session.effort ?? option.currentValue }] : [])]
}
const answer = session => ({ modes: { currentModeId: session.mode, availableModes: [] }, models: { currentModelId: session.model, availableModels: CATALOG.map(entry => ({ modelId: entry.value, name: entry.name })) }, configOptions: configOptions(session) })
const update = (sessionId, body, keep = true) => {
  const session = sessions.get(sessionId)
  if (keep && session) { session.history.push(body); save(sessionId) }
  send({ method: 'session/update', params: { sessionId, update: body } })
}
const commands = sessionId => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: read('script.json', {}).commands ?? [
  { name: 'review', description: 'Review the change (global)' }, { name: 'fixture-skill', description: 'A project skill' }] } } })
/** The servers each session was given on this process, by name, for the model's tool calls. */
const sessionServers = new Map()
const keepServers = (sessionId, servers) => sessionServers.set(sessionId, new Map((servers ?? []).map(server => [server.name, server])))

const pending = new Map(); let serial = 0
let prompt
function finish(reason) {
  if (!prompt) return
  send({ id: prompt.id, result: { stopReason: reason } })
  prompt = undefined
}
function validate(frame, request) {
  const outcome = frame.result?.outcome
  if (request.kind === 'ack') return frame.error ? 'Extension notifications are answered, not refused' : undefined
  if (frame.error) return 'A request Sotto reads is answered, not refused'
  if (!outcome || typeof outcome.outcome !== 'string') return 'Expected an outcome'
  if (request.kind === 'permission') {
    if (!['selected', 'cancelled'].includes(outcome.outcome)) return 'Expected selected or cancelled'
    if (outcome.outcome === 'selected' && !['allow-once', 'reject-once'].includes(outcome.optionId)) return `Sotto must answer allow-once or reject-once, not ${outcome.optionId}`
  }
  if (request.kind === 'question' && !['answered', 'skipped', 'cancelled'].includes(outcome.outcome)) return 'Expected answered, skipped or cancelled'
  if (request.kind === 'question' && outcome.outcome === 'answered' && !(Array.isArray(outcome.answers) && outcome.answers.every(entry => entry.questionId === 'color' && Array.isArray(entry.selectedOptionIds)))) return 'Expected answers by question ID'
  if (request.kind === 'plan' && !['accepted', 'rejected', 'cancelled'].includes(outcome.outcome)) return 'Expected accepted, rejected or cancelled'
  return undefined
}

createInterface({ input: process.stdin }).on('line', line => {
  check()
  const frame = JSON.parse(line)
  const p = frame.params ?? {}
  const side = frame.method === 'session/prompt' && sessions.get(p.sessionId)?.mode === 'ask'
  if (side) {
    // Sotto's side writing (ADR-0026): its prompt is recorded apart, never with the threads' traffic.
    const session = sessions.get(p.sessionId)
    appendFileSync(path('oneshot.jsonl'), JSON.stringify({ cwd: session.cwd, model: session.model, effort: session.effort, mode: session.mode, material: p.prompt.map(part => part.text ?? '').join('') }) + '\n')
    const script = read('oneshot.json', {})
    if (script.fail) { send({ id: frame.id, error: { code: -32603, message: 'Scripted failure' } }); return }
    update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.text ?? 'Fixture title' } })
    send({ id: frame.id, result: { stopReason: 'end_turn' } })
    return
  }
  record(frame)
  if (!frame.method) {
    const request = pending.get(frame.id)
    if (!request) { violation('Unknown or repeated response ID'); return }
    pending.delete(frame.id)
    const reason = validate(frame, request)
    if (reason) violation(reason)
    return
  }
  const script = read('script.json', {})
  if (frame.method === 'initialize') {
    if (p.clientCapabilities?._meta?.parameterizedModelPicker !== true) violation('Sotto must ask for the parameterized model picker')
    if (p.clientCapabilities?.fs?.writeTextFile !== false || p.clientCapabilities?.terminal !== false) violation('Sotto offers no file or terminal capability')
    // `startDelayMs` holds the answer as a slow start would, the way Cursor's own 256 MB bundle can on a busy machine.
    const ready = () => send({ id: frame.id, result: { protocolVersion: script.protocolVersion ?? 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: script.httpMcp !== false, sse: true },
      promptCapabilities: { audio: false, embeddedContext: false, image: true }, sessionCapabilities: { list: {} } },
      authMethods: [{ id: 'cursor_login', name: 'Cursor Login', description: 'Run agent login first.' }] } })
    if (script.startDelayMs) setTimeout(ready, script.startDelayMs); else ready()
  } else if (frame.method === 'cursor/list_available_models') {
    send({ id: frame.id, result: { models: script.signedOutModels ? [] : CATALOG } })
  } else if (frame.method === 'session/new') {
    const sessionId = randomUUID()
    sessions.set(sessionId, { cwd: p.cwd, model: 'default', effort: undefined, mode: 'agent', history: [], mcpServers: (p.mcpServers ?? []).map(server => server.name) })
    save(sessionId); resident.add(sessionId); keepServers(sessionId, p.mcpServers)
    record({ method: 'fixture/session-resident', params: { sessionId, resident: true } })
    send({ id: frame.id, result: { sessionId, ...answer(sessions.get(sessionId)) } })
    commands(sessionId)
  } else if (frame.method === 'session/load') {
    const session = loadSession(p.sessionId)
    if (!session || script.rejectLoad) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    resident.add(p.sessionId); session.mcpServers = (p.mcpServers ?? []).map(server => server.name); keepServers(p.sessionId, p.mcpServers)
    record({ method: 'fixture/session-resident', params: { sessionId: p.sessionId, resident: true } })
    // The whole conversation again, one message per frame, as Cursor's own load does.
    for (const body of session.history) send({ method: 'session/update', params: { sessionId: p.sessionId, update: body } })
    send({ id: frame.id, result: answer(session) })
    commands(p.sessionId)
  } else if (frame.method === 'session/set_config_option') {
    const session = loadSession(p.sessionId)
    if (!session) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    if (script.rejectSettings) { send({ id: frame.id, error: { code: -32602, message: 'Rejected' } }); return }
    if (p.configId === 'model') {
      if (!modelOf(p.value)) { send({ id: frame.id, error: { code: -32602, message: 'Unknown model' } }); return }
      session.model = p.value; session.effort = undefined
    } else if (p.configId === 'mode') {
      session.mode = p.value
      send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: p.value } } })
    } else {
      const option = effortOf(modelOf(session.model))
      if (!option || option.id !== p.configId || !option.options.some(entry => entry.value === p.value)) { send({ id: frame.id, error: { code: -32602, message: 'Unknown option' } }); return }
      session.effort = p.value
    }
    save(p.sessionId)
    send({ id: frame.id, result: { configOptions: configOptions(session) } })
  } else if (frame.method === 'session/prompt') {
    const session = loadSession(p.sessionId)
    if (!session || !resident.has(p.sessionId)) { violation('Prompt for a session this process has not opened'); send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    const text = p.prompt.filter(part => part.type === 'text').map(part => part.text).join('')
    session.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }); save(p.sessionId)
    prompt = { id: frame.id, sessionId: p.sessionId }
    // Cursor names a session on its first prompt; it is also the first sign the prompt was taken.
    const taken = () => send({ method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'session_info_update', title: 'Fixture title' } } })
    if (script.delayPrompt) setTimeout(taken, script.delayPrompt); else taken()
    // A delay is spent once. The script is rewritten only then, and moved into place whole, so a process starting
    // meanwhile, or the fixture merging a script of its own, never reads half a file and takes it for none.
    if (script.delayPrompt) { const staged = path(`script.json.${process.pid}.tmp`); writeFileSync(staged, JSON.stringify({ ...script, delayPrompt: undefined })); renameSync(staged, path('script.json')) }
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
  const id = `cursor-${++serial}`
  pending.set(id, { kind })
  send({ id, method, params })
}
function run(command) {
  const sessionId = command.sessionId
  if (command.type === 'complete') {
    const text = command.text ?? ''
    if (command.thought) update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: command.thought } })
    if (text) {
      // Streamed in two pieces, kept as one whole message, as Cursor's replay has it.
      const middle = Math.ceil(text.length / 2)
      for (const piece of [text.slice(0, middle), text.slice(middle)]) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } }, false)
      sessions.get(sessionId).history.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }); save(sessionId)
    }
    finish(command.reason ?? 'end_turn')
  }
  if (command.type === 'takeover') update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: command.text } })
  if (command.type === 'tool') {
    const toolCallId = `call_${randomUUID()}\nfc_fixture`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: `\`${command.command}\``, kind: 'execute', status: 'pending', rawInput: { command: command.command } }, false)
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { exitCode: 0, stdout: command.output ?? '', stderr: '' } }, false)
    const turn = sessions.get(sessionId).history.filter(body => body.sessionUpdate === 'user_message_chunk').length - 1
    const step = sessions.get(sessionId).history.length
    sessions.get(sessionId).history.push({ sessionUpdate: 'tool_call', toolCallId: `replay-${turn}-${step}`, title: `\`${command.command}\``, kind: 'execute', status: 'pending', rawInput: { command: command.command } },
      { sessionUpdate: 'tool_call_update', toolCallId: `replay-${turn}-${step}`, status: 'completed', rawOutput: { exitCode: 0, stdout: command.output ?? '', stderr: '' } })
    save(sessionId)
  }
  if (command.type === 'permission') ask('permission', 'session/request_permission', { sessionId, toolCall: { toolCallId: `call_${serial}`, title: command.text, kind: 'execute', status: 'pending',
    content: [{ type: 'content', content: { type: 'text', text: `Not in allowlist: ${command.text}` } }] },
    options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] })
  if (command.type === 'question') ask('question', 'cursor/ask_question', { toolCallId: `call_q${serial}`, title: command.text,
    questions: [{ id: 'color', prompt: command.text, options: [{ id: 'Blue', label: 'Blue' }, { id: 'Red', label: 'Red' }], allowMultiple: false }] })
  if (command.type === 'plan') ask('plan', 'cursor/create_plan', { toolCallId: `call_p${serial}`, name: 'fixture-plan', overview: command.text, plan: '1. First\n2. Second', todos: [{ id: 'a', content: 'First', status: 'pending' }] })
  if (command.type === 'todos') ask('ack', 'cursor/update_todos', { toolCallId: `call_t${serial}`, todos: command.todos, merge: false })
  if (command.type === 'mcp-call') void callTool(sessionId, command)
  if (command.type === 'task') ask('ack', 'cursor/task', { toolCallId: command.toolCallId ?? `call_task`, description: command.text, prompt: command.text, subagentType: 'explore', ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }) })
}

/** One tool call as Cursor's model makes it, on the session's server of that name, over streamable HTTP with its headers. */
async function callTool(sessionId, command) {
  const server = sessionServers.get(sessionId)?.get(command.server)
  if (!server) { record({ method: 'fixture/mcp-call', params: { sessionId, server: command.server, tool: command.tool, callId: command.callId, missing: true } }); return }
  const headers = Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value]))
  try {
    const response = await globalThis.fetch(server.url, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: command.tool, arguments: command.arguments ?? {} } }) })
    const reply = await response.json()
    record({ method: 'fixture/mcp-call', params: { sessionId, server: command.server, tool: command.tool, callId: command.callId, status: response.status, result: reply.result?.structuredContent ?? null } })
  } catch (error) {
    record({ method: 'fixture/mcp-call', params: { sessionId, server: command.server, tool: command.tool, callId: command.callId, failed: String(error?.name ?? 'Error') } })
  }
}
