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
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0) }
const metadata = args.includes('--no-session-persistence')
const session = metadata ? 'metadata' : value(args.includes('--resume') ? '--resume' : '--session-id')
if (!metadata && (args.includes('--tools') || args.includes('--safe-mode') || value('--permission-prompts') !== 'host' || !['default', 'acceptEdits', 'auto', 'bypassPermissions'].includes(value('--permission-mode')))) throw new Error('Coding threads must retain tools and host permission decisions')
// Both permission flags or none of the surface: the real CLI treats --permission-prompts host as
// permission to ask and --permission-prompt-tool stdio as the thing that makes this process the asker.
// Dropping the second is silent there, so it is loud here.
if (!metadata && value('--permission-prompt-tool') !== 'stdio') throw new Error('Coding threads must name this process as the permission prompt surface')
// The native CLI refuses bypassPermissions unless bypassing was explicitly allowed at launch; never allow it for other modes.
if (!metadata && (value('--permission-mode') === 'bypassPermissions') !== args.includes('--allow-dangerously-skip-permissions')) throw new Error('bypassPermissions requires --allow-dangerously-skip-permissions, and only that mode may carry it')
record(args.includes('--resume') ? 'resume' : 'launch', { source: 'child-process-argv', args, cwd: process.cwd(), compactionEnvironment: Object.fromEntries(['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) })
const folder = join(root, 'home', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/gu, '-'))
const log = join(folder, session + '.jsonl')
let parentUuid = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).findLast(frame => frame.uuid)?.uuid ?? null : null
const persist = frame => { mkdirSync(folder, { recursive: true }); appendFileSync(log, JSON.stringify({ ...frame, parentUuid, isSidechain: false, cwd: process.cwd(), sessionId: session, timestamp: frame.timestamp ?? new Date().toISOString() }) + '\n'); parentUuid = frame.uuid ?? parentUuid }
const pending = new Map()
const violation = reason => appendFileSync(join(root, 'violations.jsonl'), reason + '\n')
let lastAction = ''
let initialized = false
const timer = setInterval(() => {
  const control = join(root, `control-${session}.json`)
  if (!existsSync(control)) return
  let action; try { action = JSON.parse(readFileSync(control, 'utf8')) } catch { return }
  if (lastAction === action.id) return
  lastAction = action.id
  // Consume before delivery so a resumed process cannot replay this as a new live event.
  unlinkSync(control)
  if (action.type === 'exit') { process.exit(1) }
  if (action.type === 'raw-burst') { process.stdout.write(action.frames.map(frame => JSON.stringify(frame) + '\n').join('')); return }
  if (action.type === 'raw') { if (action.persist) persist(action.frame); output(action.frame); return }
  if (action.type === 'dialog') {
    const request = { subtype: 'request_user_dialog', dialog_kind: 'resume_return', payload: action.payload }
    pending.set(action.requestId, request); output({ type: 'control_request', request_id: action.requestId, request }); return
  }
  if (action.type === 'complete') {
    const id = randomUUID()
    // A turn that leaves a subagent running launches it from a root tool call, as Claude 2.1.280 does with
    // `run_in_background`; its task_started is held until after the result, so only the task frames keep it.
    const agent = action.background ? { tool: randomUUID(), task: action.background.taskId ?? randomUUID() } : undefined
    output({ type: 'stream_event', session_id: session, event: { type: 'message_start', message: { id, role: 'assistant' } } })
    if (agent) output({ type: 'stream_event', session_id: session, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: agent.tool, name: 'Agent', input: {} } } })
    output({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: action.text } } })
    const frame = { type: 'assistant', uuid: randomUUID(), session_id: session, message: { id, role: 'assistant', content: [{ type: 'text', text: action.text }] } }
    persist(frame); output(frame); output({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: action.text })
    if (agent) output({ type: 'system', subtype: 'task_started', session_id: session, uuid: randomUUID(), task_id: agent.task, tool_use_id: agent.tool,
      description: action.background.description, subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent' })
    return
  }
  if (action.type === 'permission' || action.type === 'question') {
    const request = { subtype: 'can_use_tool', tool_name: action.type === 'question' ? 'AskUserQuestion' : 'Bash', tool_use_id: randomUUID(), input: action.type === 'question' ? { questions: [{ question: action.text, header: 'Choice', options: [{ label: 'Blue', description: 'Blue color' }], multiSelect: false }] } : { command: 'npm run build', description: action.text } }
    const request_id = action.requestId ?? randomUUID(); pending.set(request_id, request); output({ type: 'control_request', request_id, request }); return
  }
}, 10)
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line); record(frame.request?.subtype ?? frame.type, frame)
  if (frame.type === 'control_request') {
    if (frame.request.subtype === 'initialize') {
      const scriptPath = join(root, 'initialize-script.json')
      const script = !metadata && existsSync(scriptPath) ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {}
      const respond = () => {
        initialized = !script.fail
        output({ type: 'control_response', response: script.fail
          ? { subtype: 'error', request_id: frame.request_id, error: 'Synthetic initialization rejected' }
          : { subtype: 'success', request_id: frame.request_id, response: { models, commands: existsSync(join(root, 'skills.json')) ? JSON.parse(readFileSync(join(root, 'skills.json'), 'utf8')) : [], session_state: 'idle' } } })
        // A started session announces its tools, and AskUserQuestion is in that list only where someone
        // can answer it. `approvalSurface: false` is the CLI that took the flag and offered no surface.
        if (!script.fail && !metadata) output({ type: 'system', subtype: 'init', session_id: session,
          tools: ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', ...(script.approvalSurface === false ? [] : ['AskUserQuestion'])] })
      }
      if (script.gate) {
        writeFileSync(join(root, 'initialize-waiting'), session)
        const gate = setInterval(() => { if (existsSync(join(root, 'initialize-release'))) { clearInterval(gate); respond() } }, 5)
      } else respond()
    }
    else if (frame.request.subtype === 'interrupt') {
      output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } })
      output({ type: 'result', subtype: 'success', session_id: session, is_error: false, result: '' })
    } else violation('Unknown control request')
  } else if (frame.type === 'user') {
    if (!initialized) violation('User prompt arrived before successful initialization')
    if (!frame.uuid || frame.session_id !== session || frame.message?.role !== 'user' || frame.parent_tool_use_id !== null) violation('Malformed native user frame')
    persist(frame)
    const scriptPath = join(root, 'script.json')
    const script = existsSync(scriptPath) ? JSON.parse(readFileSync(scriptPath, 'utf8')) : {}
    if (script.writeCwd) writeFileSync(join(process.cwd(), 'native-cwd-proof.txt'), typeof frame.message.content === 'string' ? frame.message.content : frame.message.content.find(item => item.type === 'text')?.text ?? '')
    if (script.delay) { writeFileSync(scriptPath, '{}'); setTimeout(() => output(frame), script.delay) } else output(frame)
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
lines.on('close', () => { clearInterval(timer); record('exit', { session }); process.exit(0) })
