import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

// Fake interactive CLI uses precisely the run-only hook settings the real providers receive.
// Its output and prompts are synthetic; no installed agent, sign-in or model request is needed.
const provider = process.argv[2]
const argv = process.argv.slice(3)
const after = flag => argv[argv.indexOf(flag) + 1]
const sessionId = provider === 'claude' ? after('--session-id') : randomUUID()
let settings = {}
let notify
if (provider === 'claude') settings = JSON.parse(await readFile(after('--settings'), 'utf8'))
else if (provider === 'codex') {
  const override = argv.find(value => value.startsWith('notify='))
  if (override) {
    // The product emits only TOML literal strings, including multiline literals for apostrophe paths.
    const array = override.slice('notify='.length)
    notify = []
    let offset = 1
    if (!array.startsWith('[') || !array.endsWith(']')) throw new Error('Invalid synthetic notify override')
    while (offset < array.length - 1) {
      const delimiter = array.startsWith("'''", offset) ? "'''" : "'"
      if (!array.startsWith(delimiter, offset)) throw new Error('Invalid synthetic notify literal')
      const end = array.indexOf(delimiter, offset + delimiter.length)
      if (end < 0) throw new Error('Invalid synthetic notify literal')
      notify.push(array.slice(offset + delimiter.length, end))
      offset = end + delimiter.length
      if (array[offset] === ',') offset++
      else if (array[offset] !== ']') throw new Error('Invalid synthetic notify array')
    }
  }
}
let turnId = randomUUID()
let deferredSubmit = false
let permission
const hookChildren = new Set()
const wait = child => new Promise(resolve => child.once('exit', resolve))
function claudeHook(event, extra = {}, hold = false) {
  const command = settings.hooks?.[event]?.[0]?.hooks?.[0]?.command
  if (!command) return Promise.resolve()
  // The fixture exercises native fallback promptly; a real run uses the ADR's 110-second bound.
  const env = hold ? { ...process.env, SOTTO_TERMINAL_HOOK_TIMEOUT_MS: process.env.SOTTO_FAKE_PERMISSION_WAIT_MS ?? '1000' } : process.env
  const child = spawn(command, { shell: true, windowsHide: true, detached: process.platform !== 'win32', env, stdio: ['pipe', 'pipe', 'pipe'] })
  hookChildren.add(child)
  child.once('exit', () => hookChildren.delete(child))
  child.on('error', () => {})
  child.stderr.on('data', data => process.stderr.write(data))
  child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: sessionId, prompt_id: turnId,
    cwd: 'PRIVATE_CWD_MUST_NOT_LEAVE_HELPER', transcript_path: 'PRIVATE_TRANSCRIPT_MUST_NOT_BE_OPENED', ...extra }))
  if (hold) { permission = child; return Promise.resolve() }
  return wait(child)
}
async function stopPermission() {
  if (!permission) return false
  const child = permission; permission = undefined
  // Only the fixture's recorded hook child tree is terminated, as a native CLI would terminate it.
  if (child.exitCode === null) {
    if (process.platform === 'win32') await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
    else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already ended. */ } }
  }
  // This was an interruption, never an invented approval. The hook closes all live request bindings.
  await claudeHook('StopFailure', { error: 'PRIVATE_CANCELLED_PERMISSION' })
  return true
}
async function completion() {
  if (provider === 'claude') await claudeHook('Stop', { stop_hook_active: false, background_tasks: [], session_crons: [], last_assistant_message: 'PRIVATE_FINAL_TEXT' })
  else if (provider === 'codex' && notify) {
    const child = spawn(notify[0], [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete', 'thread-id': sessionId, 'turn-id': turnId,
      cwd: 'PRIVATE_CWD', 'input-messages': ['PRIVATE_INPUT'], 'last-assistant-message': 'PRIVATE_OUTPUT', client: 'synthetic' })],
    { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    child.stderr.on('data', data => process.stderr.write(data))
    await wait(child)
  }
}
function screen(state) {
  const title = provider === 'claude' ? 'Claude Code v2.1.295' : provider === 'codex' ? 'OpenAI Codex (v0.162.0)' : 'Grok Build v1.0.50'
  let body
  if (provider === 'grok') {
    body = state === 'working' ? '⠧ Thinking… 0.2s        0.2s [stop]\r\n│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review\r\nCtrl+C:cancel'
      : state === 'permission' ? '┃  Allow Execute?\r\n┃  1 (●) Yes, proceed\r\n┃  2 (○) No, reject (type to add feedback)\r\n1/2:select  │  Tab:next option  │  Ctrl+c:cancel'
      : state === 'question' ? '┃  Choose a colour.\r\n┃  1 (○) Blue\r\n┃  2 (○) Green\r\n┃  (○) Other (type your own answer)\r\nTab:next answer  │  Esc:scrollback  │  X:dismiss'
      : '│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review\r\nUse Shift+Tab to cycle between modes like Plan mode.'
  } else if (state === 'question') body = provider === 'claude'
    ? 'Choose a colour.\r\n❯ 1. Blue\r\n2. Green\r\n3. Type something.\r\nEnter to select · ↑/↓ to navigate · Esc to cancel'
    : 'Question 1/1 (1 unanswered)\r\nChoose a colour.\r\n› 1. Blue\r\n2. Green\r\ntab to add notes | enter to submit answer | esc to interrupt'
  else if (state === 'working') body = provider === 'claude' ? '✻ Working… (esc to interrupt)' : '• Working (0s • esc to interrupt)'
  else if (state === 'permission') body = provider === 'claude'
    ? 'Do you want to make this edit to marker.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend'
    : 'Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel'
  else body = provider === 'claude' ? '❯ \r\n? for shortcuts' : '› Ask Codex to do anything\r\n? for shortcuts'
  process.stdout.write(`\x1b[2J\x1b[H${title}\r\n${body}`)
}
await claudeHook('SessionStart')
screen('idle')
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let chain = Promise.resolve()
input.on('line', line => {
  chain = chain.then(async () => {
    const command = line.trim()
    if (command === 'w' || command === 'l') {
      turnId = randomUUID()
      deferredSubmit = command === 'l'
      screen('working')
      if (!deferredSubmit) await claudeHook('UserPromptSubmit', { prompt: 'PRIVATE_PROMPT' })
    } else if (command === 'n') {
      screen('permission')
      await claudeHook('PermissionRequest', { tool_name: 'Write', tool_input: { content: 'PRIVATE_TOOL_CONTENT', file_path: 'PRIVATE_PATH' }, permission_suggestions: [] }, true)
      await claudeHook('Notification', { notification_type: 'permission_prompt', message: 'PRIVATE_PERMISSION_MESSAGE' })
    } else if (command === 'a') {
      // Structured questions stay in the native CLI; there is no supported hook answer shape.
      screen('question')
    } else if (command === 'f') {
      await stopPermission()
      screen('idle')
      // Script a slow submitted helper explicitly rather than relying on startup timing under load.
      if (deferredSubmit) { deferredSubmit = false; await claudeHook('UserPromptSubmit', { prompt: 'PRIVATE_PROMPT' }) }
      await completion()
    } else if (command === 'i') {
      if (!await stopPermission()) await claudeHook('StopFailure', { error: 'PRIVATE_ERROR' })
      screen('idle')
    } else if (command === 'q') {
      for (const child of hookChildren) child.kill()
      process.exit(0)
    }
  })
})
process.on('SIGTERM', () => { for (const child of hookChildren) child.kill(); process.exit(0) })
