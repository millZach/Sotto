// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { isBuiltin, createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prepareTerminalAgentHooks, type PreparedTerminalAgentHooks, type TerminalAgentHookEvent, type TerminalHookAnswer } from '../../src/main/terminals/hooks'
import { TerminalAgentStateMachine } from '../../src/main/terminals/state'

let root: string
let helperPath: string
const runs: PreparedTerminalAgentHooks[] = []
const children: ChildProcessWithoutNullStreams[] = []
const electronRunner = createRequire(import.meta.url)('electron') as string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-terminal-hooks-test-'))
  helperPath = join(root, 'helper.cjs')
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: true }, build: {
    ssr: resolve('src/main/terminals/helper.ts'), target: 'node24', outDir: root, emptyOutDir: false, minify: false,
    rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'helper.cjs' } },
  } })
})
afterEach(() => { for (const run of runs.splice(0)) run.dispose(); for (const child of children.splice(0)) child.kill() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })

async function prepared(provider: 'claude' | 'codex' | 'grok' = 'claude', extras: Partial<Parameters<typeof prepareTerminalAgentHooks>[0]> = {}) {
  const events: TerminalAgentHookEvent[] = []
  const closed: string[] = []
  const delivered: TerminalHookAnswer[] = []
  const run = await prepareTerminalAgentHooks({ terminalId: 'terminal-1', provider, helperPath, runner: electronRunner, tempRoot: root,
    onEvent: event => events.push(event), onRequestClosed: request => closed.push(request), onAnswerDelivered: answer => delivered.push(answer), ...extras })
  runs.push(run)
  return { run, events, closed, delivered }
}
function fixture(run: PreparedTerminalAgentHooks, provider = 'claude') {
  const child = spawn(process.execPath, [resolve('tests/fixtures/fakeTerminalAgent.mjs'), provider, ...run.args], {
    env: { ...process.env, ...run.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
  children.push(child)
  return { child, output: () => stdout, errors: () => stderr }
}
async function hook(run: PreparedTerminalAgentHooks, event: string, extra: Record<string, unknown> = {}) {
  const settings = JSON.parse(await readFile(run.args[run.args.indexOf('--settings') + 1]!, 'utf8'))
  const command = settings.hooks[event][0].hooks[0].command as string
  const child = spawn(command, { shell: true, windowsHide: true, env: { ...process.env, ...run.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += String(data) }); child.stderr.on('data', data => { stderr += String(data) })
  child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: run.providerSessionId, tool_name: 'Write', tool_input: { content: 'PRIVATE_CONTENT', file_path: 'PRIVATE_FILE' }, ...extra }))
  children.push(child)
  const exited = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
  return { child, exited, output: () => stdout, errors: () => stderr }
}
async function send(run: PreparedTerminalAgentHooks, frame: unknown) {
  await new Promise<void>(resolveClose => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(run.env.SOTTO_TERMINAL_HOOK_PORT) })
    socket.on('error', () => {}); socket.on('close', resolveClose)
    socket.on('connect', () => socket.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`))
  })
}
const boundFrame = (run: PreparedTerminalAgentHooks) => ({ terminalId: 'terminal-1', runId: run.runId, eventId: randomUUID(),
  kind: 'working', state: 'working', providerSessionId: run.providerSessionId, secret: run.env.SOTTO_TERMINAL_HOOK_SECRET })

describe('run-scoped terminal agent hooks', () => {
  it('launches the fake Claude CLI with real packaged-runner hooks across its lifecycle', async () => {
    const { run, events, closed } = await prepared()
    const { child, output, errors } = fixture(run)
    await expect.poll(() => events.some(event => event.kind === 'session-start')).toBe(true)
    await expect.poll(output).toContain('? for shortcuts')
    child.stdin.write('w\n')
    await expect.poll(() => events.some(event => event.kind === 'working')).toBe(true)
    child.stdin.write('n\n')
    await expect.poll(() => events.some(event => event.kind === 'permission')).toBe(true)
    expect(output()).toContain('Do you want to make this edit')
    child.stdin.write('i\n')
    await expect.poll(() => events.some(event => event.kind === 'cancelled')).toBe(true)
    await expect.poll(() => { expect(errors()).toBe(''); return closed.length }).toBe(1)
    child.stdin.write('w\nf\n')
    await expect.poll(() => events.some(event => event.kind === 'completed')).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|secret|tool_input|transcript|cwd/u)
    expect(errors()).toBe('')
  })
  it('admits Codex completion and IDs through notify, never its content or approval answers', async () => {
    const { run, events } = await prepared('codex')
    const { child, output, errors } = fixture(run, 'codex')
    await expect.poll(output).toContain('? for shortcuts')
    child.stdin.write('w\nf\n')
    await expect.poll(() => { expect(errors()).toBe(''); return events.length }).toBe(1)
    expect(events[0]).toMatchObject({ kind: 'completed', state: 'idle' })
    expect(events[0]?.providerSessionId).toMatch(/^[a-f0-9-]+$/u)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|secret|input-messages|last-assistant-message/u)
    expect(errors()).toBe('')
  })
  it.each([
    ['continuing', { stop_hook_active: true }],
    ['background', { background_tasks: [{ text: 'PRIVATE_TASK' }] }],
    ['session-cron', { session_crons: [{ text: 'PRIVATE_CRON' }] }],
  ] as const)('delivers %s Working through the packaged helper and finishes later silent work without an unread race', async (reason, extra) => {
    const { run, events } = await prepared()
    const machine = new TerminalAgentStateMachine(run.runId, 'claude', 120, 30, run.providerSessionId)
    machine.started()
    const ready = '\x1b[2J\x1b[HClaude Code v2.1.295\r\n❯ \r\n? for shortcuts'
    const working = '\x1b[2J\x1b[HClaude Code v2.1.295\r\n✻ Working… (esc to interrupt)'
    machine.setVisible(true); machine.output(ready)
    const submit = await hook(run, 'UserPromptSubmit', { prompt_id: 'turn-1', prompt: 'PRIVATE_PROMPT' })
    expect(await submit.exited).toBe(0); await expect.poll(() => events.length).toBe(1)
    expect(events[0]?.workPhase).toBe('submitted'); machine.hook(events[0]!); machine.output(working); machine.output(ready)
    const continuing = await hook(run, 'Stop', { prompt_id: 'turn-1', ...extra })
    expect(await continuing.exited).toBe(0); await expect.poll(() => events.length).toBe(2)
    expect(events[1], `${reason} carries only continued work`).toMatchObject({ kind: 'working', workPhase: 'continuing' })
    machine.hook(events[1]!); machine.output(ready); machine.quiet(); expect(machine.state).toBe('working')
    machine.setVisible(false)
    const tool = await hook(run, 'PreToolUse', { prompt_id: 'turn-1' })
    expect(await tool.exited).toBe(0); await expect.poll(() => events.length).toBe(3)
    machine.hook(events[2]!)
    const stopped = await hook(run, 'Stop', { prompt_id: 'turn-1', stop_hook_active: false, background_tasks: [], session_crons: [] })
    expect(await stopped.exited).toBe(0); await expect.poll(() => events.length).toBe(4)
    machine.hook(events[3]!); machine.output(ready); expect(machine.state).toBe('just-finished')
    expect(events.filter(event => event.kind === 'completed')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|secret|tool_input|last_assistant_message|background_tasks|session_crons/u)
    for (const child of [submit, continuing, tool, stopped]) { expect(child.output()).toBe(''); expect(child.errors()).toBe('') }
  })
  it('drops malformed Stop fields through the packaged helper without inventing Working or completion', async () => {
    const { run, events } = await prepared()
    for (const extra of [{ stop_hook_active: 'false' }, { background_tasks: 'PRIVATE_UNKNOWN_SHAPE' }, { session_crons: {} },
      { stop_hook_active: true, background_tasks: null }]) {
      const invalid = await hook(run, 'Stop', extra)
      expect(await invalid.exited).toBe(0); expect(invalid.output()).toBe(''); expect(invalid.errors()).toBe('')
      expect(events).toEqual([])
    }
  })
  it.each(['claude', 'codex', 'grok'] as const)('recognizes the live %s question while keeping its answer in the CLI', async provider => {
    const { run, events } = await prepared(provider)
    const machine = new TerminalAgentStateMachine(run.runId, provider, 120, 40, run.providerSessionId)
    machine.started()
    const { child, errors } = fixture(run, provider)
    child.stdout.on('data', data => machine.output(String(data)))
    await expect.poll(() => { expect(errors()).toBe(''); return machine.state }).toBe('idle')
    machine.input('a\r'); child.stdin.write('a\n')
    await expect.poll(() => machine.state).toBe('needs-you')
    expect(events.some(event => event.kind === 'permission')).toBe(false)
    child.stdin.write('i\n')
    await expect.poll(() => machine.state).toBe('idle')
  })
  it.skipIf(process.platform !== 'win32')('preserves notify and helper JSON through legacy PowerShell with spaces and apostrophes', async () => {
    const special = join(root, "path with Zach's apostrophe")
    await mkdir(special)
    const specialHelper = join(special, "helper with Zach's apostrophe.cjs")
    await copyFile(helperPath, specialHelper)
    const { run, events } = await prepared('codex', { tempRoot: special, helperPath: specialHelper })
    const quote = (value: string): string => `'${value.replace(/'/gu, "''")}'`
    const command = `& ${[process.execPath, resolve('tests/fixtures/fakeTerminalAgent.mjs'), 'codex', ...run.args].map(quote).join(' ')}`
    const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, ...run.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child)
    let output = '', errors = ''
    child.stdout.on('data', data => { output += String(data) }); child.stderr.on('data', data => { errors += String(data) })
    await expect.poll(() => { expect(errors).toBe(''); return output }).toContain('? for shortcuts')
    child.stdin.write('w\nf\n')
    await expect.poll(() => { expect(errors).toBe(''); return events.length }).toBe(1)
    expect(events[0]).toMatchObject({ kind: 'completed', state: 'idle' })
    expect(JSON.stringify(events)).not.toContain('PRIVATE_')
  })
  it.each(['allow', 'deny'] as const)('delivers only one exact %s answer and acknowledges the helper write', async decision => {
    const { run, events, delivered, closed } = await prepared()
    const invocation = await hook(run, 'PermissionRequest')
    await expect.poll(() => { expect(invocation.errors()).toBe(''); return events.length }).toBe(1)
    const request = events[0]!
    const answer: TerminalHookAnswer = { terminalId: 'terminal-1', runId: run.runId, requestId: request.requestId!, approvalId: request.approvalId!, answerId: randomUUID(), decision }
    expect(run.answer({ ...answer, runId: 'other-run' })).toBe(false)
    expect(run.answer({ ...answer, approvalId: 'other-approval' })).toBe(false)
    expect(run.answer(answer)).toBe(true)
    expect(run.answer({ ...answer, answerId: randomUUID() })).toBe(false)
    expect(await invocation.exited).toBe(0)
    await expect.poll(() => delivered).toEqual([answer])
    await expect.poll(() => closed).toEqual([request.requestId])
    expect(JSON.parse(invocation.output())).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: decision } } })
    expect(invocation.errors()).toBe('')
    expect(run.answer(answer)).toBe(false)
  })
  it('expires a timed out permission without printing a fabricated decision', async () => {
    const { run, events, closed } = await prepared('claude', { requestTimeoutMs: 150 })
    const invocation = await hook(run, 'PermissionRequest')
    await expect.poll(() => events.length).toBe(1)
    expect(await invocation.exited).toBe(0)
    await expect.poll(() => closed).toEqual([events[0]!.requestId])
    expect(invocation.output()).toBe('')
    expect(invocation.errors()).toBe('')
  })
  it('cancels pending connections on failure and cannot redirect a stale answer', async () => {
    const { run, events, closed } = await prepared()
    const permission = await hook(run, 'PermissionRequest')
    await expect.poll(() => events.length).toBe(1)
    const request = events[0]!
    const failure = await hook(run, 'StopFailure')
    expect(await failure.exited).toBe(0)
    expect(await permission.exited).toBe(0)
    await expect.poll(() => closed).toContain(request.requestId)
    expect(run.answer({ terminalId: 'terminal-1', runId: run.runId, requestId: request.requestId!, approvalId: request.approvalId!, answerId: randomUUID(), decision: 'allow' })).toBe(false)
    expect(permission.output()).toBe('')
  })
  it('rejects unauthenticated, stale, oversized and content-bearing frames, then deduplicates valid IDs', async () => {
    const { run, events } = await prepared()
    const frame = boundFrame(run)
    for (const invalid of [{ ...frame, secret: '0'.repeat(64) }, { ...frame, runId: 'old-run' }, { ...frame, providerSessionId: 'other-session' },
      { ...frame, kind: 'unknown-event' }, { ...frame, tool_input: 'PRIVATE' }, 'x'.repeat(8193)]) await send(run, invalid)
    expect(events).toHaveLength(0)
    await send(run, frame); await send(run, frame)
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('secret')
  })
  it('closes only permission sockets belonging to a cancelled turn', async () => {
    const { run, events, closed } = await prepared()
    const sockets = ['a', 'b'].map(turnId => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(run.env.SOTTO_TERMINAL_HOOK_PORT) })
      socket.on('error', () => {})
      socket.on('connect', () => socket.write(`${JSON.stringify({ ...boundFrame(run), kind: 'permission', state: 'needs-you', turnId, requestId: turnId, approvalId: `approval-${turnId}` })}\n`))
      return socket
    })
    try {
      await expect.poll(() => events.filter(event => event.kind === 'permission').length).toBe(2)
      await send(run, { ...boundFrame(run), kind: 'cancelled', state: 'idle', turnId: 'a' })
      await expect.poll(() => closed).toEqual(['a'])
      expect(run.answer({ terminalId: 'terminal-1', runId: run.runId, requestId: 'b', approvalId: 'approval-b', answerId: randomUUID(), decision: 'deny' })).toBe(true)
      expect(closed).not.toContain('b')
    } finally { for (const socket of sockets) socket.destroy() }
  })
  it('does not replay an uncertain answer or redirect it to the next request', async () => {
    const { run, events, closed, delivered } = await prepared()
    const requestId = randomUUID(), approvalId = randomUUID()
    const socket = createConnection({ host: '127.0.0.1', port: Number(run.env.SOTTO_TERMINAL_HOOK_PORT) })
    socket.on('error', () => {})
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...boundFrame(run), kind: 'permission', state: 'needs-you', requestId, approvalId })}\n`))
    await expect.poll(() => events.length).toBe(1)
    const answer: TerminalHookAnswer = { terminalId: 'terminal-1', runId: run.runId, requestId, approvalId, answerId: randomUUID(), decision: 'allow' }
    const received = new Promise<void>(resolveReceived => socket.once('data', () => { socket.destroy(); resolveReceived() }))
    expect(run.answer(answer)).toBe(true)
    await received
    await expect.poll(() => closed).toContain(requestId)
    expect(delivered).toHaveLength(0)
    const next = await hook(run, 'PermissionRequest')
    await expect.poll(() => events.length).toBe(2)
    expect(run.answer(answer)).toBe(false)
    expect(run.answer({ ...answer, requestId: events[1]!.requestId! })).toBe(false)
    run.dispose()
    expect(await next.exited).toBe(0)
    expect(next.output()).toBe('')
  })
  it('bounds unauthenticated concurrent callers without changing state', async () => {
    const { run, events } = await prepared('claude', { connectionTimeoutMs: 5_000 })
    const sockets = Array.from({ length: 33 }, () => createConnection({ host: '127.0.0.1', port: Number(run.env.SOTTO_TERMINAL_HOOK_PORT) }))
    for (const socket of sockets) socket.on('error', () => {})
    try {
      await Promise.all(sockets.map(socket => new Promise<void>(resolveConnect => socket.once('connect', resolveConnect))))
      await expect.poll(() => sockets.filter(socket => socket.destroyed).length).toBe(1)
      expect(events).toHaveLength(0)
    } finally { for (const socket of sockets) socket.destroy() }
  })
  it('creates only private run overrides, gives Reopen new identities and never persists a secret', async () => {
    const first = await prepared(), second = await prepared()
    expect(first.run.runId).not.toBe(second.run.runId)
    expect(first.run.providerSessionId).not.toBe(second.run.providerSessionId)
    expect(first.run.env.SOTTO_TERMINAL_HOOK_SECRET).not.toBe(second.run.env.SOTTO_TERMINAL_HOOK_SECRET)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const name of await readdir(join(root, entry.name))) {
        const content = await readFile(join(root, entry.name, name), 'utf8')
        expect(content).not.toContain(first.run.env.SOTTO_TERMINAL_HOOK_SECRET)
        expect(content).not.toContain(second.run.env.SOTTO_TERMINAL_HOOK_SECRET)
      }
    }
  })
  it('disposes all pending approvals and makes no automatic answer after connection failure', async () => {
    const { run, events } = await prepared()
    const invocation = await hook(run, 'PermissionRequest')
    await expect.poll(() => events.length).toBe(1)
    run.dispose()
    expect(await invocation.exited).toBe(0)
    expect(invocation.output()).toBe('')
  })
})
