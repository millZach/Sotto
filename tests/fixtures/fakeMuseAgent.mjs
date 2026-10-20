import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
// A scripted `muse serve` (MSP over stdio), in the shape Sotto's Muse adapter speaks. Files in the root
// steer it, as with the other fakes: `script.json` (cliVersion, schemaVersion, models, delayTurnMs,
// suppressNotifications), `control.json` (one driver action at a time), `oneshot.json` (side-writing text).
// A process started with --no-session-log is one of Sotto's memory-only hosts (connect probe or side call):
// its frames are recorded apart, in oneshot.jsonl, and its sessions are never durable.
// Session tool servers (`config.mcpServers`) need the `sessionMcp` capability, granted when asked for unless
// script.json says `sessionMcp: false`. A host that builds a session's runtime with servers connects to each one,
// as Muse does, and records what it listed as `fixture/mcp-tools`. A later resume on the same host may leave the
// servers out, or repeat them exactly; a different set is refused, as Muse refuses it.
// The `mcp-call` action calls one tool on one of a session's servers as Muse's model would, giving up after the
// `Sotto-Tool-Wait` the server was given, as Muse gives up after its own limit, and records `fixture/mcp-call`.
// `session/start` takes a `permissionProfile` (Muse's `:ask-me` and `:auto-review`), refused when script.json says
// `permissionProfiles: false`; a session started with one reports its reviewer in `permissionState`, or the one
// script.json's `reviewerAuthority` names, to a connection that asked for the experimental API and unless script.json
// says `permissionStateHidden`. `session/read` serves a stored session without attaching it.
// `parkSetModel` holds one session/setModel for the model it names until a `release-set-model` action answers it,
// saying nothing.
// `silentSetModel` accepts a model change without session/modelChanged, as an answer can arrive without one.
// `moveDuringApprovalMode` and `moveDuringResume` each move the session to the model they name once, saying so with
// session/modelChanged before answering session/setApprovalMode or session/resume: a resume's description is then older
// than Muse's own word.
// `session/setModel` is refused, with Muse's error shape, when script.json's `rejectSetModel` is true or lists the model,
// and never answered when `holdSetModel` is true. The `model-changed` action moves a session to another model on Muse's
// side and says so, as Muse does with session/modelChanged; `moveAfterSetModel` does the same once, to the model it
// names, after accepting a session/setModel and before answering it. Each turn the session opens records the model it ran on in
// the stored session's `turnModels`.
const root = process.argv[2]
const ephemeral = process.argv.includes('--no-session-log')
// The serve arguments Sotto started this host with, one line per process, beside the frame logs.
try { appendFileSync(join(root, 'argv.jsonl'), JSON.stringify(process.argv.slice(3)) + '\n') } catch { /* The root is the fixture's; a missing record fails its reader, not the host. */ }
const path = name => join(root, name)
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')) } catch { return fallback } }
const send = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
const record = frame => appendFileSync(path(ephemeral ? 'oneshot.jsonl' : 'requests.jsonl'), JSON.stringify({ ...frame, process: process.pid }) + '\n')
const startup = read('script.json', {})
const MODELS = startup.models ?? [{ modelId: 'fixture-model', providerId: 'meta', displayLabel: 'Fixture Muse', isDefault: true, cost: null, contextWindow: null, profileId: null }]
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
const stored = () => read('native-sessions.json', { sessions: {}, starts: {} })
const current = () => locked(stored)
const sessions = {}
const save = () => { if (!ephemeral && Object.keys(sessions).length) locked(() => { const all = stored(); Object.assign(all.sessions, sessions); writeFileSync(path('native-sessions.json'), JSON.stringify(all)) }) }
function hold(sessionId) {
  // A session taken from disk carries no live turn: the host that ran it is gone, as with a real restart.
  if (!sessions[sessionId]) { const session = ephemeral ? undefined : current().sessions[sessionId]; if (!session) return undefined; delete session.activeTurnId; sessions[sessionId] = session }
  return sessions[sessionId]
}
const holders = () => path('holders')
function holding(sessionId, held) {
  if (ephemeral) return
  mkdirSync(holders(), { recursive: true })
  const file = join(holders(), sessionId)
  if (held) { writeFileSync(file, String(process.pid)); record({ method: 'fixture/session-resident', params: { sessionId, resident: true } }); return }
  try { if (Number(readFileSync(file, 'utf8')) === process.pid) { rmSync(file, { force: true }); record({ method: 'fixture/session-resident', params: { sessionId, resident: false } }) } } catch { /* Not held here. */ }
}
const held = new Set()
const cursor = session => `cursor-${session.items.length}-${session.items.reduce((sum, item) => sum + item.revision, 0)}`
const REVIEWERS = { ':ask-me': 'human', ':read-only': 'human', ':auto-review': 'autoReview', ':unrestricted': 'none' }
// `reopenedAsDefault` describes a resumed or read session by the catalog's default model, as Muse 1.4.10 does, though
// the session runs the model it was started on or last set to, as its start reply and session/modelChanged say.
const view = (session, reopened = false) => ({
  sessionId: session.sessionId, path: `fixture:///${session.sessionId}`, status: session.activeTurnId ? 'running' : 'idle', ephemeral,
  modelId: reopened && read('script.json', {}).reopenedAsDefault ? MODELS.find(model => model.isDefault)?.modelId ?? session.modelId : session.modelId, providerId: 'meta', workspaceRoot: session.cwd, cwd: session.cwd, approvalMode: { mode: session.mode, source: 'wire' },
  activeTurnId: session.activeTurnId ?? null, turnCount: session.turns ?? 0, createdAt: session.createdAt, updatedAt: session.createdAt,
  ...(session.profileId && experimental && !read('script.json', {}).permissionStateHidden ? { permissionState: { profileId: session.profileId, reviewerAttached: false,
    reviewerAuthority: read('script.json', {}).reviewerAuthority ?? REVIEWERS[session.profileId] ?? 'autoReview' } } : {}),
})
const notify = (method, params) => send({ method, params })
function approvalUpdate(approval) {
  return { approvalId: approval.approvalId, sessionId: approval.sessionId, subject: approval.subject,
    availableChoices: approval.availableChoices, currentRequirementId: approval.currentRequirementId,
    change: { kind: 'requirementAdvanced', requirementId: approval.currentRequirementId } }
}
function advanceApproval(approval) {
  const sourceIndex = approval.currentRequirementId.sourceIndex + 1
  approval.currentRequirementId = { approvalId: approval.approvalId, sourceIndex }
  approval.subject = { ...approval.subject, command: `${approval.fixtureCommand} (stage ${sourceIndex + 1})` }
}
function requestApproval(session, action) {
  const approvalId = `approval-${randomUUID()}`
  const tool = action.toolName !== undefined
  const approval = { approvalId, sessionId: session.sessionId, turnId: session.activeTurnId ?? 'unknown', toolName: tool ? action.toolName : 'bash', toolCallId: `call-${approvalId}`,
    itemId: `item-${approvalId}`, rawArgs: JSON.stringify(tool ? {} : { command: action.text }), streamSeq: 1, subject: tool ? { kind: 'tool', toolName: action.toolName } : { kind: 'shell', command: action.text },
    warnings: [], judge: { lane: 'policy', verdict: 'prompt', adopted: true }, requirements: [{ approvalId, sourceIndex: 0, promptSeq: 1, status: 'current' }],
    availableChoices: action.choices ?? [{ choiceId: 'yes', decision: 'approved', label: 'Allow once', scope: 'once' }, { choiceId: 'no', decision: 'denied', label: 'Deny', scope: 'once' }],
    currentRequirementId: { approvalId, sourceIndex: 0 }, askedAt: stamp(), fixtureCommand: action.text,
    fixtureStages: action.stages ?? 1, fixtureUpdateTiming: action.updateTiming ?? 'before' }
  session.pendingApprovals = [...(session.pendingApprovals ?? []), approval]; save()
  if (!read('script.json', {}).suppressApproval) notify('approval/requested', approval)
}
function addItem(session, item, tell = true) {
  const at = session.items.findIndex(candidate => candidate.itemId === item.itemId)
  if (at >= 0) session.items[at] = item; else session.items.push(item)
  save()
  if (tell) notify(item.status === 'inProgress' && at < 0 ? 'item/started' : item.status === 'inProgress' ? 'item/updated' : 'item/completed',
    { sessionId: session.sessionId, item, viewCursor: cursor(session) })
}
let clock = 0
const stamp = () => new Date(Date.UTC(2026, 9, 12, 12, 0, clock++)).toISOString()
function openTurn(session, commandId, text, steered = false, displayText = undefined) {
  const turnId = session.activeTurnId ?? `turn-${randomUUID()}`
  if (!session.activeTurnId) { session.activeTurnId = turnId; session.turns = (session.turns ?? 0) + 1; session.turnModels = [...(session.turnModels ?? []), session.modelId]; notify('turn/started', { sessionId: session.sessionId, turnId, ...(commandId ? { commandId } : {}), viewCursor: cursor(session) }) }
  // script.json may have Muse keep no display text (`dropDisplayText`), or cut the message to `truncateUserText` characters.
  const script = read('script.json', {})
  if (script.dropDisplayText) displayText = undefined
  const cut = script.truncateUserText !== undefined && text.length > script.truncateUserText
  if (cut) { text = text.slice(0, script.truncateUserText); if (displayText !== undefined) displayText = displayText.slice(0, script.truncateUserText) }
  addItem(session, { itemId: `item-${randomUUID()}`, kind: 'userMessage', status: 'completed', revision: 1, turnId, recordedAt: stamp(), text, ...(displayText !== undefined ? { displayText } : {}), ...(cut ? { truncated: true } : {}), ...(commandId ? { commandId } : {}), ...(steered ? { steered: true } : {}) }, !script.suppressUserMessage)
  return turnId
}
function endTurn(session, terminal = 'completed') {
  const turnId = session.activeTurnId
  if (!turnId) return
  session.activeTurnId = undefined; save()
  if (!read('script.json', {}).suppressTurnCompleted) notify('turn/completed', { sessionId: session.sessionId, turnId, terminal, durationMs: 1, viewCursor: cursor(session) })
}
function completeReply(session, text) {
  const itemId = `item-${randomUUID()}`
  const base = { itemId, kind: 'agentMessage', status: 'inProgress', revision: 1, turnId: session.activeTurnId ?? null, recordedAt: stamp(), text: '' }
  addItem(session, base)
  notify('item/delta', { sessionId: session.sessionId, itemId, delta: text, field: 'text', viewCursor: cursor(session) })
  addItem(session, { ...base, status: 'completed', revision: 2, text })
  endTurn(session)
}
let seenAction, pendingListReply, parkedSetModel
function check() {
  if (ephemeral) return
  const action = read('control.json', undefined)
  if (!action || action.id === seenAction) return
  const session = action.sessionId ? sessions[action.sessionId] : undefined
  if (!session) return
  seenAction = action.id
  rmSync(path('control.json'), { force: true })
  if (action.type === 'takeover') openTurn(session, undefined, action.text)
  else if (action.type === 'complete') completeReply(session, action.text)
  else if (action.type === 'reply-start') addItem(session, { itemId: `item-${randomUUID()}`, kind: 'agentMessage', status: 'inProgress', revision: 1,
    turnId: session.activeTurnId ?? null, recordedAt: stamp(), text: action.text })
  else if (action.type === 'exit') process.exit(0)
  else if (action.type === 'release-set-model') { const answer = parkedSetModel; parkedSetModel = undefined; answer?.() }
  else if (action.type === 'malformed') notify('item/delta', { sessionId: session.sessionId, itemId: 1 })
  else if (action.type === 'gap') {
    if (action.text) addItem(session, { itemId: `item-${randomUUID()}`, kind: 'agentMessage', status: 'completed', revision: 1,
      turnId: session.activeTurnId ?? null, recordedAt: stamp(), text: action.text }, false)
    notify('view/gap', { sessionId: session.sessionId })
    if (action.repeat) notify('view/gap', { sessionId: session.sessionId })
  }
  else if (action.type === 'question') {
    const userInputId = `input-${randomUUID()}`
    const questions = [{ id: 'q1', header: 'Fixture', question: action.text, selection: { mode: 'single' }, options: [] },
      ...(action.optional ? [{ id: 'q2', header: 'Optional', question: 'Anything else?', selection: { mode: 'single', minSelections: 0 }, options: [] }] : [])]
    session.pendingInputs = [...(session.pendingInputs ?? []), { userInputId, text: action.text, questions }]; save()
    if (!read('script.json', {}).suppressQuestion) notify('userInput/requested', { userInputId, sessionId: session.sessionId, turnId: session.activeTurnId ?? 'unknown', toolName: 'request_user_input', questions })
  } else if (action.type === 'permission-update') {
    const approval = session.pendingApprovals?.[0]
    if (!approval) return
    advanceApproval(approval); save()
    if (!action.silent) notify('approval/updated', approvalUpdate(approval))
  } else if (action.type === 'permission-read-release') {
    pendingListReply?.(); pendingListReply = undefined
  } else if (action.type === 'permission') {
    requestApproval(session, action)
  } else if (action.type === 'tool-permission') {
    if (!session.activeTurnId) openTurn(session, undefined, 'A turn that calls a tool')
    requestApproval(session, action)
  } else if (action.type === 'mcp-call') void callTool(session, action)
  else if (action.type === 'model-changed') {
    session.modelId = action.modelId; save()
    notify('session/modelChanged', { sessionId: session.sessionId, modelId: session.modelId })
  }
}
/** One tool call as Muse's model makes it, on the session's server whose name is the plain name and the thread's suffix. */
async function callTool(session, action) {
  const servers = sessionServers.get(session.sessionId) ?? {}
  const name = Object.keys(servers).find(key => key === action.server || key.replace(/_[0-9a-f]{10}$/u, '') === action.server)
  const server = name ? servers[name] : undefined
  const started = Date.now()
  if (!server) { record({ method: 'fixture/mcp-call', params: { sessionId: session.sessionId, server: action.server, tool: action.tool, missing: true } }); return }
  const limit = Number(server.headers?.['Sotto-Tool-Wait'] ?? 300) * 1000
  try {
    const response = await globalThis.fetch(server.url, { method: 'POST', signal: globalThis.AbortSignal.timeout(limit),
      headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: action.tool, arguments: action.arguments ?? {} } }) })
    const reply = await response.json()
    record({ method: 'fixture/mcp-call', params: { sessionId: session.sessionId, server: name, tool: action.tool, callId: action.callId,
      elapsedMs: Date.now() - started, limitMs: limit, result: reply.result?.structuredContent ?? null } })
  } catch (error) {
    record({ method: 'fixture/mcp-call', params: { sessionId: session.sessionId, server: name, tool: action.tool, callId: action.callId,
      elapsedMs: Date.now() - started, limitMs: limit, timedOut: error?.name === 'TimeoutError' || error?.name === 'AbortError' } })
  }
}
setInterval(check, 20)
record({ method: 'fixture/process', params: { pid: process.pid, version: startup.cliVersion ?? '1.1.1', args: process.argv.slice(3), environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['META_API_KEY'].includes(key))) } })
process.on('exit', () => { for (const sessionId of held) holding(sessionId, false); save() })
let granted = []
let experimental = false
/** What this host built each session's runtime with: the servers' JSON, or null for none. */
const loadedServers = new Map()
/** The servers themselves, by session, for the model's tool calls. */
const sessionServers = new Map()
const capabilityRequired = id => send({ id, error: { code: -32010, message: 'capability required', data: { kind: 'capabilityRequired', capability: 'sessionMcp' } } })
async function listServerTools(sessionId, servers) {
  for (const [name, server] of Object.entries(servers)) {
    const post = async (body, id) => {
      const response = await globalThis.fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), ...body }) })
      return id === undefined ? undefined : (await response.json()).result
    }
    try {
      await post({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }, 1)
      await post({ method: 'notifications/initialized' })
      const listed = await post({ method: 'tools/list', params: {} }, 2)
      record({ method: 'fixture/mcp-tools', params: { sessionId, server: name, transport: server.transport, mode: server.mode, wait: server.headers?.['Sotto-Tool-Wait'] ?? null,
        tools: listed.tools.map(tool => ({ name: tool.name, readOnly: tool.annotations?.readOnlyHint === true })) } })
    } catch { record({ method: 'fixture/mcp-tools', params: { sessionId, server: name, failed: true } }) }
  }
}
/** Build a session's runtime on this host, or check a later resume against it. False when Muse would refuse the config. */
function load(sessionId, config) {
  const servers = config?.mcpServers && Object.keys(config.mcpServers).length ? config.mcpServers : null
  if (loadedServers.has(sessionId)) return config?.mcpServers === undefined || loadedServers.get(sessionId) === JSON.stringify(servers)
  loadedServers.set(sessionId, JSON.stringify(servers))
  if (servers) { sessionServers.set(sessionId, servers); void listServerTools(sessionId, servers) }
  return true
}
const textOf = input => (input ?? []).filter(part => part?.type === 'text').map(part => part.text).join('')
createInterface({ input: process.stdin }).on('line', line => {
  check()
  const frame = JSON.parse(line); record(frame)
  if (!frame.method) { appendFileSync(path('violations.jsonl'), JSON.stringify({ reason: 'A client reply Muse never asked for' }) + '\n'); return }
  const p = frame.params ?? {}; const script = read('script.json', {})
  const result = value => send({ id: frame.id, result: value })
  const fail = (kind, message, reason) => send({ id: frame.id, error: { code: -32602, message, data: { kind, ...(reason ? { reason } : {}) } } })
  if (frame.method === 'initialize') {
    granted = script.sessionMcp !== false && startup.sessionMcp !== false && (p.capabilities?.requestedCapabilities ?? []).includes('sessionMcp') ? ['sessionMcp'] : []
    experimental = p.capabilities?.experimentalApi === true
    result({ grantedCapabilities: granted, serverInfo: { name: 'muse-code-fixture', title: 'Muse fixture', version: startup.cliVersion ?? '1.1.1' }, schema: { family: 'msp', version: startup.schemaVersion ?? 1 }, sessionDurability: { state: 'durable' }, userAgent: 'fixture', museHome: root, workspaceTrust: { state: 'untrusted' }, subagentControl: { state: 'disabled' }, requests: {}, notifications: {} })
  } else if (frame.method === 'initialized') { /* A notification. */ }
  else if (frame.method === 'model/list') result({ models: MODELS, defaultModelId: MODELS.find(model => model.isDefault)?.modelId ?? null, source: script.catalogSource ?? startup.catalogSource ?? (MODELS.length ? 'providerCatalog' : 'bundledCatalog') })
  else if (frame.method === 'session/start') {
    if (p.config?.mcpServers && !granted.includes('sessionMcp')) { capabilityRequired(frame.id); return }
    if (script.ceiling && ['allowAll', 'onRequest'].includes(p.approvalMode)) { fail('commandRejected', 'Refused by the fixture ceiling', 'approval_mode_ceiling'); return }
    if (p.permissionProfile !== undefined && (script.permissionProfiles === false || ephemeral)) { fail('commandRejected', 'Unknown permission profile', ephemeral ? 'permission_profile_ephemeral_fixed' : 'permission_profile_unknown'); return }
    let sessionId = p.sessionId
    if (!sessionId && !ephemeral) {
      const all = current()
      sessionId = all.starts[p.commandId]
      if (sessionId && all.startRequests?.[p.commandId] !== JSON.stringify(p)) { fail('commandRejected', 'Changed replay payload', 'command_id_conflict'); return }
    }
    if (!sessionId) sessionId = ephemeral ? `side-${randomUUID()}` : randomUUID()
    let session = hold(sessionId)
    if (!session) {
      session = { sessionId, cwd: p.workspaceRoot, modelId: p.modelId ?? 'fixture-model', mode: p.approvalMode ?? 'promptUnmatched', items: [], createdAt: stamp(), pendingApprovals: [], pendingInputs: [],
        ...(p.permissionProfile ? { profileId: p.permissionProfile } : {}) }
      sessions[sessionId] = session
      if (!ephemeral) locked(() => { const all = stored(); all.starts[p.commandId] = sessionId; (all.startRequests ??= {})[p.commandId] = JSON.stringify(p); all.sessions[sessionId] = session; writeFileSync(path('native-sessions.json'), JSON.stringify(all)) })
      held.add(sessionId); holding(sessionId, true)
    }
    if (!load(sessionId, p.config)) { fail('commandRejected', 'Session tool servers conflict with the loaded runtime', 'session_configuration_conflict'); return }
    if (!ephemeral && script.loseStartAckOnce) { writeFileSync(path('script.json'), JSON.stringify({ ...script, loseStartAckOnce: false })); return }
    result({ session: view(session), viewCursor: cursor(session) })
  } else if (frame.method === 'session/resume') {
    if (script.rejectResume) { fail('commandRejected', 'Scripted resume refusal'); return }
    if (p.config?.mcpServers && !granted.includes('sessionMcp')) { capabilityRequired(frame.id); return }
    const session = hold(p.sessionId)
    if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    if (!load(session.sessionId, p.config)) { fail('commandRejected', 'Session tool servers conflict with the loaded runtime', 'session_configuration_conflict'); return }
    held.add(session.sessionId); holding(session.sessionId, true)
    const pendingRequests = [...(session.pendingApprovals ?? []).map(item => ({ kind: 'approval', approvalId: item.approvalId })),
      ...(session.pendingInputs ?? []).map(item => ({ kind: 'userInput', userInputId: item.userInputId }))]
    const snapshot = globalThis.structuredClone({ session: view(session, true), history: { mode: 'inline', items: p.excludeItems ? null : session.items, totalItemCount: session.items.length, nextCursor: null, snapshot: null }, pendingRequests, viewCursor: cursor(session) })
    if (script.moveDuringResume) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, moveDuringResume: undefined }))
      session.modelId = script.moveDuringResume; save()
      notify('session/modelChanged', { sessionId: session.sessionId, modelId: session.modelId })
    }
    if (script.resumeReplyRace) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, resumeReplyRace: undefined }))
      const item = session.items.findLast(candidate => candidate.kind === 'agentMessage' && candidate.status === 'inProgress')
      const suffix = script.resumeReplyRace.suffix
      notify('item/delta', { sessionId: session.sessionId, itemId: item.itemId, delta: suffix, field: 'text', viewCursor: cursor(session) })
      const updated = { ...item, text: item.text + suffix }
      if (script.resumeReplyRace.complete) {
        addItem(session, { ...updated, status: 'completed', revision: item.revision + 1 })
        endTurn(session)
      } else addItem(session, updated, false)
      result(snapshot)
      notify('session/contextUsage', { sessionId: session.sessionId, usedTokens: 655 })
    } else if (script.resumeTurnRace) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, resumeTurnRace: undefined }))
      if (script.resumeTurnRace === 'start') openTurn(session, undefined, 'A newer native turn')
      else if (script.resumeTurnRace === 'complete') completeReply(session, 'Finished after the resume snapshot')
      result(snapshot)
      notify('session/contextUsage', { sessionId: session.sessionId, usedTokens: 654 })
    } else result(snapshot)
  } else if (frame.method === 'session/read') {
    const session = sessions[p.sessionId] ?? (ephemeral ? undefined : current().sessions[p.sessionId])
    if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    result({ session: view(session, true), history: { mode: 'inline', items: p.excludeItems === false ? session.items : null, totalItemCount: session.items.length, nextCursor: null, snapshot: null }, pendingRequests: [], viewCursor: cursor(session) })
  } else if (frame.method === 'session/list') result({ sessions: Object.values(ephemeral ? sessions : current().sessions).map(view) })
  else if (frame.method === 'session/setModel') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    if (script.holdSetModel) return
    if (script.rejectSetModel === true || script.rejectSetModel?.includes?.(p.model.modelId)) { fail('commandRejected', 'Refused by the fixture', 'model_unavailable'); return }
    if (script.parkSetModel === p.model.modelId) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, parkSetModel: undefined }))
      parkedSetModel = () => {
        const previous = session.modelId; session.modelId = p.model.modelId; save()
        result({ modelId: p.model.modelId, previousModelId: previous })
      }
      return
    }
    const previousModelId = session.modelId; session.modelId = p.model.modelId; save()
    if (!script.silentSetModel) notify('session/modelChanged', { sessionId: session.sessionId, modelId: session.modelId })
    if (script.moveAfterSetModel) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, moveAfterSetModel: undefined }))
      session.modelId = script.moveAfterSetModel; save()
      notify('session/modelChanged', { sessionId: session.sessionId, modelId: session.modelId })
    }
    result({ modelId: p.model.modelId, previousModelId })
  } else if (frame.method === 'session/setApprovalMode') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    if (script.ceiling && ['allowAll', 'onRequest'].includes(p.mode)) { fail('commandRejected', 'Refused by the fixture ceiling', 'approval_mode_ceiling'); return }
    const previousMode = session.mode; session.mode = p.mode; save()
    notify('session/approvalModeChanged', { sessionId: session.sessionId, mode: p.mode, source: 'wire' })
    if (script.moveDuringApprovalMode) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, moveDuringApprovalMode: undefined }))
      session.modelId = script.moveDuringApprovalMode; save()
      notify('session/modelChanged', { sessionId: session.sessionId, modelId: session.modelId })
    }
    result({ mode: p.mode, effectiveMode: p.mode, previousMode })
  } else if (frame.method === 'turn/start' || frame.method === 'turn/steer') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    const steer = frame.method === 'turn/steer'
    const go = () => {
      const turnId = openTurn(session, p.commandId, textOf(p.input), steer, p.displayText)
      if (ephemeral) completeReply(session, read('oneshot.json', {}).text ?? 'Fixture title')
      return turnId
    }
    if (script.delayTurnMs) {
      const { delayTurnMs } = script
      writeFileSync(path('script.json'), JSON.stringify({ ...script, delayTurnMs: 0 }))
      setTimeout(() => { const turnId = go(); result({ turnId, disposition: steer ? 'steered' : 'started' }) }, delayTurnMs)
    } else result({ turnId: go(), disposition: steer ? 'steered' : 'started' })
  } else if (frame.method === 'turn/interrupt') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    result({ outcome: 'interruptQueued' })
    // Stopping the turn cancels what it was waiting on, as Muse does: the requests resolve without anyone's decision.
    for (const approval of session.pendingApprovals ?? []) notify('approval/resolved', { approvalId: approval.approvalId, sessionId: session.sessionId, decision: 'cancelled', resolvedBy: 'policy' })
    for (const input of session.pendingInputs ?? []) notify('userInput/settled', { userInputId: input.userInputId, sessionId: session.sessionId, outcome: 'cancelled' })
    session.pendingApprovals = []; session.pendingInputs = []; save()
    endTurn(session, 'cancelled')
  } else if (frame.method === 'approval/listPending') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    const snapshot = globalThis.structuredClone({ approvals: session.pendingApprovals ?? [], userInputs: (session.pendingInputs ?? []).map(item => ({ userInputId: item.userInputId, sessionId: session.sessionId, turnId: session.activeTurnId ?? 'unknown', toolName: 'request_user_input', questions: item.questions ?? [{ id: 'q1', header: 'Fixture', question: item.text, selection: { mode: 'single' }, options: [] }] })) })
    if (script.pendingListRace) {
      writeFileSync(path('script.json'), JSON.stringify({ ...script, pendingListRace: undefined, holdPendingList: undefined }))
      if (script.pendingListRace === 'request') requestApproval(session, { text: 'A new approval after the read' })
      else if (script.pendingListRace === 'stage') {
        const approval = session.pendingApprovals[0]; advanceApproval(approval); save()
        notify('approval/updated', approvalUpdate(approval))
      } else if (script.pendingListRace === 'resolved') {
        const approval = session.pendingApprovals.shift(); save()
        notify('approval/resolved', { sessionId: session.sessionId, approvalId: approval.approvalId, decision: 'denied' })
      }
      const reply = () => {
        result(snapshot)
        // A later observable stream fact proves the preceding stale read response was drained.
        notify('session/contextUsage', { sessionId: session.sessionId, usedTokens: 789 })
      }
      if (script.holdPendingList) pendingListReply = reply
      else reply()
    } else result(snapshot)
  } else if (frame.method === 'approval/decide') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    const previous = session.approvalDecisions?.[p.commandId]
    if (previous) {
      if (previous.payload !== JSON.stringify(p)) fail('commandRejected', 'Changed replay payload', 'command_id_conflict')
      else result(previous.ack)
      return
    }
    const approval = (session.pendingApprovals ?? []).find(item => item.approvalId === p.approvalId)
    if (!approval) { fail('approvalAlreadyResolved', 'Already decided'); return }
    if (p.requirementId?.approvalId !== approval.currentRequirementId.approvalId
      || p.requirementId?.sourceIndex !== approval.currentRequirementId.sourceIndex) { fail('approvalRequirementStale', 'The requirement changed'); return }
    if (script.rejectApprovalChoice || !approval.availableChoices.some(choice => choice.choiceId === p.choiceId)) { fail('approvalChoiceInvalid', 'This choice was rejected'); return }
    const terminal = p.choiceId !== 'yes' || approval.currentRequirementId.sourceIndex + 1 >= approval.fixtureStages
    const ack = { commandId: p.commandId, status: 'accepted', approvalId: p.approvalId, terminal }
    const acknowledge = () => result(script.unreadableApprovalAck ? { commandId: p.commandId, status: 'accepted' } : ack)
    session.approvalDecisions ??= {}
    session.approvalDecisions[p.commandId] = { payload: JSON.stringify(p), ack }
    if (terminal) {
      session.pendingApprovals = session.pendingApprovals.filter(item => item.approvalId !== p.approvalId); save()
      notify('approval/resolved', { approvalId: p.approvalId, sessionId: session.sessionId, decision: p.choiceId === 'yes' ? 'approved' : 'denied' })
      acknowledge()
    } else {
      advanceApproval(approval); save()
      if (approval.fixtureUpdateTiming === 'before') notify('approval/updated', approvalUpdate(approval))
      acknowledge()
      if (approval.fixtureUpdateTiming === 'after') setImmediate(() => notify('approval/updated', approvalUpdate(approval)))
    }
  } else if (frame.method === 'userInput/answer' || frame.method === 'userInput/cancel') {
    const session = hold(p.sessionId); if (!session) { fail('sessionNotFound', 'Unknown session'); return }
    if (!(session.pendingInputs ?? []).some(item => item.userInputId === p.userInputId)) { fail('userInputAlreadySettled', 'Already settled'); return }
    session.pendingInputs = session.pendingInputs.filter(item => item.userInputId !== p.userInputId); save()
    const outcome = frame.method.endsWith('cancel') ? 'cancelled' : 'answered'
    notify('userInput/settled', { userInputId: p.userInputId, sessionId: session.sessionId, outcome })
    result({ outcome })
  } else if (frame.method === 'session/compact') result({ outcome: 'noop' })
  else if (frame.id !== undefined) fail('methodNotFound', 'Not in this fixture')
}).on('close', () => process.exit(0))
