import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
// Hand-written shapes from Codex 0.154.0's generated response schemas.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const string = value => typeof value === 'string'
const strings = value => Array.isArray(value) && value.every(string)
const variant = (value, key, check) => object(value) && Object.keys(value).length === 1 && object(value[key]) && check(value[key])
const networkAmendment = value => object(value.network_policy_amendment) && ['allow', 'deny'].includes(value.network_policy_amendment.action) && string(value.network_policy_amendment.host)
const commandDecision = value => ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)
  || variant(value, 'acceptWithExecpolicyAmendment', amendment => strings(amendment.execpolicy_amendment))
  || variant(value, 'applyNetworkPolicyAmendment', networkAmendment)
const legacyApproval = value => ['approved', 'approved_for_session', 'approved_mcp_policy_amendment', 'timed_out', 'abort'].includes(value.decision)
  || variant(value.decision, 'approved_execpolicy_amendment', amendment => strings(amendment.proposed_execpolicy_amendment))
  || variant(value.decision, 'network_policy_amendment', networkAmendment)
  || variant(value.decision, 'denied', denied => string(denied.rejection))
const responseChecks = {
  'item/commandExecution/requestApproval': value => commandDecision(value.decision),
  'item/fileChange/requestApproval': value => ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value.decision),
  'item/permissions/requestApproval': value => object(value.permissions)
    && (value.permissions.fileSystem == null || object(value.permissions.fileSystem))
    && (value.permissions.network == null || object(value.permissions.network) && (value.permissions.network.enabled == null || typeof value.permissions.network.enabled === 'boolean'))
    && (value.scope === undefined || ['turn', 'session'].includes(value.scope))
    && (value.strictAutoReview == null || typeof value.strictAutoReview === 'boolean'),
  'item/tool/requestUserInput': value => object(value.answers) && Object.values(value.answers).every(answer => object(answer) && strings(answer.answers)),
  'mcpServer/elicitation/request': value => ['accept', 'decline', 'cancel'].includes(value.action),
  'item/tool/call': value => typeof value.success === 'boolean' && Array.isArray(value.contentItems) && value.contentItems.every(item => object(item)
    && (item.type === 'inputText' && string(item.text) || item.type === 'inputImage' && string(item.imageUrl) || item.type === 'inputAudio' && string(item.audioUrl))),
  'account/chatgptAuthTokens/refresh': value => string(value.accessToken) && string(value.chatgptAccountId) && (value.chatgptPlanType == null || string(value.chatgptPlanType)),
  'attestation/generate': value => string(value.token),
  'currentTime/read': value => Number.isInteger(value.currentTimeAt),
  applyPatchApproval: legacyApproval,
  execCommandApproval: legacyApproval,
}

// Only synthetic fixture input enters this log. The production adapter never logs protocol bodies.
const directory = process.env.SOTTO_FAKE_CODEX_DIR ?? process.argv[2]
const file = name => join(directory, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(file(name), 'utf8')) } catch { return fallback } }
// Sotto's side writing (ADR-0026): `codex exec --ephemeral`, prompt on stdin, JSONL events out. It records
// what it was given in oneshot.jsonl, never in requests.jsonl or state.json, and answers from oneshot.json.
if (process.argv.includes('exec')) {
  const args = process.argv.slice(process.argv.indexOf('exec') + 1)
  const input = await new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk }); process.stdin.on('end', () => resolve(text)) })
  const script = read('oneshot.json', {})
  appendFileSync(file('oneshot.jsonl'), JSON.stringify({ args, cwd: process.cwd(), input }) + '\n')
  const flag = name => args[args.indexOf(name) + 1]
  const isolated = ['features.shell_tool=false', 'orchestrator.skills.enabled=false', 'orchestrator.mcp.enabled=false', 'mcp_servers={}'].every(value => args.includes(value))
  if (!args.includes('--ephemeral') || flag('--sandbox') !== 'read-only' || !isolated || args.at(-1) !== '-') {
    appendFileSync(file('violations.jsonl'), JSON.stringify({ method: 'exec', reason: 'Side writing must be ephemeral, read-only, tool-free and read its prompt from stdin' }) + '\n')
  }
  const line = event => process.stdout.write(JSON.stringify(event) + '\n')
  line({ type: 'thread.started', thread_id: randomUUID() })
  // Codex says its own warnings as `error` items before the turn; they are not tools and stop nothing.
  line({ type: 'item.completed', item: { id: 'item_w', type: 'error', message: 'Model metadata for `fixture-model` not found.' } })
  line({ type: 'turn.started' })
  if (script.tool) line({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls' } })
  if (script.fail) { line({ type: 'turn.failed', error: { message: 'Scripted failure' } }); process.exit(1) }
  line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: script.text ?? 'Fixture title' } })
  line({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })
  process.exit(0)
}
const state = read('state.json', { threads: {} })
const loadedThreads = new Set()
const save = () => { writeFileSync(file('state.tmp'), JSON.stringify(state)); renameSync(file('state.tmp'), file('state.json')) }
const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
const notify = (method, params) => emit({ method, params })
const record = message => appendFileSync(file('requests.jsonl'), JSON.stringify(message) + '\n')
let requestId = 10000
const pending = new Map()
const heldReplies = new Map()
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
  pending.set(id, { threadId: thread.id, method })
  emit({ id, method, params: { ...params, ...overrides } })
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  record(message)
  if (!message.method) {
    const request = pending.get(message.id)
    if (request) {
      const valid = message.error !== undefined
        ? message.result === undefined && object(message.error) && Number.isInteger(message.error.code) && string(message.error.message)
        : object(message.result) && responseChecks[request.method]?.(message.result)
      if (!valid) appendFileSync(file('violations.jsonl'), JSON.stringify({ method: request.method, id: message.id, reason: 'Response does not match the generated schema shape.' }) + '\n')
    }
    pending.delete(message.id)
    if (request) notify('serverRequest/resolved', { threadId: request.threadId, requestId: message.id })
    return
  }
  const { id, method, params = {} } = message
  if (method === 'initialized') return
  const script = read('script.json', {})
  const delay = script.delay?.method === method ? script.delay.ms : 0
  if (delay) { delete script.delay; writeFileSync(file('script.json'), JSON.stringify(script)) }
  const holdReply = script.holdReply === method
  if (holdReply) { delete script.holdReply; writeFileSync(file('script.json'), JSON.stringify(script)) }
  const reply = result => {
    if (holdReply) heldReplies.set(method, { id, result })
    else setTimeout(() => emit({ id, result }), delay)
  }
  if (script.skillsChanged && method === 'skills/list') notify('skills/changed', {})
  if (method === 'skills/list' && script.skillsMalformed) { reply({ data: null }); return }
  if (script.reject === method) { delete script.reject; writeFileSync(file('script.json'), JSON.stringify(script)); setTimeout(() => emit({ id, error: script.rejection ?? { code: -32000, message: 'Synthetic rejection' } }), delay); return }
  if (method === 'skills/list') { reply({ data: params.cwds.map(cwd => ({ cwd, skills: script.skills ?? [], errors: script.skillErrors ?? [] })) }); return }
  if (method === 'initialize') reply({ userAgent: 'codex/0.154.0', codexHome: process.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' })
  else if (method === 'model/list') reply(script.modelPages?.[params.cursor ?? 'first'] ?? { data: script.models ?? [{ id: 'model', model: 'fixture-model', displayName: 'Fixture Codex', isDefault: true,
    defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null })
  else if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: params.cwd, model: params.model, createdAt: Math.floor(Date.now() / 1000), status: { type: 'idle' }, turns: [],
      approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: params.sandbox, reasoningEffort: params.config?.model_reasoning_effort ?? 'low' }
    state.threads[thread.id] = thread
    loadedThreads.add(thread.id)
    save()
    notify('thread/started', { thread })
    reply({ thread, model: params.model, cwd: params.cwd, approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
      reasoningEffort: thread.reasoningEffort, sandbox: { type: thread.sandbox === 'read-only' ? 'readOnly' : thread.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' } })
  } else if (method === 'thread/resume' || method === 'thread/read') {
    const thread = state.threads[params.threadId]
    if (thread) {
      // typeInProvider also materializes a thread through the fixture's native session log.
      const hasNativeLog = existsSync(join(process.env.CODEX_HOME, 'sessions', '2026', '09', '10', `rollout-2026-09-10-${thread.id}.jsonl`))
      if (method === 'thread/read' && params.includeTurns && thread.turns.length === 0 && !hasNativeLog) {
        setTimeout(() => emit({ id, error: { code: -32600, message: `thread ${thread.id} is not materialized yet; includeTurns is unavailable before first user message` } }), delay)
        return
      }
      // Native resume returns an already loaded session without applying overrides.
      if (method === 'thread/resume' && !loadedThreads.has(thread.id)) {
        for (const key of ['model', 'approvalPolicy', 'approvalsReviewer', 'sandbox']) if (params[key] !== undefined) thread[key] = params[key]
        if (params.config && 'model_reasoning_effort' in params.config) thread.reasoningEffort = params.config.model_reasoning_effort ?? 'low'
        loadedThreads.add(thread.id)
        save()
      }
      const history = JSON.parse(JSON.stringify(thread))
      if (method === 'thread/resume' && params.excludeTurns) history.turns = []
      if (script.historyItemIds) for (const turn of history.turns) {
        turn.items = turn.items.map((item, index) => ['userMessage', 'agentMessage'].includes(item.type)
          ? { ...item, id: `item-${index}` } : item)
      }
      reply({ thread: history, model: thread.model, approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
        reasoningEffort: thread.reasoningEffort, sandbox: { type: thread.sandbox === 'read-only' ? 'readOnly' : thread.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' } })
    }
    else emit({ id, error: { code: -32000, message: 'Unknown thread' } })
  } else if (method === 'thread/settings/update') {
    // Codex 0.155.1 acknowledges separately from its effective-settings notification.
    const thread = state.threads[params.threadId]
    if (!thread || !loadedThreads.has(thread.id)) { emit({ id, error: { code: -32600, message: 'Thread is not loaded' } }); return }
    for (const key of ['model', 'approvalPolicy', 'approvalsReviewer']) if (params[key] != null) thread[key] = params[key]
    if (params.effort != null) thread.reasoningEffort = params.effort
    if (params.sandboxPolicy) thread.sandbox = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' }[params.sandboxPolicy.type]
    save()
    const settings = { model: thread.model, effort: thread.reasoningEffort, approvalPolicy: thread.approvalPolicy, approvalsReviewer: thread.approvalsReviewer,
      sandboxPolicy: { type: thread.sandbox === 'read-only' ? 'readOnly' : thread.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' } }
    if (!script.dropSettingsNotification) {
      const changed = () => notify('thread/settings/updated', { threadId: thread.id, threadSettings: settings })
      if (script.settingsNotificationDelay) setTimeout(changed, script.settingsNotificationDelay)
      else changed()
    }
    reply({})
  } else if (method === 'thread/rollback') {
    const thread = state.threads[params.threadId]
    if (!thread || thread.status.type !== 'idle' || !Number.isInteger(params.numTurns) || params.numTurns < 1 || params.numTurns > thread.turns.length) {
      emit({ id, error: { code: -32600, message: 'Cannot rewind this native turn boundary' } }); return
    }
    thread.turns = thread.turns.slice(0, -params.numTurns); thread.rewound = true; save()
    if (script.dropRollbackReply) return
    reply({ thread: script.omitRollbackTurns ? { ...thread, turns: undefined } : thread })
  } else if (method === 'turn/start') {
    const thread = state.threads[params.threadId]
    // Explicit opt-in fixture writes prove the adapter's actual execution cwd.
    if (script.writeCwd) writeFileSync(join(params.cwd ?? thread.cwd, 'native-cwd-proof.txt'), params.input.find(item => item.type === 'text')?.text ?? '')
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
  } else if (method === 'turn/steer') {
    const thread = state.threads[params.threadId]
    const turn = thread?.turns.at(-1)
    if (!turn || turn.status !== 'inProgress' || turn.id !== params.expectedTurnId) {
      emit({ id, error: { code: -32600, message: 'Expected active turn does not match' } }); return
    }
    const item = { type: 'userMessage', id: randomUUID(), clientId: script.legacySteer ? undefined : params.clientUserMessageId, content: params.input }
    turn.items.push(item); save()
    if (!script.suppressNotifications) notify('item/completed', { threadId: thread.id, turnId: turn.id, item })
    reply({ turnId: turn.id })
  } else if (method === 'thread/compact/start') {
    notify('turn/started', { threadId: params.threadId, turn: { id: 'compact-turn', status: 'inProgress', items: [] } })
    reply({})
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
  if (action.type === 'release-reply') {
    const reply = heldReplies.get(action.method)
    if (reply) { heldReplies.delete(action.method); emit(reply) }
    return
  }
  if (!thread) return
  if (action.type === 'complete') complete(thread, action.text, action.status)
  else if (action.type === 'notify-burst') {
    process.stdout.write(action.frames.map(frame => JSON.stringify(frame) + '\n').join(''))
  }
  else if (action.type === 'notify') {
    if (action.persist && action.params?.item) {
      const turn = thread.turns.find(turn => turn.id === action.params.turnId)
      if (turn) {
        const index = turn.items.findIndex(item => item.id === action.params.item.id)
        if (index < 0) turn.items.push(action.params.item); else turn.items[index] = action.params.item
        save()
      }
    }
    notify(action.method, { threadId: thread.id, ...action.params })
  }
  else raise(thread, action.type, action.text, action.method, action.params)
}, 10)
