import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { URL } from 'node:url'
// A scripted OpenCode 2 server (`opencode serve`), in the shape Sotto's OpenCode adapter speaks: the HTTP routes and the
// server-sent events captured from OpenCode 2.0.31 (.zstack/opencode-provider/v2-captures, not committed). Files in the
// root steer it, as with the other fakes: `script.json` (version, infoVersion, models, providers, delay by operation,
// refuse by operation (the HTTP status the next such request is refused with, once), migrationMs, unavailable,
// printPassword, pageSize, eventStream: 'refuse' to answer the event stream with an error before its first frame;
// integrations, sourceModels, oauth by `<integration>:<method>`, oauthExpiresMs and oauthUrl for the sign-in routes),
// `approve.json` (`{ integrationID }`: the next read of that source's browser sign-in finds it complete),
// `credentials.json` (the sign-ins, shared by every process as OpenCode's database is, secrets included as OpenCode
// answers them), `control.json` (one driver action at a time, taken by the process
// holding its session). Every request is recorded in requests.jsonl under its OpenAPI operation name, with the process
// that took it. Sessions are shared by every process through native-sessions.json under a lock, as OpenCode's database is.
// A process holding a session writes `holders/<sessionId>` with its PID, so a test can see when that server has gone.
// The first process on a data folder with no database "migrates" it, alone: a second that starts meanwhile fails, as
// OpenCode 2 fails a migration race, and records a violation.
const root = process.argv[2]
const args = process.argv.slice(3)
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const script = () => read('script.json', {})
const startup = script()
const VERSION = startup.version ?? '2.0.31'
if (args.includes('--version')) {
  process.stdout.write(Number(VERSION.split('.')[0]) >= 2 ? `opencode v${VERSION}\n` : `${VERSION}\n`)
  process.exit(0)
}
const record = frame => appendFileSync(path('requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
const violation = reason => appendFileSync(path('violations.jsonl'), JSON.stringify({ reason, process: process.pid }) + '\n')
const MODELS = startup.models ?? [
  { id: 'fixture-model', modelID: 'fixture-model', providerID: 'opencode', name: 'Fixture Model', capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    variants: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } },
  { id: 'text-only', modelID: 'text-only', providerID: 'opencode', name: 'Text Only', capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } },
]
const PROVIDERS = startup.providers ?? [{ id: 'opencode', name: 'OpenCode', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible' }]
// The model sources OpenCode 2.0.31 lists, cut to the ones the tests sign in to, in its shape (`Integration.Info`).
const INTEGRATIONS = startup.integrations ?? [
  { id: 'opencode', name: 'OpenCode Console', methods: [{ type: 'key', label: 'API key (service account)' }, { type: 'env', names: ['OPENCODE_API_KEY'] },
    { id: 'device', type: 'oauth', label: 'OpenCode Console account', form: [{ key: 'server', hidden: true, type: 'string', format: 'uri', default: 'https://opencode.ai/console' }] }] },
  { id: 'anthropic', name: 'Anthropic', methods: [{ type: 'key' }, { type: 'env', names: ['ANTHROPIC_API_KEY'] }] },
  { id: 'openai', name: 'OpenAI', methods: [{ type: 'key' }, { type: 'env', names: ['OPENAI_API_KEY'] }, { id: 'chatgpt-token-sharing', type: 'oauth', label: 'Sign in with ChatGPT' },
    { id: 'chatgpt-browser', type: 'oauth', label: 'Codex browser (legacy)' }, { id: 'chatgpt-headless', type: 'oauth', label: 'Codex device code (legacy)' }] },
  { id: 'openrouter', name: 'OpenRouter', methods: [{ type: 'key' }, { type: 'env', names: ['OPENROUTER_API_KEY'] }] },
  { id: 'github-copilot', name: 'GitHub Copilot', methods: [{ type: 'env', names: ['GITHUB_TOKEN'] }, { id: 'device', type: 'oauth', label: 'Login with GitHub Copilot', form: [
    { key: 'deploymentType', title: 'Select GitHub deployment type', required: true, type: 'string', options: [{ value: 'github.com', label: 'GitHub.com', description: 'Public' }, { value: 'enterprise', label: 'GitHub Enterprise', description: 'Data residency or self-hosted' }] },
    { key: 'enterpriseUrl', title: 'Enter your GitHub Enterprise URL or domain', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }], type: 'string', placeholder: 'company.ghe.com or https://company.ghe.com' }] }] },
  { id: 'google', name: 'Google', methods: [{ type: 'key' }, { type: 'env', names: ['GEMINI_API_KEY'] }] },
  { id: 'xai', name: 'xAI', methods: [{ type: 'key', label: 'Manually enter API Key' }, { type: 'env', names: ['XAI_API_KEY'] }, { id: 'device', type: 'oauth', label: 'SuperGrok Subscription' }] },
  { id: 'gitlab', name: 'GitLab Duo', methods: [{ type: 'key' }, { id: 'pkce', type: 'oauth', label: 'Login with GitLab (OAuth)', form: [{ key: 'instanceUrl', title: 'GitLab instance URL', type: 'string', default: 'https://gitlab.com' }] }] },
  { id: 'zenmux', name: 'ZenMux', methods: [{ type: 'key' }] },
]
// The models a signed-in source adds to the catalog, by source.
const SOURCE_MODELS = startup.sourceModels ?? {
  anthropic: [{ id: 'claude-fixture', name: 'Claude Fixture' }, { id: 'claude-fixture-small', name: 'Claude Fixture Small' }],
  openai: [{ id: 'gpt-fixture', name: 'GPT Fixture' }], xai: [{ id: 'grok-fixture', name: 'Grok Fixture' }], gitlab: [{ id: 'duo-fixture', name: 'Duo Fixture' }],
}
const credentials = () => read('credentials.json', [])
const saveCredentials = list => writeFileSync(path('credentials.json'), JSON.stringify(list))
const sourceModels = () => credentials().flatMap(credential => (SOURCE_MODELS[credential.integrationID] ?? []).map(model => ({ ...model, modelID: model.id, providerID: credential.integrationID,
  capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], enabled: true, status: 'active', limit: { context: 200000, output: 32000 } })))
const attempts = new Map()
const PROVIDER_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'META_API_KEY', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_DATA_DIR']
record({ method: 'fixture/process', params: { pid: process.pid, version: VERSION, args, environment: {
  dataHome: process.env.XDG_DATA_HOME ?? null, configHome: process.env.XDG_CONFIG_HOME ?? null, stateHome: process.env.XDG_STATE_HOME ?? null, cacheHome: process.env.XDG_CACHE_HOME ?? null,
  passwordSet: Boolean(process.env.OPENCODE_PASSWORD), configContent: process.env.OPENCODE_CONFIG_CONTENT ?? null, disableAutoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
  leaked: PROVIDER_KEYS.filter(key => process.env[key] !== undefined),
} } })

const pause = new Int32Array(new SharedArrayBuffer(4))
const running = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' } }
function locked(work) {
  const lock = path('native-sessions.lock')
  for (;;) {
    try { const fd = openSync(lock, 'wx'); try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) } break } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
      try {
        const before = statSync(lock, { bigint: true }).ino
        const holder = Number(readFileSync(lock, 'utf8'))
        if (holder && !running(holder) && statSync(lock, { bigint: true }).ino === before) rmSync(lock, { force: true })
      } catch { /* Released meanwhile. */ }
      Atomics.wait(pause, 0, 0, 2)
    }
  }
  try { return work() } finally { rmSync(lock, { force: true }) }
}
const stored = () => read('native-sessions.json', { sessions: {} })
const sessions = {}
const save = () => { if (Object.keys(sessions).length) locked(() => { const all = stored(); Object.assign(all.sessions, sessions); writeFileSync(path('native-sessions.json'), JSON.stringify(all)) }) }
function hold(sessionId) {
  if (!sessions[sessionId]) { const session = locked(stored).sessions[sessionId]; if (!session) return undefined; delete session.executing; sessions[sessionId] = session }
  mkdirSync(path('holders'), { recursive: true }); writeFileSync(join(path('holders'), sessionId), String(process.pid))
  return sessions[sessionId]
}

// The database: a fresh data folder is migrated by the first server alone.
const data = process.env.XDG_DATA_HOME
if (!data) { violation('A server started without Sotto’s own data folder'); process.exit(1) }
const database = join(data, 'opencode', 'opencode.db')
if (!existsSync(database)) {
  mkdirSync(join(data, 'opencode'), { recursive: true })
  let fd
  try { fd = openSync(join(data, 'opencode', 'migrating'), 'wx') } catch {
    violation('Two servers migrated one new database at once')
    process.stderr.write('EffectDrizzleQueryError: table account_state already exists\n')
    process.exit(1)
  }
  closeSync(fd)
  Atomics.wait(pause, 0, 0, startup.migrationMs ?? 300)
  writeFileSync(database, 'fixture database')
  rmSync(join(data, 'opencode', 'migrating'), { force: true })
}

let clock = 0
const now = () => Date.UTC(2026, 9, 16, 12, 0, 0) + clock++ * 1000
const id = prefix => `${prefix}_${(now() * 4096).toString(16).padStart(12, '0').slice(-12)}${randomBytes(7).toString('hex')}`
const clients = new Set()
function emit(type, eventData) {
  const frame = `data: ${JSON.stringify({ id: id('evt'), created: now(), type, data: eventData })}\n\n`
  for (const client of clients) client.write(frame)
}
const info = session => ({ id: session.id, projectID: 'fixture-project', ...(session.model ? { model: session.model } : {}), cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...(session.outcome ? { outcome: session.outcome } : {}),
  time: { created: session.created, updated: session.created }, title: session.title, permissions: session.permissions ?? [], location: session.location,
  ...(session.metadata ? { metadata: session.metadata } : {}) })

/** One execution: Sotto's prompt or one typed elsewhere starts it, `complete` or Stop ends it. */
function enqueue(session, inboxID, text, files, delivery = 'steer') {
  const at = now()
  emit('session.inbox.enqueued', { inboxID, sessionID: session.id, item: { type: 'user', payload: { text, ...(files.length ? { files } : {}) }, delivery } })
  if (!session.executing) { session.executing = true; delete session.outcome; emit('session.execution.started', { sessionID: session.id }) }
  session.messages.push({ id: inboxID, time: { created: at }, text, ...(files.length ? { files } : {}), type: 'user' })
  emit('session.inbox.delivered', { sessionID: session.id, inboxID })
  save()
}
function finish(session, outcome, error) {
  if (!session.executing) return
  session.executing = false; session.outcome = outcome
  for (const permission of session.permissionsPending ?? []) emit('permission.replied', { sessionID: session.id, requestID: permission.id, reply: 'reject' })
  for (const form of session.forms ?? []) emit('form.cancelled', { id: form.id, sessionID: session.id })
  session.permissionsPending = []; session.forms = []
  session.messages.push({ id: id('msg'), time: { created: now() }, type: 'idle', outcome })
  save()
  emit(`session.execution.${outcome}`, { sessionID: session.id, ...(error ? { error } : {}) })
}
function reply(session, text) {
  const assistantMessageID = id('msg'), started = now()
  emit('session.step.started', { sessionID: session.id, agent: 'build', model: session.model, assistantMessageID, started })
  emit('session.text.started', { sessionID: session.id, assistantMessageID, ordinal: 0 })
  const half = Math.ceil(text.length / 2)
  emit('session.text.delta', { sessionID: session.id, assistantMessageID, ordinal: 0, delta: text.slice(0, half) })
  emit('session.text.delta', { sessionID: session.id, assistantMessageID, ordinal: 0, delta: text.slice(half) })
  emit('session.text.ended', { sessionID: session.id, assistantMessageID, ordinal: 0, text })
  const tokens = { input: 10, output: 2, reasoning: 0, cache: { read: 4, write: 0 } }
  emit('session.step.ended', { sessionID: session.id, assistantMessageID, finish: 'stop', cost: 0, tokens, snapshot: 'fixture-snapshot', files: [] })
  emit('session.usage.updated', { sessionID: session.id, cost: 0, tokens })
  session.messages.push({ id: assistantMessageID, time: { created: started, completed: now() }, type: 'assistant', agent: 'build', model: session.model,
    content: [{ type: 'text', text }], snapshot: { start: 'fixture-snapshot', end: 'fixture-snapshot', files: [] }, finish: 'stop', cost: 0, tokens })
  save()
}
function tool(session, action) {
  const assistantMessageID = id('msg'), callId = `call_${randomUUID()}`, started = now()
  emit('session.step.started', { sessionID: session.id, agent: 'build', model: session.model, assistantMessageID, started })
  emit('session.tool.input.started', { sessionID: session.id, assistantMessageID, id: callId, name: action.name })
  emit('session.tool.called', { sessionID: session.id, assistantMessageID, id: callId, input: action.input ?? {}, executed: false })
  const state = action.running ? { status: 'running', input: action.input ?? {}, metadata: {} }
    : { status: 'completed', input: action.input ?? {}, content: [{ type: 'text', text: action.output ?? '' }], metadata: {} }
  if (!action.running) emit('session.tool.success', { sessionID: session.id, assistantMessageID, id: callId, content: state.content, metadata: {}, executed: false })
  // A finished step names the files it changed, relative to the session's folder, live and in history alike (2.0.31).
  const files = action.files ?? []
  if (!action.running) emit('session.step.ended', { sessionID: session.id, assistantMessageID, finish: 'tool-calls', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, snapshot: 'fixture-snapshot', files })
  session.messages.push({ id: assistantMessageID, time: { created: started }, type: 'assistant', agent: 'build', model: session.model,
    content: [{ type: 'tool', id: callId, name: action.name, executed: false, state, time: { created: started } }],
    ...(action.running ? {} : { snapshot: { start: 'fixture-snapshot', end: 'fixture-snapshot', files } }) })
  save()
}

let seen
function check() {
  const action = read('control.json', undefined)
  if (!action || action.id === seen) return
  const session = action.sessionId ? sessions[action.sessionId] : undefined
  if (!session) return
  seen = action.id
  rmSync(path('control.json'), { force: true })
  if (action.type === 'takeover') enqueue(session, id('msg'), action.text, [])
  else if (action.type === 'complete') { reply(session, action.text); finish(session, 'succeeded') }
  else if (action.type === 'reply') reply(session, action.text)
  else if (action.type === 'fail') finish(session, 'failed', { type: action.error ?? 'provider.auth', message: 'Refused' })
  else if (action.type === 'tool') tool(session, action)
  else if (action.type === 'exit') process.exit(0)
  else if (action.type === 'malformed') emit('session.text.delta', { sessionID: session.id, assistantMessageID: 7 })
  else if (action.type === 'child') {
    // A tool's process, as a shell call leaves one running under the server. OpenCode is not Node: nothing ends its tools
    // when it ends, so on Windows this child leaves the job Node puts its children in, and only a tree kill reaches it.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' })
    record({ method: 'fixture/child', params: { sessionId: session.id, pid: child.pid } })
  } else if (action.type === 'permission') {
    const permission = { id: id('per'), sessionID: session.id, action: action.action ?? 'shell', resources: [action.text], save: ['*'],
      metadata: { files: action.files ?? [{ file: 'fixture.txt', patch: 'Index: fixture.txt\n+hi\n', status: 'added', additions: 1, deletions: 0 }] },
      source: { type: 'tool', messageID: id('msg'), id: `call_${randomUUID()}` } }
    session.permissionsPending = [...(session.permissionsPending ?? []), permission]; save()
    // As OpenCode 2.0.31 does (turn2 and turn3 captures): the tool starts and is called, then asks.
    const tool = { sessionID: session.id, assistantMessageID: permission.source.messageID, id: permission.source.id }
    const name = action.tool ?? (permission.action === 'edit' ? 'write' : permission.action), input = action.input ?? { command: action.text }
    emit('session.tool.input.started', { ...tool, name })
    emit('session.tool.called', { ...tool, input })
    // History holds the asking tool as running until the reply settles it, as a provider session's messages do.
    session.messages.push({ id: permission.source.messageID, time: { created: now() }, type: 'assistant', agent: 'build', model: session.model,
      content: [{ type: 'tool', id: permission.source.id, name, executed: false, state: { status: 'running', input, metadata: {} }, time: { created: now() } }] })
    emit('permission.asked', permission)
  } else if (action.type === 'question' || action.type === 'form') {
    const form = { id: id('frm'), sessionID: session.id, title: 'Questions', metadata: { kind: 'question' },
      fields: action.fields ?? [{ key: 'q0', title: 'Fixture', description: action.text, type: 'string', options: [], custom: true }] }
    session.forms = [...(session.forms ?? []), form]; save()
    emit('form.created', { form })
  }
}
setInterval(check, 20)

const delayOf = name => {
  const current = script()
  const ms = current.delay?.[name]
  if (!ms) return 0
  writeFileSync(path('script.json'), JSON.stringify({ ...current, delay: { ...current.delay, [name]: 0 } }))
  return ms
}
/** A refusal the script asks for once: the next request of this operation is refused with that status, before anything is done. */
const refusalOf = name => {
  const current = script()
  const status = current.refuse?.[name]
  if (!status) return 0
  writeFileSync(path('script.json'), JSON.stringify({ ...current, refuse: { ...current.refuse, [name]: 0 } }))
  return status
}
let unavailable = startup.unavailable ?? 0
const routes = [
  ['GET', /^\/api\/info$/u, 'server.info'], ['GET', /^\/api\/model$/u, 'model.list'], ['GET', /^\/api\/model\/default$/u, 'model.default'],
  ['GET', /^\/api\/provider$/u, 'provider.list'], ['GET', /^\/api\/event$/u, 'event.subscribe'], ['POST', /^\/api\/session$/u, 'session.create'],
  ['GET', /^\/api\/session$/u, 'session.list'],
  ['GET', /^\/api\/session\/([^/]+)$/u, 'session.get'], ['PATCH', /^\/api\/session\/([^/]+)$/u, 'session.update'],
  ['GET', /^\/api\/session\/([^/]+)\/message$/u, 'session.messages'], ['POST', /^\/api\/session\/([^/]+)\/prompt$/u, 'session.prompt'],
  ['POST', /^\/api\/session\/([^/]+)\/interrupt$/u, 'session.interrupt'], ['POST', /^\/api\/session\/([^/]+)\/model$/u, 'session.switchModel'],
  ['GET', /^\/api\/session\/([^/]+)\/permission$/u, 'session.permission.list'], ['POST', /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/u, 'session.permission.reply'],
  ['GET', /^\/api\/session\/([^/]+)\/form$/u, 'session.form.list'], ['POST', /^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/u, 'session.form.reply'],
  ['DELETE', /^\/api\/session\/([^/]+)\/form\/([^/]+)$/u, 'session.form.cancel'],
  ['GET', /^\/api\/integration$/u, 'integration.list'], ['POST', /^\/api\/integration\/([^/]+)\/connect\/key$/u, 'integration.connect.key'],
  ['POST', /^\/api\/integration\/([^/]+)\/connect\/external$/u, 'integration.connect.external'],
  ['POST', /^\/api\/integration\/([^/]+)\/connect\/oauth$/u, 'integration.connect.oauth'],
  ['GET', /^\/api\/integration\/([^/]+)\/connect\/oauth\/([^/]+)$/u, 'integration.connect.oauth.status'],
  ['DELETE', /^\/api\/integration\/([^/]+)\/connect\/oauth\/([^/]+)$/u, 'integration.connect.oauth.cancel'],
  ['POST', /^\/api\/integration\/([^/]+)\/connect\/oauth\/([^/]+)\/complete$/u, 'integration.connect.oauth.complete'],
  ['GET', /^\/api\/credential$/u, 'credential.list'], ['DELETE', /^\/api\/credential\/([^/]+)$/u, 'credential.remove'],
]
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? ''}`).toString('base64')}`
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture')
  const send = (status, body) => {
    if (body === undefined) { response.writeHead(status); response.end(); return }
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body))
  }
  const fail = (status, tag) => send(status, { _tag: tag, message: tag })
  if (!process.env.OPENCODE_PASSWORD || request.headers.authorization !== expected) { fail(401, 'UnauthorizedError'); return }
  const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname))
  if (!route) { fail(404, 'NotFoundError'); return }
  const [, pattern, name] = route
  const [, sessionId, itemId] = pattern.exec(url.pathname)
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    const query = Object.fromEntries(url.searchParams)
    record({ method: name, params: { ...(sessionId ? { sessionID: sessionId } : {}), ...(itemId ? { itemID: itemId } : {}), ...(body ?? {}), ...(Object.keys(query).length ? { query } : {}) } })
    const refused = refusalOf(name)
    if (refused) { fail(refused, 'InvalidRequestError'); return }
    const go = () => handle(name, sessionId, itemId, body, query, request, response, send, fail)
    const delay = delayOf(name)
    if (delay) setTimeout(go, delay); else go()
  })
})
function handle(name, sessionId, itemId, body, query, request, response, send, fail) {
  check()
  if (name === 'server.info') { send(200, { version: script().infoVersion ?? VERSION, pid: process.pid, urls: [], paths: {}, capabilities: {} }); return }
  if (name === 'model.list') {
    if (unavailable > 0) { unavailable--; fail(503, 'ServiceUnavailableError'); return }
    send(200, { location: { directory: query['location[directory]'] }, data: [...script().models ?? MODELS, ...sourceModels()] }); return
  }
  if (name === 'model.default') { send(200, { location: { directory: query['location[directory]'] }, data: (script().models ?? MODELS)[0] ?? null }); return }
  if (name === 'provider.list') {
    const signed = [...new Set(credentials().map(credential => credential.integrationID))].map(integrationID => ({ id: integrationID, integrationID,
      name: INTEGRATIONS.find(item => item.id === integrationID)?.name ?? integrationID, activation: 'enabled' }))
    send(200, { location: { directory: query['location[directory]'] }, data: [...script().providers ?? PROVIDERS, ...signed.filter(item => item.id !== 'opencode')] }); return
  }
  if (name.startsWith('integration.') || name.startsWith('credential.')) { integration(name, sessionId, itemId, body, query, send); return }
  if (name === 'event.subscribe') {
    if (script().eventStream === 'refuse') { fail(500, 'InternalServerError'); return }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.connected', data: {} })}\n\n`)
    response.write(': heartbeat\n\n')
    clients.add(response)
    response.on('close', () => clients.delete(response))
    return
  }
  if (name === 'session.list') {
    const all = Object.values({ ...locked(stored).sessions, ...sessions }).filter(session => !query.directory || session.location?.directory === query.directory)
    send(200, { data: all.sort((a, b) => b.created - a.created).map(info), cursor: { previous: null, next: null } }); return
  }
  if (name === 'session.create') {
    // OpenCode Zen's free models refuse a provider session whose ID a client chose (checked against 2.0.31).
    if (body.id) { violation('Sotto chose a provider session ID'); fail(400, 'InvalidRequestError'); return }
    const session = { id: id('ses'), title: body.title, metadata: body.metadata, model: body.model ? { ...body.model, ...(body.model.variant ? {} : { variant: 'default' }) } : undefined,
      location: body.location, permissions: body.permissions ?? [], created: now(), messages: [] }
    sessions[session.id] = session; save(); hold(session.id)
    emit('session.created', { sessionID: session.id, location: session.location, title: session.title, permissions: session.permissions, model: session.model })
    send(200, { data: info(session) }); return
  }
  const session = sessionId ? hold(sessionId) : undefined
  if (!session) { fail(404, 'SessionNotFoundError'); return }
  if (name === 'session.get') { send(200, { data: info(session) }); return }
  if (name === 'session.update') {
    if (body.permissions) { session.permissions = body.permissions; emit('session.permissions', { sessionID: session.id, permissions: body.permissions }) }
    if (body.title) session.title = body.title
    save(); send(204); return
  }
  if (name === 'session.switchModel') { session.model = body.model; save(); emit('session.model.selected', { sessionID: session.id, model: body.model }); send(204); return }
  if (name === 'session.messages') {
    const size = script().pageSize ?? 50
    const start = query.cursor ? Number(Buffer.from(query.cursor, 'base64url').toString()) : 0
    const page = session.messages.slice(start, start + size)
    send(200, { data: page, cursor: { previous: null, next: Buffer.from(String(start + page.length)).toString('base64url') } }); return
  }
  if (name === 'session.prompt') {
    const inboxID = body.id ?? id('msg')
    const files = (body.files ?? []).map(file => { const match = /^data:([^;]+);base64,(.*)$/u.exec(file.uri); return match ? { data: match[2], mime: match[1], source: { type: 'inline' }, ...(file.name ? { name: file.name } : {}) } : { uri: file.uri } })
    if (!session.messages.some(message => message.id === inboxID)) enqueue(session, inboxID, body.text, files, body.delivery ?? 'steer')
    send(200, { data: { id: inboxID, sessionID: session.id, time: { created: now() }, type: 'user', payload: { text: body.text }, delivery: body.delivery ?? 'steer' } }); return
  }
  if (name === 'session.interrupt') {
    if (!session.executing) { send(200, { interrupted: false }); return }
    emit('session.step.failed', { sessionID: session.id, assistantMessageID: id('msg'), error: { type: 'aborted', message: 'Step interrupted' } })
    finish(session, 'interrupted'); send(200, { interrupted: true }); return
  }
  if (name === 'session.permission.list') { send(200, { data: session.permissionsPending ?? [] }); return }
  if (name === 'session.form.list') { send(200, { data: session.forms ?? [] }); return }
  if (name === 'session.permission.reply') {
    if (body.decision === 'always') violation('Sotto sent always')
    const permission = (session.permissionsPending ?? []).find(item => item.id === itemId)
    if (!permission) { fail(404, 'PermissionNotFoundError'); return }
    session.permissionsPending = session.permissionsPending.filter(item => item !== permission); save()
    emit('permission.replied', { sessionID: session.id, requestID: permission.id, reply: body.decision })
    const asked = session.messages.find(message => message.id === permission.source.messageID)?.content?.find(part => part.id === permission.source.id)
    if (asked) asked.state = body.decision === 'reject'
      ? { status: 'error', input: asked.state.input, error: { type: 'permission.rejected', message: body.message ?? 'Rejected' }, metadata: {} }
      : { status: 'completed', input: asked.state.input, content: [{ type: 'text', text: 'Done' }], metadata: {} }
    save()
    if (body.decision === 'once') emit('session.tool.success', { sessionID: session.id, assistantMessageID: permission.source.messageID, id: permission.source.id, content: [{ type: 'text', text: 'Done' }], metadata: { truncated: false }, executed: false })
    if (body.decision === 'reject') emit('session.tool.failed', { sessionID: session.id, assistantMessageID: permission.source.messageID, id: permission.source.id, error: { type: 'permission.rejected', message: body.message ?? 'Rejected' } })
    send(204); return
  }
  if (name === 'session.form.reply' || name === 'session.form.cancel') {
    const form = (session.forms ?? []).find(item => item.id === itemId)
    if (!form) { fail(404, 'FormNotFoundError'); return }
    session.forms = session.forms.filter(item => item !== form); save()
    emit(name === 'session.form.reply' ? 'form.replied' : 'form.cancelled', { id: form.id, sessionID: session.id, ...(body?.answer ? { answer: body.answer } : {}) })
    send(204); return
  }
  fail(404, 'NotFoundError')
}
/** OpenCode 2.0.31's sign-in routes, as the scratch probe of October 16, 2026 found them. */
function integration(name, integrationID, attemptID, body, query, send) {
  const location = { directory: query['location[directory]'] }
  const add = (integrationID, value) => {
    const entry = { id: id('cred'), integrationID, label: INTEGRATIONS.find(item => item.id === integrationID)?.name ?? integrationID, active: true, value }
    saveCredentials([...credentials().filter(item => item.integrationID !== integrationID), entry])
  }
  if (name === 'credential.list') { send(200, { data: credentials() }); return }
  if (name === 'credential.remove') { saveCredentials(credentials().filter(item => item.id !== integrationID)); send(204); return }
  if (name === 'integration.list') {
    const held = credentials()
    send(200, { location, data: INTEGRATIONS.map(item => ({ ...item, connections: held.filter(credential => credential.integrationID === item.id)
      .map(credential => ({ type: 'credential', id: credential.id, label: credential.label, method: credential.value.type })) })) }); return
  }
  const source = INTEGRATIONS.find(item => item.id === integrationID)
  if (!source) { send(404, { _tag: 'IntegrationNotFoundError', integrationID, message: `Integration not found: ${integrationID}` }); return }
  if (name === 'integration.connect.key') {
    // OpenCode keeps any key without trying it; the fixture refuses one that says so, to draw a refused key.
    if (typeof body?.key !== 'string' || body.key.startsWith('refuse')) { send(400, { _tag: 'InvalidRequestError', message: 'Invalid key', kind: 'integration_authorization' }); return }
    add(source.id, { type: 'key', key: body.key, ...(body.answer ? { configuration: body.answer } : {}) }); send(204); return
  }
  if (name === 'integration.connect.external') { add(source.id, { type: 'external', methodID: body.methodID }); send(204); return }
  if (name === 'integration.connect.oauth') {
    const method = source.methods.find(item => item.type === 'oauth' && item.id === body?.methodID)
    if (!method) { send(404, { _tag: 'IntegrationMethodNotFoundError', message: 'Method not found' }); return }
    const missing = (method.form ?? []).find(field => field.required && !field.hidden && !(field.when ?? []).some(rule => body.answer?.[rule.key] !== rule.value) && !body.answer?.[field.key])
    if (missing) { send(400, { _tag: 'InvalidRequestError', message: `Missing required form field: ${missing.key}`, kind: 'integration_authorization' }); return }
    const how = script().oauth?.[`${source.id}:${method.id}`] ?? { mode: 'auto' }
    const created = now(), attempt = { attemptID: id('con'), integrationID: source.id, methodID: method.id, mode: how.mode, time: { created, expires: created + (script().oauthExpiresMs ?? 600_000) } }
    attempts.set(attempt.attemptID, attempt)
    const url = script().oauthUrl ?? `https://sign-in.fixture.invalid/${source.id}/${how.code ? `device?user_code=${how.code}` : 'authorize?state=fixture-state'}`
    const instructions = how.code ? `Open https://sign-in.fixture.invalid/${source.id}/device on any device and enter code: ${how.code}` : 'Complete authorization in your browser. This window will close automatically.'
    send(200, { location, data: { attemptID: attempt.attemptID, url, instructions, mode: how.mode, time: attempt.time } }); return
  }
  const attempt = attempts.get(attemptID)
  if (name === 'integration.connect.oauth.cancel') { attempts.delete(attemptID); send(204); return }
  if (!attempt || attempt.integrationID !== source.id) { send(404, { _tag: 'IntegrationAttemptNotFoundError', integrationID, attemptID, message: `OAuth attempt not found: ${attemptID}` }); return }
  if (name === 'integration.connect.oauth.complete') {
    if (body?.code !== 'good-code') { send(400, { _tag: 'InvalidRequestError', message: 'Invalid code' }); return }
    attempt.status = 'complete'; add(source.id, { type: 'oauth', methodID: attempt.methodID, refresh: 'fixture-refresh-secret', access: 'fixture-access-secret', expires: now() + 3_600_000 })
    send(204); return
  }
  const approved = read('approve.json', null)
  if (!attempt.status && approved?.integrationID === source.id) {
    rmSync(path('approve.json'), { force: true })
    attempt.status = 'complete'; add(source.id, { type: 'oauth', methodID: attempt.methodID, refresh: 'fixture-refresh-secret', access: 'fixture-access-secret', expires: now() + 3_600_000 })
  }
  const status = attempt.status ?? (now() >= attempt.time.expires ? 'expired' : 'pending')
  send(200, { location, data: { status, time: attempt.time } })
}
const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n') }, 15_000)
heartbeat.unref()
const port = Number(/^--port=(\d+)$/u.exec(args.find(arg => arg.startsWith('--port=')) ?? '')?.[1] ?? 0)
process.stderr.write('INFO  fixture diagnostics the adapter never reads\n')
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`server listening on http://127.0.0.1:${server.address().port}\n`)
  // OpenCode prints a password it made up when it is given none; one script asks for the given one to be printed too.
  if (!process.env.OPENCODE_PASSWORD) process.stdout.write(`server password ${randomBytes(12).toString('base64url')}\n`)
  // Evidence for the test that no password reaches a log: the one this process printed, kept where only the test reads it.
  if (startup.printPassword) { process.stdout.write(`server password ${process.env.OPENCODE_PASSWORD}\n`); writeFileSync(path(`password-${process.pid}.txt`), process.env.OPENCODE_PASSWORD ?? '') }
})
process.on('exit', () => { for (const sessionId of Object.keys(sessions)) { try { if (Number(readFileSync(join(path('holders'), sessionId), 'utf8')) === process.pid) rmSync(join(path('holders'), sessionId), { force: true }) } catch { /* Not held here. */ } } })
