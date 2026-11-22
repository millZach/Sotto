// A stand-in for Google Antigravity's `agy`, shaped on what `agy acp` 1.5.12 answered live on forge (initialize, auth
// methods, `Authentication required`) and on T3 Code's recorded Antigravity frames: config options for the model (in
// groups), a `thinking_level` option per Gemini model, a `mode` option with default, accept-edits, auto and plan,
// `session/resume` that replays nothing, permissions as allow_once / allow_always / reject_once, and questions as
// permission requests whose tool call ID starts `interaction_`. Its `ask_question` asks as 1.5.14 does: an
// `elicitation/create` form to a client offering `elicitation.form`, and the question as reply text otherwise.
//
// `node fakeAntigravityAgent.mjs <root> --version` answers as `agy` does; `node fakeAntigravityAgent.mjs <root> acp ...`
// speaks ACP on stdio as one thread's process. Sessions are kept one file each under <root>/sessions. script.json may
// name `cliVersion`, `signedOut`, `dropPromptAck`, `rejectResume`, `rejectSettings`, `noAuto`, `sideAnswer` and `newModels`, the
// models a newer `agy` lists besides these.
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
const version = startup.cliVersion ?? '1.5.13'

if (args.includes('--version')) { process.stdout.write(`${version}\n`); process.exit(0) }

const MODELS = [
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', thinking: ['low', 'medium', 'high'] },
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon', thinking: ['low', 'high'] },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
]
const models = () => [...MODELS, ...(read('script.json', {}).newModels ?? [])]
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
const appData = args[args.indexOf('--app-data-dir') + 1]
record({ method: 'fixture/process', params: { pid: process.pid, version, args, cwd: process.cwd(), environment: {
  GEMINI_HOME: process.env.GEMINI_HOME, AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE, AGY_CLI_DISABLE_AUTO_UPDATE: process.env.AGY_CLI_DISABLE_AUTO_UPDATE,
  SSH_CONNECTION: process.env.SSH_CONNECTION, BROWSER: process.env.BROWSER, hasGeminiKey: process.env.GEMINI_API_KEY !== undefined, hasGoogleKey: process.env.GOOGLE_API_KEY !== undefined,
  hasCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS !== undefined } } })
// `agy` refuses an absolute app data folder.
if (appData && /^([a-z]:)?[\\/]/iu.test(appData)) { process.stdout.write('{"jsonrpc":"2.0","error":{"code":-32603,"message":"must not be absolute"},"id":0}\n') }

mkdirSync(path('sessions'), { recursive: true })
const sessionFile = id => path(`sessions/${id}.json`)
const sessions = new Map()
const resident = new Set()
const loadSession = id => { if (sessions.has(id)) return sessions.get(id); try { const session = JSON.parse(readFileSync(sessionFile(id), 'utf8')); sessions.set(id, session); return session } catch { return undefined } }
const save = id => writeFileSync(sessionFile(id), JSON.stringify(sessions.get(id)))
const modes = () => ['default', 'accept-edits', ...(read('script.json', {}).noAuto ? [] : ['auto']), 'plan']
const configOptions = session => {
  const model = models().find(entry => entry.value === session.model)
  return [
    { id: 'model', name: 'Model', type: 'select', currentValue: session.model,
      options: [{ group: 'gemini', name: 'Gemini', options: models().filter(entry => entry.value.startsWith('gemini')).map(({ value, name }) => ({ value, name })) },
        { group: 'partners', name: 'Partner models', options: models().filter(entry => !entry.value.startsWith('gemini')).map(({ value, name }) => ({ value, name })) }] },
    ...(model?.thinking ? [{ id: 'thinking_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: session.thinking ?? model.thinking.at(-1),
      options: model.thinking.map(value => ({ value, name: value })) }] : []),
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: session.mode ?? 'default', options: modes().map(value => ({ value, name: value })) },
  ]
}
/** The commands agy lists, `/compact` among them as on 1.5.13; a script can name a client without it. */
const commands = script => [{ name: 'plan', description: 'Plan before acting' }, ...(script.noCompact ? [] : [{ name: 'compact', description: 'Compact the conversation' }])]
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } })

const pending = new Map(); let serial = 0
let authenticated = false, forms = false
const prompts = []
function finish(reason, usage) {
  const prompt = prompts.pop()
  // A steer folds into the turn: every earlier prompt of it ends with the newest one.
  for (const earlier of prompts.splice(0)) send({ id: earlier.id, result: { stopReason: 'end_turn' } })
  // agy 1.5.13 answers each prompt with its tokens, inputTokens leaving out what it read from its cache.
  if (prompt) send({ id: prompt.id, result: { stopReason: reason, ...(usage ? { usage } : {}) } })
}
function validate(frame, request) {
  if (request.fields) {
    if (frame.error) return 'A form Sotto reads is answered, not refused'
    const { action, content } = frame.result ?? {}
    if (!['accept', 'decline', 'cancel'].includes(action)) return 'Expected accept, decline or cancel'
    if (action !== 'accept') return content === undefined ? undefined : 'Only an accepted form has content'
    if (!content || typeof content !== 'object' || Object.keys(content).some(key => !request.fields.includes(key))) return 'Expected the form’s own fields'
    return undefined
  }
  const outcome = frame.result?.outcome
  if (frame.error) return 'A request Sotto reads is answered, not refused'
  if (!outcome || typeof outcome.outcome !== 'string') return 'Expected an outcome'
  if (!['selected', 'cancelled'].includes(outcome.outcome)) return 'Expected selected or cancelled'
  if (outcome.outcome === 'selected' && !request.options.includes(outcome.optionId)) return `Unknown option ${outcome.optionId}`
  if (outcome.outcome === 'selected' && outcome.optionId === 'remember-this') return 'Sotto must never answer allow_always'
  return undefined
}

createInterface({ input: process.stdin }).on('line', line => {
  check()
  if (!line.trim()) return
  const frame = JSON.parse(line)
  // A side call's prompt is kept in oneshot.jsonl, apart from the threads' traffic, as a side call never touches a thread.
  const sideSession = frame.method === 'session/prompt' ? loadSession(frame.params?.sessionId) : undefined
  const side = sideSession !== undefined && sideSession.mcpServers.length === 0 && sideSession.prompts.length === 0 && read('script.json', {}).sideAnswer
    && /Name this/u.test(JSON.stringify(frame.params?.prompt ?? []))
  record(side ? { ...frame, params: { sessionId: frame.params.sessionId, prompt: '[side call]' } } : frame)
  if (!frame.method) {
    const request = pending.get(frame.id)
    if (!request) { violation('Unknown or repeated response ID'); return }
    pending.delete(frame.id)
    const reason = request.refusable && frame.error ? undefined : validate(frame, request)
    if (reason) violation(reason)
    if (request.fields && frame.error) { update(request.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: request.text } }); finish('end_turn') }
    return
  }
  const p = frame.params ?? {}
  const script = read('script.json', {})
  const needsAuth = () => { if (authenticated) return false; send({ id: frame.id, error: { code: -32000, message: 'Authentication required' } }); return true }
  if (frame.method === 'initialize') {
    if (p.clientCapabilities?.fs?.writeTextFile !== false || p.clientCapabilities?.terminal !== false) violation('Sotto offers no file or terminal capability')
    forms = p.clientCapabilities?.elicitation?.form !== undefined
    const ready = () => send({ id: frame.id, result: { protocolVersion: script.protocolVersion ?? 1,
      agentCapabilities: { loadSession: true, ...(script.httpMcp === false ? { mcpCapabilities: { http: false } } : {}), promptCapabilities: { image: script.images === true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} }, auth: { logout: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: script.noAppend !== true } } } },
      agentInfo: { name: 'Antigravity ACP Server', version },
      authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
        { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'agent-platform', name: 'Gemini Enterprise Agent Platform' }] } })
    if (script.startDelayMs) setTimeout(ready, script.startDelayMs); else ready()
  } else if (frame.method === 'authenticate') {
    if (script.signedOut || !['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'].includes(p.methodId)) { send({ id: frame.id, error: { code: -32000, message: 'Authentication required' } }); return }
    if (p.methodId === 'gemini-api-key' && !process.env.GEMINI_API_KEY) { send({ id: frame.id, error: { code: -32000, message: 'Authentication required' } }); return }
    authenticated = true
    send({ id: frame.id, result: {} })
  } else if (frame.method === 'logout') {
    authenticated = false
    send({ id: frame.id, result: {} })
  } else if (frame.method === 'session/new') {
    if (needsAuth()) return
    const sessionId = randomUUID()
    sessions.set(sessionId, { cwd: p.cwd, model: 'gemini-3.8-flash', mode: 'default', mcpServers: (p.mcpServers ?? []).map(server => server.name),
      systemAppend: p._meta?.antigravity?.systemPrompt?.append ?? null, prompts: [] })
    save(sessionId); resident.add(sessionId)
    record({ method: 'fixture/session-resident', params: { sessionId, resident: true } })
    send({ id: frame.id, result: { sessionId, configOptions: configOptions(sessions.get(sessionId)) } })
    update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: commands(script) })
  } else if (frame.method === 'session/resume') {
    if (needsAuth()) return
    const session = loadSession(p.sessionId)
    if (!session || script.rejectResume) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    resident.add(p.sessionId); session.mcpServers = (p.mcpServers ?? []).map(server => server.name)
    if (p._meta?.antigravity?.systemPrompt?.append !== undefined) session.systemAppend = p._meta.antigravity.systemPrompt.append
    save(p.sessionId)
    record({ method: 'fixture/session-resident', params: { sessionId: p.sessionId, resident: true } })
    // A resumed session replays nothing, but agy 1.5.13 lists its commands again.
    send({ id: frame.id, result: { configOptions: configOptions(session) } })
    update(p.sessionId, { sessionUpdate: 'available_commands_update', availableCommands: commands(script) })
  } else if (frame.method === 'session/set_config_option') {
    const session = loadSession(p.sessionId)
    if (!session) { send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    if (script.rejectSettings) { send({ id: frame.id, error: { code: -32602, message: 'Rejected' } }); return }
    if (p.configId === 'model') {
      if (!models().some(entry => entry.value === p.value)) { send({ id: frame.id, error: { code: -32602, message: 'Unknown model' } }); return }
      session.model = p.value; delete session.thinking
    } else if (p.configId === 'thinking_level') {
      const model = models().find(entry => entry.value === session.model)
      if (!model?.thinking?.includes(p.value)) { send({ id: frame.id, error: { code: -32602, message: 'Unknown thinking level' } }); return }
      session.thinking = p.value
    } else if (p.configId === 'mode') {
      // `agy` refuses the edit-only and run-everything names T3 maps away from.
      if (!modes().includes(p.value)) { send({ id: frame.id, error: { code: -32602, message: 'Unknown mode' } }); return }
      session.mode = p.value
    } else { send({ id: frame.id, error: { code: -32602, message: 'Unknown option' } }); return }
    save(p.sessionId)
    send({ id: frame.id, result: { configOptions: configOptions(session) } })
  } else if (frame.method === 'session/prompt') {
    const session = loadSession(p.sessionId)
    if (!session || !resident.has(p.sessionId)) { violation('Prompt for a session this process has not opened'); send({ id: frame.id, error: { code: -32602, message: 'Session not found' } }); return }
    const text = p.prompt.filter(part => part.type === 'text').map(part => part.text).join('')
    session.prompts.push(text); save(p.sessionId)
    // A side call: a session with no tool servers, answered at once with the scripted words, logged apart.
    if (script.sideAnswer && session.mcpServers.length === 0 && session.prompts.length === 1 && /Side-writing|Name this/u.test(text)) {
      appendFileSync(path('oneshot.jsonl'), JSON.stringify({ cwd: session.cwd, model: session.model, thinking: session.thinking, mode: session.mode, material: text }) + '\n')
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: script.sideAnswer } })
      send({ id: frame.id, result: { stopReason: 'end_turn' } })
      return
    }
    prompts.push({ id: frame.id, sessionId: p.sessionId })
    if (!script.dropPromptAck) update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the request.' } })
    if (script.dropPromptAck) { const staged = path(`script.json.${process.pid}.tmp`); writeFileSync(staged, JSON.stringify({ ...script, dropPromptAck: undefined })); renameSync(staged, path('script.json')) }
  } else if (frame.method === 'session/cancel') {
    finish('cancelled')
  } else if (frame.id !== undefined) send({ id: frame.id, error: { code: -32601, message: 'Method not found' } })
}).on('close', () => {
  clearInterval(control)
  for (const sessionId of resident) record({ method: 'fixture/session-resident', params: { sessionId, resident: false } })
  process.exit(0)
})

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
function ask(sessionId, toolCall, options) {
  const id = `antigravity-${++serial}`
  pending.set(id, { options: options.map(option => option.optionId) })
  send({ id, method: 'session/request_permission', params: { sessionId, toolCall, options } })
}
function run(command) {
  const sessionId = command.sessionId
  if (command.type === 'complete') {
    if (command.text) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: command.text } })
    // agy 1.5.13 says how full the context is before it answers the prompt.
    if (command.fullness) update(sessionId, { sessionUpdate: 'usage_update', ...command.fullness })
    finish(command.reason ?? 'end_turn', command.usage)
  }
  if (command.type === 'takeover') update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: command.text } })
  if (command.type === 'tool') {
    const toolCallId = `toolu_${randomUUID()}`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Running run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: command.command, Cwd: command.cwd ?? '.' } })
    const picture = command.image ? [{ type: 'content', content: { type: 'image', data: command.image, mimeType: command.mimeType ?? 'image/png' } }] : []
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { combinedOutput: command.output ?? '', exitCode: 0 }, content: picture })
  }
  if (command.type === 'edit') {
    // As agy 1.5.14 edits: no content while it runs, then the whole file before and after once it is done, under a path
    // that starts with a slash on Windows too.
    const toolCallId = `call_${randomUUID().slice(0, 8)}`
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name: 'edit_file', kind: 'edit', title: `File ${command.path}`, status: 'in_progress', locations: [{ path: command.path }] })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, name: 'edit_file', kind: 'edit', title: `File ${command.path}`, status: 'completed', locations: [{ path: command.path }],
      rawOutput: {}, content: [{ type: 'diff', path: command.path, newText: command.newText, oldText: command.oldText }] })
  }
  if (command.type === 'permission' || command.type === 'edit-permission') {
    const edit = command.type === 'edit-permission'
    const toolCallId = `toolu_${randomUUID()}`
    const toolCall = edit
      ? { toolCallId, title: 'Edit notes.md', kind: 'edit', status: 'pending', locations: [{ path: 'notes.md' }], content: [{ type: 'diff', path: 'notes.md', oldText: 'a', newText: 'b' }] }
      : { toolCallId, title: `\`${command.text}\``, kind: 'execute', status: 'pending', rawInput: { CommandLine: command.text } }
    update(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    ask(sessionId, toolCall, [{ optionId: 'remember-this', name: 'Allow always', kind: 'allow_always', _meta: { 'agy.security.warning': { message: 'Runs this command from now on.' } } },
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' }])
  }
  if (command.type === 'ask-question') {
    // `questions`: [{ question, options, several }]; `form` replaces the form's fields, to send one of another shape.
    const toolCallId = `call_${randomUUID().slice(0, 8)}`, rawInput = { questions: command.questions.map(item => ({ question: item.question, options: item.options, is_multi_select: item.several === true })) }
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId, name: 'ask_question', kind: 'other', title: 'Run ask_question', status: 'in_progress', rawInput })
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, name: 'ask_question', kind: 'other', title: 'Run ask_question', status: 'pending', rawInput })
    if (!forms) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: command.questions.map(item => item.question).join('\n') } }); finish('end_turn'); return }
    const properties = command.form ?? Object.fromEntries(command.questions.flatMap((item, index) => {
      const choices = item.options.map((title, at) => ({ const: String(at + 1), title }))
      return [[`q${index + 1}`, item.several ? { type: 'array', title: item.question, items: { anyOf: choices } } : { type: 'string', title: item.question, oneOf: choices }],
        [`q${index + 1}_other`, { type: 'string', title: 'Other', description: `Optional free-form answer to: ${item.question}` }]]
    }))
    const id = `antigravity-${++serial}`
    pending.set(id, { fields: Object.keys(properties), refusable: command.form !== undefined, sessionId, text: command.questions.map(item => item.question).join('\n') })
    send({ id, method: 'elicitation/create', params: { sessionId, toolCallId, mode: 'form', message: command.questions.length === 1 ? 'The agent has a question.' : `The agent has ${command.questions.length} questions.`,
      requestedSchema: { type: 'object', properties, ...(command.required ? { required: command.required } : {}) } } })
  }
  if (command.type === 'mcp-permission') {
    ask(sessionId, { toolCallId: randomUUID(), kind: 'other', title: `Run ${command.tool}`, status: 'pending' },
      [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }])
  }
  if (command.type === 'question') {
    ask(sessionId, { toolCallId: `interaction_${randomUUID().slice(0, 8)}`, title: command.text, kind: 'other', status: 'pending' },
      [{ optionId: 'Blue', name: 'Blue', kind: 'allow_once' }, { optionId: 'Red', name: 'Red', kind: 'allow_once' }])
  }
}
