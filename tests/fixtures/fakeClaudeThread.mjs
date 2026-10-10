// Scripted native Claude 2.1.268 stream-json process; protocol from Anthropic SDK query.py.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import console from 'node:console'
import { clearInterval } from 'node:timers'
const [root, ...args] = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
const record = (method, frame) => appendFileSync(join(root, 'requests.jsonl'), JSON.stringify({ method, params: { frame } }) + '\n')
const output = frame => process.stdout.write(JSON.stringify(frame) + '\n')
const models = existsSync(join(root, 'models.json')) ? JSON.parse(readFileSync(join(root, 'models.json'), 'utf8'))
  : [{ value: 'fixture-model', displayName: 'Fixture Claude', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]
if (args.includes('--help')) {
  console.log('--safe-mode --tools --permission-prompts --no-session-persistence --input-format --output-format --system-prompt --model --effort --verbose'); process.exit(0)
}
// version.txt: the client installed now. `--version` reads it as the real CLI reads its own build, and a session
// names the one it was started from in its init frame. Without the file the fake keeps no version, as before.
const installed = existsSync(join(root, 'version.txt')) ? readFileSync(join(root, 'version.txt'), 'utf8').trim() : undefined
if (args.includes('--version') && installed !== undefined) { console.log(`${installed} (Claude Code)`); process.exit(0) }
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0) }
// Sotto's side writing (ADR-0026): one print run with no tools and no session file. It records what it was
// given in oneshot.jsonl, never in requests.jsonl or a session log, and answers from oneshot.json.
if (args.includes('--no-session-persistence') && value('--output-format') === 'json') {
  const input = await new Promise(resolve => { let text = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { text += chunk }); process.stdin.on('end', () => resolve(text)) })
  const script = existsSync(join(root, 'oneshot.json')) ? JSON.parse(readFileSync(join(root, 'oneshot.json'), 'utf8')) : {}
  appendFileSync(join(root, 'oneshot.jsonl'), JSON.stringify({ args, cwd: process.cwd(), input }) + '\n')
  if (value('--tools') !== '' || !args.includes('--safe-mode') || value('--permission-prompts') !== 'none') appendFileSync(join(root, 'violations.jsonl'), 'Side writing must run with no tools, no customisations and nobody to prompt\n')
  if (script.fail) process.exit(1)
  if (script.delayMs) await new Promise(resolve => setTimeout(resolve, script.delayMs))
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: script.text ?? 'Fixture title' }))
  process.exit(0)
}
const metadata = args.includes('--no-session-persistence')
const session = metadata ? 'metadata' : value(args.includes('--resume') ? '--resume' : '--session-id')
if (!metadata && (args.includes('--tools') || args.includes('--safe-mode') || value('--permission-prompts') !== 'host' || !['default', 'acceptEdits', 'auto', 'bypassPermissions'].includes(value('--permission-mode')))) throw new Error('Coding threads must retain tools and host permission decisions')
// Both permission flags or none of the surface: the real CLI treats --permission-prompts host as
// permission to ask and --permission-prompt-tool stdio as the thing that makes this process the asker.
// Dropping the second is silent there, so it is loud here.
if (!metadata && value('--permission-prompt-tool') !== 'stdio') throw new Error('Coding threads must name this process as the permission prompt surface')
// The native CLI refuses bypassPermissions unless bypassing was explicitly allowed at launch; never allow it for other modes.
if (!metadata && (value('--permission-mode') === 'bypassPermissions') !== args.includes('--allow-dangerously-skip-permissions')) throw new Error('bypassPermissions requires --allow-dangerously-skip-permissions, and only that mode may carry it')
record(args.includes('--resume') ? 'resume' : 'launch', { source: 'child-process-argv', args, executable: process.execPath, cwd: process.cwd(), compactionEnvironment: Object.fromEntries(['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) })
// The isolated Electron journey uses the adapter's normal ~/.claude discovery path.
const folder = join(process.env.SOTTO_FAKE_CLAUDE_HOME ?? join(root, 'home'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/gu, '-'))
const log = join(folder, session + '.jsonl')
let parentUuid = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).findLast(frame => frame.uuid)?.uuid ?? null : null
// Live output and replay describe the same event, even when the script omitted its timestamp.
const persist = frame => {
  const stamped = { ...frame, timestamp: frame.timestamp ?? new Date().toISOString() }
  mkdirSync(folder, { recursive: true })
  appendFileSync(log, JSON.stringify({ ...stamped, parentUuid, isSidechain: false, cwd: process.cwd(), sessionId: session }) + '\n')
  parentUuid = frame.uuid ?? parentUuid
  return stamped
}
const pending = new Map()
const violation = reason => appendFileSync(join(root, 'violations.jsonl'), reason + '\n')
// One CLI per session. Two would both write the session's transcript, so Sotto must not start one while another it
// let go is still exiting. The running one keeps its pid in alive-<session>.json and removes it as it exits.
const alive = join(root, `alive-${session}.json`)
if (!metadata) {
  const other = existsSync(alive) ? Number(readFileSync(alive, 'utf8')) : 0
  let running = false
  try { if (other && other !== process.pid) { process.kill(other, 0); running = true } } catch { running = false }
  if (running) violation('Two CLIs ran on one session at once')
  writeFileSync(alive, String(process.pid))
}
const leave = () => { try { if (!metadata && readFileSync(alive, 'utf8') === String(process.pid)) unlinkSync(alive) } catch { /* already gone */ } }
let lastAction = ''
let initialized = false
const released = name => new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(root, name))) { clearInterval(timer); resolve() } }, 10) })
/**
 * script.json `steering`: a prompt sent while a turn runs, as Claude Code 2.1.295 takes it. It goes into the CLI's own
 * queue, said at once with a `queued` lifecycle frame, and is read into the running turn at its next model step (`say`):
 * its echo, then `started`. One still queued when the turn ends runs as the next turn, and a stop leaves it queued
 * (`still_queued`) to run next the same way.
 */
let turnOpen = false
const steered = []
const lifecycleOf = (uuid, state) => output({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: randomUUID(), session_id: session })
const readSteered = () => { for (const frame of steered.splice(0)) { output(persist(frame)); lifecycleOf(frame.uuid, 'started') } }
const turnEnded = () => { turnOpen = steered.length > 0; readSteered() }
/**
 * A finished reply. With `thinking` it opens on a thinking block, streamed the way Claude Code 2.1.289 streams one
 * (start, thinking deltas, a signature delta, stop), and written to the transcript as its own line with
 * `apiBlockIndex` and `thinkingDurationMs`. `thinking: ''` is a block with no words and `redacted: true` a
 * redacted one. `holdInThinking` names a file in the fixture root the block's second half waits for, and
 * `holdAfterThinking` one the reply waits for, so a test can look at the thread mid-thought and with only the
 * thinking arrived.
 */
async function complete(action) {
  const id = randomUUID()
  // A turn that leaves a subagent running launches it from a root tool call, as Claude 2.1.280 does with
  // `run_in_background`. The task_started follows the tool call inside the turn, as in a live capture, and
  // nothing ends it before the result, so the work must outlive the result to be seen afterwards.
  const agent = action.background ? { tool: randomUUID(), task: action.background.taskId ?? randomUUID() } : undefined
  output({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } })
  const thinking = typeof action.thinking === 'string' || action.redacted === true
  if (thinking) {
    const words = action.redacted ? '' : action.thinking
    const started = Date.now()
    output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0,
      content_block: action.redacted ? { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' } : { type: 'thinking', thinking: '', signature: '' } } })
    const middle = Math.ceil(words.length / 2)
    for (const [index, part] of [words.slice(0, middle), words.slice(middle)].entries()) {
      if (index === 1 && action.holdInThinking) await released(action.holdInThinking)
      if (part) output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: part } } })
    }
    if (!action.redacted) output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } } })
    output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
    const block = action.redacted ? { type: 'redacted_thinking', data: 'cmVkYWN0ZWQ=' } : { type: 'thinking', thinking: words, signature: 'c2lnbmF0dXJl' }
    const line = { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [block] } }
    persist({ ...line, apiBlockIndex: 0, thinkingDurationMs: Date.now() - started })
    output(line)
    if (action.holdAfterThinking) await released(action.holdAfterThinking)
  }
  if (agent) output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_start', index: thinking ? 1 : 0, content_block: { type: 'tool_use', id: agent.tool, name: 'Agent', input: {} } } })
  output({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', ...(thinking ? { index: 1 } : {}), delta: { type: 'text_delta', text: action.text } } })
  const frame = { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text: action.text }] } }
  if (agent) output({ type: 'system', subtype: 'task_started', session_id: session, uuid: randomUUID(), task_id: agent.task, tool_use_id: agent.tool,
    description: action.background.description, subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
  output(persist(frame)); output({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: action.text })
  turnEnded()
}
// The settings this process runs: what it was launched with, then whatever a settings request changed. Written to
// settings-<session>.json on every change so a test reads what the running CLI would use for its next turn.
const bypassAllowed = args.includes('--allow-dangerously-skip-permissions')
const settings = { model: value('--model'), effort: args.includes('--effort') ? value('--effort') : null, mode: value('--permission-mode') }
const saveSettings = () => { if (!metadata) writeFileSync(join(root, `settings-${session}.json`), JSON.stringify({ ...settings, pid: process.pid })) }
saveSettings()
// control-<session>.json: the one scripted action a test holds for this session, read every 10 ms or at once by `act`.
const act = () => {
  const control = join(root, `control-${session}.json`)
  if (!existsSync(control)) return
  let action; try { action = JSON.parse(readFileSync(control, 'utf8')) } catch { return }
  if (lastAction === action.id) return
  lastAction = action.id
  // Consume before delivery so a resumed process cannot replay this as a new live event.
  unlinkSync(control)
  if (action.type === 'exit') { process.exit(1) }
  // `persist` also writes the burst to the session log first, as the CLI records what it streams.
  if (action.type === 'raw-burst') {
    const frames = action.persist ? action.frames.map(persist) : action.frames
    process.stdout.write(frames.map(frame => JSON.stringify(frame) + '\n').join(''))
    return
  }
  if (action.type === 'raw') { output(action.persist ? persist(action.frame) : action.frame); return }
  if (action.type === 'subagent') {
    // Claude Code 2.1.280: a workflow (with `runId`) or a background Agent call reports one task and no
    // sidechain message. The real launch result names a background agent's `resolvedModel`; this one
    // leaves it out, so the agent's own transcript is the only place its model is written.
    const workflow = typeof action.runId === 'string'
    const dir = workflow ? join(folder, session, 'subagents', 'workflows', action.runId) : join(folder, session, 'subagents')
    const agentId = workflow ? action.agentId : action.taskId
    output({ type: 'assistant', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id: action.toolId, name: workflow ? 'Workflow' : 'Agent', input: workflow ? { script: 'export default async () => {}' } : { description: action.description, prompt: action.description, run_in_background: true } }] } })
    output({ type: 'system', subtype: 'task_started', session_id: session, task_id: action.taskId, tool_use_id: action.toolId, description: action.description, task_type: workflow ? 'local_workflow' : 'local_agent', ...(workflow ? { workflow_name: 'fixture' } : { subagent_type: 'general-purpose', is_backgrounded: true }) })
    output({ type: 'user', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: action.toolId, content: 'Launched' }] },
      tool_use_result: workflow ? { status: 'async_launched', taskId: action.taskId, taskType: 'local_workflow', workflowName: 'fixture', runId: action.runId, transcriptDir: dir } : { status: 'async_launched', isAsync: true, agentId } })
    // A workflow reports each of its agents in its progress; this one names no model, as a queued agent's may not.
    if (workflow) output({ type: 'system', subtype: 'task_progress', session_id: session, task_id: action.taskId, tool_use_id: action.toolId, description: `Fixture: ${action.label}`, last_tool_name: action.label,
      workflow_progress: [{ type: 'workflow_agent', index: 1, label: action.label, agentId, state: 'progress', startedAt: Date.now(), promptPreview: 'Fixture preview' }] })
    mkdirSync(dir, { recursive: true })
    const line = frame => JSON.stringify({ ...frame, isSidechain: true, agentId, sessionId: session, cwd: process.cwd(), timestamp: new Date().toISOString() })
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), [
      line({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: action.task ?? 'Fixture subagent task' } }),
      line({ type: 'attachment', uuid: randomUUID(), attachment: { type: 'fixture' } }),
      ...(action.model ? [line({ type: 'assistant', uuid: randomUUID(), message: { id: randomUUID(), model: action.model, role: 'assistant', content: [{ type: 'text', text: 'Fixture subagent reply' }] } })] : []),
    ].join('\n') + '\n')
    return
  }
  if (action.type === 'dialog') {
    const request = { subtype: 'request_user_dialog', dialog_kind: 'resume_return', payload: action.payload }
    pending.set(action.requestId, request); output({ type: 'control_request', request_id: action.requestId, request }); return
  }
  // One API message of a turn that goes on, as Claude writes before a tool call: the next message has its own ID.
  if (action.type === 'say') {
    readSteered()
    const id = randomUUID()
    output({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } })
    output({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: action.text } } })
    output(persist({ type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text: action.text }] } })); return
  }
  if (action.type === 'complete') { void complete(action); return }
  if (action.type === 'permission' || action.type === 'question') {
    const request = { subtype: 'can_use_tool', tool_name: action.type === 'question' ? 'AskUserQuestion' : 'Bash', tool_use_id: randomUUID(), input: action.type === 'question' ? { questions: [{ question: action.text, header: 'Choice', options: [{ label: 'Blue', description: 'Blue color' }], multiSelect: false }] } : { command: 'npm run build', description: action.text } }
    const request_id = action.requestId ?? randomUUID(); pending.set(request_id, request); output({ type: 'control_request', request_id, request }); return
  }
}
const timer = setInterval(act, 10)
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line); record(frame.request?.subtype ?? frame.type, frame)
  if (frame.type === 'control_request') {
    if (frame.request.subtype === 'initialize') {
      const scriptPath = join(root, 'initialize-script.json')
      const script = !metadata && existsSync(scriptPath) ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {}
      const respond = () => {
        initialized = !script.fail
        // Recorded so a test can count the CLIs started and not yet answered at any point.
        if (initialized && !metadata) record('initialize-answered', { session })
        output({ type: 'control_response', response: script.fail
          ? { subtype: 'error', request_id: frame.request_id, error: 'Synthetic initialization rejected' }
          : { subtype: 'success', request_id: frame.request_id, response: { models, commands: existsSync(join(root, 'skills.json')) ? JSON.parse(readFileSync(join(root, 'skills.json'), 'utf8')) : [], session_state: 'idle' } } })
        // A started session announces its tools, and AskUserQuestion is in that list only where someone
        // can answer it. `approvalSurface: false` is the CLI that took the flag and offered no surface.
        if (!script.fail && !metadata) output({ type: 'system', subtype: 'init', session_id: session, ...(installed !== undefined ? { claude_code_version: installed } : {}),
          tools: ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', ...(script.approvalSurface === false ? [] : ['AskUserQuestion'])] })
      }
      if (script.gate) {
        writeFileSync(join(root, 'initialize-waiting'), session)
        const gate = setInterval(() => { if (existsSync(join(root, 'initialize-release'))) { clearInterval(gate); respond() } }, 5)
      } else respond()
    }
    else if (['set_model', 'apply_flag_settings', 'set_permission_mode'].includes(frame.request.subtype)) {
      // settings-script.json: `refuse` answers every settings request with an error, or those of the subtypes it
      // lists; `silent` answers none, as a CLI whose acknowledgement was lost. Each holds while the file is there,
      // or for one refusal with `once`.
      const script = existsSync(join(root, 'settings-script.json')) ? JSON.parse(readFileSync(join(root, 'settings-script.json'), 'utf8')) : {}
      if (script.silent) return
      const request = frame.request
      const refuse = error => output({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error } })
      if (script.refuse === true || script.refuse?.includes?.(request.subtype)) {
        if (script.once) unlinkSync(join(root, 'settings-script.json'))
        refuse('Synthetic settings refusal'); return
      }
      if (request.subtype === 'set_model') {
        // Claude Code runs a long-context variant (`opus[1m]`) of a model it lists by its base alone.
        const listed = typeof request.model === 'string' ? request.model.replace(/\[\d+[km]\]$/iu, '') : null
        if (listed === null || !models.some(model => model.value === request.model || model.value === listed)) { refuse('Unknown model'); return }
        settings.model = request.model
      } else if (request.subtype === 'apply_flag_settings') {
        const keys = Object.keys(request.settings ?? {})
        if (keys.length !== 1 || keys[0] !== 'effortLevel') violation('Settings requests may only carry effortLevel')
        settings.effort = request.settings.effortLevel
      } else {
        if (!['default', 'acceptEdits', 'auto', 'bypassPermissions'].includes(request.mode)) violation('Unknown permission mode')
        // The native CLI refuses bypassPermissions unless bypassing was allowed at launch.
        if (request.mode === 'bypassPermissions' && !bypassAllowed) { refuse('Cannot set permission mode to bypassPermissions'); return }
        settings.mode = request.mode
      }
      saveSettings()
      // A success with no body, which the SDK reads as empty.
      output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id } })
    }
    else if (frame.request.subtype === 'interrupt') {
      // interrupt-script.json `error`: close the stopped turn as Claude Code does, with an error result.
      const error = existsSync(join(root, 'interrupt-script.json')) && JSON.parse(readFileSync(join(root, 'interrupt-script.json'), 'utf8')).error === true
      output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: steered.length ? { still_queued: steered.map(held => held.uuid) } : {} } })
      output(error ? { type: 'result', subtype: 'error_during_execution', session_id: session, is_error: true, result: '' } : { type: 'result', subtype: 'success', session_id: session, is_error: false, result: '' })
      turnEnded()
    } else violation('Unknown control request')
  } else if (frame.type === 'user') {
    if (!initialized) violation('User prompt arrived before successful initialization')
    if (!frame.uuid || frame.session_id !== session || frame.message?.role !== 'user' || frame.parent_tool_use_id !== null) violation('Malformed native user frame')
    const scriptPath = join(root, 'script.json')
    const script = existsSync(scriptPath) ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {}
    // script.json `localCommand`: answer the prompt as Claude Code 2.1.289 answers a slash command it cannot run
    // headless, such as /chrome. No echo: lifecycle frames naming the prompt, a canned reply, a result naming the
    // prompt, and two local_command entries in the transcript instead of the prompt. `evidence: 'result'` leaves out
    // the lifecycle frames; `evidence: 'none'` leaves out every frame that names the prompt.
    if (script.localCommand) {
      const command = typeof frame.message.content === 'string' ? frame.message.content : ''
      const stdout = `<local-command-stdout>${script.localCommand}</local-command-stdout>`
      const lifecycle = state => { if (!script.evidence) output({ type: 'command_lifecycle', command_uuid: frame.uuid, state, uuid: randomUUID(), session_id: session }) }
      persist({ type: 'system', subtype: 'local_command', content: command, level: 'info', uuid: randomUUID() })
      persist({ type: 'system', subtype: 'local_command', content: stdout, level: 'info', uuid: randomUUID() })
      lifecycle('queued'); lifecycle('started')
      output({ type: 'assistant', uuid: randomUUID(), session_id: session, parent_tool_use_id: null, message: { id: randomUUID(), model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: script.localCommand }] },
        local_command_source: stdout, local_command_outcome: { kind: 'unavailable_headless' } })
      output({ type: 'result', subtype: 'success', session_id: session, is_error: false, num_turns: 0, result: script.localCommand,
        ...(script.evidence === 'none' ? {} : { user_message_uuid: frame.uuid, user_message_uuids: [frame.uuid] }) })
      lifecycle('completed'); return
    }
    if (script.steering && turnOpen) { steered.push(frame); lifecycleOf(frame.uuid, 'queued'); return }
    turnOpen = true
    const reply = persist(frame)
    if (script.writeCwd) writeFileSync(join(process.cwd(), 'native-cwd-proof.txt'), typeof frame.message.content === 'string' ? frame.message.content : frame.message.content.find(item => item.type === 'text')?.text ?? '')
    if (script.delay) { writeFileSync(scriptPath, '{}'); setTimeout(() => output(reply), script.delay) } else output(reply)
    // script.json `reply`: a model that answers every prompt at once, as the scripted `complete` action answers it.
    if (!script.delay && script.reply !== undefined) { writeFileSync(join(root, `control-${session}.json`), JSON.stringify({ id: randomUUID(), type: 'complete', text: script.reply })); act() }
  } else if (frame.type === 'control_response') {
    const envelope = frame.response; const request = pending.get(envelope?.request_id); const answer = envelope?.response
    if (envelope?.subtype === 'error' && typeof envelope.error === 'string') { pending.delete(envelope.request_id); return }
    if (request?.subtype === 'request_user_dialog' && ['completed', 'cancelled'].includes(answer?.behavior)) {
      if (answer.behavior === 'completed' && !['compact', 'continue', 'never'].includes(answer.result)) violation('Malformed dialog choice')
      pending.delete(envelope.request_id); return
    }
    if (envelope?.subtype !== 'success' || !answer || !['allow', 'deny'].includes(answer.behavior)) violation('Malformed control_response')
    else if (answer.behavior === 'deny' && typeof answer.message !== 'string') violation('Denial requires message')
    else if (answer.behavior === 'allow') {
      if (!request) violation('Allow without pending request')
      else if (answer.updatedPermissions) violation('Persistent permission grants are forbidden')
      else if (request.tool_name === 'AskUserQuestion') {
        if (!answer.updatedInput?.answers || request.input.questions.some(q => typeof answer.updatedInput.answers[q.question] !== 'string')) violation('AskUserQuestion requires answer map keyed by question text')
      } else if (JSON.stringify(answer.updatedInput) !== JSON.stringify(request.input)) violation('Allow must preserve native tool input')
    }
    pending.delete(envelope?.request_id)
  } else violation('Unknown input frame')
})
// Recorded so a test can see a session end, whether Sotto disconnected or the reaper stopped it.
// exit-delay.json: the `ms` this process takes to exit once its input closes, as a real CLI still finishing its
// writes may.
lines.on('close', () => {
  clearInterval(timer)
  const delayMs = existsSync(join(root, 'exit-delay.json')) ? JSON.parse(readFileSync(join(root, 'exit-delay.json'), 'utf8')).ms : 0
  setTimeout(() => { record('exit', { session }); leave(); process.exit(0) }, delayMs)
})
