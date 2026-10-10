// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { startSocketServer } from '../../src/host/socketServer'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { PairedClients } from '../../src/main/agents/pairing'
import { TerminalWorkspaceService } from '../../src/main/terminals/service'
import type { PrepareTerminalAgentHooksOptions, TerminalHookAnswer } from '../../src/main/terminals/hooks'
import { hostRequestSchema, protocolAgentStateSchema } from '../../src/shared/hostProtocol'
import { phoneTerminalApprovalSchema, type PhoneTerminalAnswer } from '../../src/shared/phoneTerminals'
import { rawPeer } from '../fixtures/rawHostPeer'

let root: string
let host: Awaited<ReturnType<typeof startHeadlessHost>>
let listener: Awaited<ReturnType<typeof startSocketServer>>
let terminals: TerminalWorkspaceService
let pairing: PairedClients
let phone: Awaited<ReturnType<typeof rawPeer>>
let clientId: string
let session: string
let terminalId: string
let allowed: boolean
let hooks: PrepareTerminalAgentHooksOptions
let runId: string
let data: (value: string) => void
let hookWrite: ReturnType<typeof vi.fn<(answer: TerminalHookAnswer) => boolean>>
let prepareHookGate: Promise<void> | undefined
const writes = vi.fn()
const screen = (text: string) => `\x1b[2J\x1b[HClaude Code v2.1.295\r\n${text}`
const idle = screen('❯ \r\n? for shortcuts')
const working = screen('✻ Working… (esc to interrupt)')
const permission = screen('Bash command\r\nnpm test\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sotto-phone-terminals-'))
  host = await startHeadlessHost({ dataDirectory: join(root, 'host'), reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() } })
})
beforeEach(async () => {
  prepareHookGate = undefined
  allowed = true; writes.mockClear(); runId = randomUUID()
  hookWrite = vi.fn(() => true)
  terminals = new TerminalWorkspaceService({ projects: () => [{ id: 'p', title: 'Project', path: root }],
    worktrees: { allocate: vi.fn(), ensure: vi.fn(), workingDirectory: vi.fn() }, platform: 'darwin', env: { SHELL: '/bin/zsh' }, emit: () => {},
    spawn: () => ({ write: writes, resize: () => {}, kill: () => {},
      onData: (callback: typeof data) => { data = callback; return { dispose() {} } }, onExit: () => ({ dispose() {} }),
    }) as unknown as IPty,
    prepareHooks: async options => { await prepareHookGate; hooks = options; return { runId, args: [], env: {}, answer: answer => hookWrite(answer), dispose: () => {} } },
  })
  const result = await terminals.open({ projectId: 'p', title: 'Claude terminal', workingCopy: 'shared',
    launch: { provider: 'claude', modelId: null, reasoning: null, permission: 'ask' } })
  if (!result.ok) throw new Error(result.error.message)
  terminalId = result.value.terminal.id; await terminals.read({ id: terminalId }); data(idle)
  pairing = new PairedClients(join(root, randomUUID())); await pairing.load()
  clientId = (await pairing.redeem(pairing.issuePairingCode().code, 'iPhone')).clientId
  listener = await startSocketServer({ service: host.service, pairing, admin: false, terminals, mayAnswer: () => allowed })
  session = pairing.signSession(clientId)
  phone = await rawPeer(listener.descriptor.port, session)
})
afterEach(async () => { phone.frames.close(); await listener.close(); terminals.dispose() })
afterAll(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
const call = (op: Record<string, unknown>, peer = phone, id = randomUUID()) => peer.call(id, op)
async function hello(peer = phone, accepts: string[] = ['terminals']) { return (await call({ op: 'hello', accepts }, peer)).result as Record<string, unknown> }
function request(requestId = 'request-1', approvalId = 'approval-1') {
  data(permission)
  hooks.onEvent({ terminalId, runId, eventId: randomUUID(), requestId, approvalId, kind: 'permission', state: 'needs-you' })
}
async function preview(peer = phone): Promise<PhoneTerminalAnswer> {
  const result = await call({ op: 'terminal-approval', terminalId }, peer)
  const { lines, ...binding } = phoneTerminalApprovalSchema.parse(result.result)
  expect(lines.join('\n')).toContain('Do you want to proceed?')
  return { ...binding, decision: 'allow' }
}

it('advertises only where supported and leaves old clients thread-only, including pushes', async () => {
  expect(listener.descriptor.features).toContain('terminals')
  const olderHost = await startSocketServer({ service: host.service, pairing, admin: false })
  try { expect(olderHost.descriptor.features).not.toContain('terminals') } finally { await olderHost.close() }
  expect((await hello(phone, [])).shell).not.toHaveProperty('terminals')
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
  data(working)
  await expect.poll(() => phone.messages.filter(message => message.event === 'shell').length).toBeGreaterThan(0)
  for (const push of phone.messages.filter(message => message.event === 'shell')) expect(push.state).not.toHaveProperty('terminals')
  const current = await hello()
  expect(current.features).toContain('terminals')
  expect(protocolAgentStateSchema.parse(current.shell).terminals).toEqual([expect.objectContaining({ id: terminalId, state: 'working' })])
})

it('sends no output in lists or pushes, and reads only a bounded current approval bottom', async () => {
  await hello(); data(screen('PRIVATE_SCROLLBACK\r\n❯ \r\n? for shortcuts'))
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: true, result: null })
  request()
  const answer = await preview()
  expect(answer.runId).toBe(runId)
  const shell = (await call({ op: 'shell' })).result
  expect(JSON.stringify(shell)).not.toMatch(/PRIVATE_SCROLLBACK|npm test|Do you want|workingDirectory|command|secret/u)
  expect((shell as { terminals: unknown[] }).terminals).toEqual([expect.objectContaining({ state: 'needs-you', approval: { runId, requestId: 'request-1', approvalId: 'approval-1', previewId: answer.previewId } })])
  data('\x1b[2J\x1b[H')
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: true, result: null })
  expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  expect(hookWrite).not.toHaveBeenCalled()
})

it('uses the exact hook once, waits for acknowledgement and reconciles without replaying', async () => {
  await hello(); request(); const answer = await preview(), commandId = randomUUID()
  phone.frames.send({ v: 1, session, id: commandId, op: 'answer-terminal', answer })
  await expect.poll(() => hookWrite.mock.calls.length).toBe(1)
  expect(writes).not.toHaveBeenCalled()
  expect(await call({ op: 'receipt', commandId })).toMatchObject({ ok: true, result: { status: 'pending' } })
  expect(phone.messages.some(message => message.id === commandId)).toBe(false)
  hooks.onAnswerDelivered!(hookWrite.mock.calls[0]![0])
  await expect.poll(() => phone.messages.find(message => message.id === commandId)).toMatchObject({ ok: true, result: { answerDelivered: true } })
  expect(await call({ op: 'receipt', commandId })).toMatchObject({ ok: true, result: { status: 'completed', answerDelivered: true } })
  phone.messages.splice(0)
  expect(await call({ op: 'answer-terminal', answer }, phone, commandId)).toMatchObject({ ok: true, result: { answerDelivered: true } })
  expect(hookWrite).toHaveBeenCalledOnce()
  phone.messages.splice(0)
  expect(await call({ op: 'answer-terminal', answer: { ...answer, decision: 'deny' } }, phone, commandId)).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
})

it('requires this paired client to review and rechecks revoked Can answer before dispatch', async () => {
  await hello(); request(); const answer = await preview()
  const other = await rawPeer(listener.descriptor.port, pairing.signSession(clientId))
  try {
    await hello(other)
    expect(await call({ op: 'answer-terminal', answer }, other)).toMatchObject({ ok: false, error: { code: 'stale_request' } })
    allowed = false
    expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(hookWrite).not.toHaveBeenCalled()
  } finally { other.frames.close() }
})

it('refuses altered bindings, competing answers and expired hooks without typing into the PTY', async () => {
  await hello(); request(); const answer = await preview()
  expect(await call({ op: 'answer-terminal', answer: { ...answer, runId: randomUUID() } })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  const first = call({ op: 'answer-terminal', answer })
  await expect.poll(() => hookWrite.mock.calls.length).toBe(1)
  expect(await call({ op: 'answer-terminal', answer: { ...answer, decision: 'deny' } })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  hooks.onRequestClosed('request-1')
  expect(await first).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(hookWrite).toHaveBeenCalledOnce(); expect(writes).not.toHaveBeenCalled()
})

it('shares unread state and withdraws a phone detail on background/close with no retroactive badge', async () => {
  await hello(); data(working); data(idle)
  expect(terminals.phoneRows()[0]!.state).toBe('just-finished')
  await call({ op: 'observe-terminals', terminalIds: [terminalId] })
  expect(terminals.phoneRows()[0]!.state).toBe('idle')
  data(working); data(idle); expect(terminals.phoneRows()[0]!.state).toBe('idle')
  await call({ op: 'observe-terminals', terminalIds: [] })
  expect(terminals.phoneRows()[0]!.state).toBe('idle')
  data(working); data(idle); expect(terminals.phoneRows()[0]!.state).toBe('just-finished')
  await call({ op: 'observe-terminals', terminalIds: [terminalId] })
  phone.frames.close()
  await expect.poll(listener.peers).toBe(0)
  data(working); data(idle); expect(terminals.phoneRows()[0]!.state).toBe('just-finished')
})

it('withdraws stale/reopened approvals and offers no preview for a screen-only request', async () => {
  await hello(); data(permission)
  expect(terminals.phoneRows()[0]!.state).toBe('needs-you')
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: true, result: null })
  request(); const answer = await preview()
  await terminals.restart({ id: terminalId }); data(idle)
  expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  await terminals.close({ id: terminalId }); expect(terminals.phoneRows()).toEqual([])
  expect(hookWrite).not.toHaveBeenCalled()
})

it('rejects a changed reviewed screen and checks authority again inside the PTY owner', async () => {
  await hello(); request(); const answer = await preview()
  expect(await terminals.answerPhoneApproval(answer, () => false)).toBe(false)
  data(permission.replace('npm test', 'npm run changed'))
  expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  expect(hookWrite).not.toHaveBeenCalled()
  const fresh = await preview(); expect(fresh.previewId).not.toBe(answer.previewId)
})

it('never assigns an overlapping hook the screen left by an expired approval', async () => {
  await hello(); request('first-request', 'first-approval')
  const first = await preview()
  hooks.onEvent({ terminalId, runId, eventId: randomUUID(), requestId: 'second-request', approvalId: 'second-approval', kind: 'permission', state: 'needs-you' })
  expect(terminals.phoneApproval(terminalId)).toBeNull()
  hooks.onRequestClosed!('first-request')
  expect(terminals.phoneApproval(terminalId)).toBeNull()
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: true, result: null })
  expect(await call({ op: 'answer-terminal', answer: first })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  // A redraw still carries no request identity. The overlapping survivor belongs in the native CLI.
  data(permission.replace('npm test', 'npm run other'))
  expect(terminals.phoneApproval(terminalId)).toBeNull()
  expect(hookWrite).not.toHaveBeenCalled()
  hooks.onRequestClosed!('second-request')
  request('fresh-request', 'fresh-approval')
  expect((await preview()).requestId).toBe('fresh-request')
})

it('pushes changed or withdrawn preview fingerprints without sending screen text', async () => {
  await hello(); request(); const answer = await preview()
  await expect.poll(() => phone.messages.filter(message => message.event === 'shell').length).toBeGreaterThan(0)
  phone.messages.splice(0)
  data(permission.replace('npm test', 'npm run changed'))
  const changed = terminals.phoneApproval(terminalId)!
  expect(changed.previewId).not.toBe(answer.previewId)
  await expect.poll(() => phone.messages.filter(message => message.event === 'shell').at(-1)?.state).toMatchObject({
    terminals: [expect.objectContaining({ approval: expect.objectContaining({ previewId: changed.previewId }) })],
  })
  for (const push of phone.messages.filter(message => message.event === 'shell')) expect(JSON.stringify(push)).not.toContain('npm run changed')
  phone.messages.splice(0)
  await terminals.write({ id: terminalId, data: 'x' })
  await expect.poll(() => phone.messages.filter(message => message.event === 'shell').at(-1)?.state).toMatchObject({
    terminals: [expect.not.objectContaining({ approval: expect.anything() })],
  })
  expect(terminals.phoneApproval(terminalId)).toBeNull()
})

it.each([
  'Which option?\r\n❯ 1. First\r\n  2. Second\r\n  3. Type something.',
  'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n  3. Type something.',
  'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No',
])('never uses question chrome to review an outstanding permission hook: %s', async question => {
  await hello(); request(); const answer = await preview()
  data(screen(`${question}\r\nenter to select · ↑/↓ to navigate · esc to cancel`))
  expect(terminals.phoneRows()[0]).toMatchObject({ state: 'needs-you' })
  expect(terminals.phoneRows()[0]).not.toHaveProperty('approval')
  expect(await call({ op: 'terminal-approval', terminalId })).toMatchObject({ ok: true, result: null })
  expect(await call({ op: 'answer-terminal', answer })).toMatchObject({ ok: false, error: { code: 'stale_request' } })
  expect(hookWrite).not.toHaveBeenCalled()
})

it('does not acknowledge a refused detail observation as visible', async () => {
  await hello(); data(working); data(idle)
  vi.spyOn(terminals, 'visibility').mockResolvedValueOnce({ ok: false, error: { code: 'busy', message: 'This tool is busy. Try again shortly.' } })
  expect(await call({ op: 'observe-terminals', terminalIds: [terminalId] })).toMatchObject({ ok: false, error: { code: 'busy' } })
  expect(terminals.phoneRows()[0]!.state).toBe('just-finished')
})

it('withdraws phone visibility while eight terminal operations are pending and marks unseen completion', async () => {
  await hello()
  expect(await call({ op: 'observe-terminals', terminalIds: [terminalId] })).toMatchObject({ ok: true })
  let release!: () => void
  prepareHookGate = new Promise<void>(resolve => { release = resolve })
  const opening = terminals.open({ projectId: 'p', title: 'Held terminal', workingCopy: 'shared',
    launch: { provider: 'claude', modelId: null, reasoning: null, permission: 'ask' } })
  const reads: ReturnType<typeof terminals.read>[] = []
  try {
    await expect.poll(() => terminals.phoneRows().find(row => row.title === 'Held terminal')?.state).toBe('starting')
    const heldId = terminals.phoneRows().find(row => row.title === 'Held terminal')!.id
    for (let index = 0; index < 8; index++) reads.push(terminals.read({ id: heldId }))
    expect(await terminals.read({ id: terminalId })).toMatchObject({ ok: false, error: { code: 'busy' } })
    expect(await call({ op: 'observe-terminals', terminalIds: [] })).toMatchObject({ ok: true })
    data(working); data(idle)
    expect(terminals.phoneRows().find(row => row.id === terminalId)?.state).toBe('just-finished')
  } finally {
    release()
    await Promise.all([opening, ...reads])
  }
})

it('keeps the preview to eight active rows and refuses a removed phone before delivery', async () => {
  await hello(); request()
  data(screen('PRIVATE_TOP\r\n' + Array.from({ length: 20 }, (_, n) => `Context ${n}`).join('\r\n') + '\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend'))
  const response = await call({ op: 'terminal-approval', terminalId })
  const parsed = phoneTerminalApprovalSchema.parse(response.result)
  expect(parsed.lines).toHaveLength(8); expect(parsed.lines.join('\n')).not.toContain('PRIVATE_TOP')
  await pairing.revoke(clientId)
  expect(await terminals.answerPhoneApproval({ ...parsed, decision: 'allow' }, () => pairing.verifySession(session) === clientId)).toBe(false)
  expect(hookWrite).not.toHaveBeenCalled()
})

it('rejects shell input, persistent decisions and unknown answer fields at the wire boundary', () => {
  const base = { v: 1, id: 'command', session: 'session' }
  expect(hostRequestSchema.safeParse({ ...base, op: 'terminal-write', terminalId, data: 'yes\r' }).success).toBe(false)
  const answer = { terminalId, runId, requestId: 'request', approvalId: 'approval', previewId: 'a'.repeat(64), decision: 'allow' }
  expect(hostRequestSchema.safeParse({ ...base, op: 'answer-terminal', answer }).success).toBe(true)
  for (const change of [{ decision: 'always-allow' }, { updatedPermissions: [] }, { lines: ['yes'] }]) {
    expect(hostRequestSchema.safeParse({ ...base, op: 'answer-terminal', answer: { ...answer, ...change } }).success).toBe(false)
  }
})
