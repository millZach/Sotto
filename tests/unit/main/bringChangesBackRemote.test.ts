// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { remoteCommandRefusal } from '../../../src/host/remoteCommands'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import { agentCommandSchema, type AgentCommand } from '../../../src/shared/agents'
import { protocolAgentStateSchema, type HostOperation } from '../../../src/shared/hostProtocol'
import { BRING_BACK_NO_TARGET, BRING_BACK_OFF, BRING_BACK_OTHER_DESKTOP, BRING_BACK_UNSUPPORTED, bringBackNotConnected, type BringBack } from '../../../src/shared/bringChangesBack'
import type { BranchMoveReceipt } from '../../../src/shared/branchMoves'

// Bringing changes back on a paired host (#1030): the host that holds both folders runs Git, a host without the feature
// is refused here in plain words and sent nothing, and the command carries nothing beyond its own fields.

const REMOTE = '22222222-2222-4222-8222-222222222222'
const actionId = '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b'

function remote(features: string[]) {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'child', projectId: 'project', title: 'Task', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [] }]
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
  const call = vi.fn(async (operation: HostOperation) => operation.op === 'command' ? { ...state, error: null } : state)
  Object.assign(service, { cached: state, features, call })
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Forge', kind: 'remote', service, detail: async () => null, preview: () => null }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection); router.select(REMOTE)
  const press: AgentCommand = { type: 'bring-changes-back', threadId: hostEntityKey(REMOTE, 'child'), actionId }
  return { router, call, service, press, state }
}

describe('bringing changes back on a paired host', () => {
  it('tells the user a host without it cannot yet, and sends it nothing', async () => {
    const { router, call, press, service } = remote([])
    expect(service.supportsBringBack).toBe(false)
    expect((await router.command(press, desktopWindowClient())).error).toBe(BRING_BACK_UNSUPPORTED)
    expect(call.mock.calls.some(([operation]) => operation.op === 'command')).toBe(false)
  })

  it('sends the press to the host that offers it, under the host’s own thread ID', async () => {
    const { router, call, press, service } = remote(['bring-changes-back'])
    expect(service.supportsBringBack).toBe(true)
    await router.command(press, desktopWindowClient())
    expect(call).toHaveBeenCalledWith({ op: 'command', command: { type: 'bring-changes-back', threadId: 'child', actionId } }, expect.any(String))
  })

  it('is on the paired-client list only where the listener offers it, with no field beyond its own', () => {
    const yes = { type: 'bring-changes-back', threadId: 'child', actionId, mergeCommit: actionId } as AgentCommand
    expect(agentCommandSchema.safeParse(yes).success).toBe(true)
    expect(remoteCommandRefusal(yes, { mayAnswer: true })).toBe('forbidden')
    // A press answers no permission, so a client without the answer policy may make it once the listener offers it.
    expect(remoteCommandRefusal(yes, { mayAnswer: false, bringBack: true })).toBeNull()
    expect(remoteCommandRefusal({ ...yes, force: true } as unknown as AgentCommand, { mayAnswer: true, bringBack: true })).toBe('forbidden')
    expect(agentCommandSchema.safeParse({ ...yes, target: 'main' }).success).toBe(false)
  })
})

// A press refused because another thread's work holds the folder where the target is checked out (#1866): the host names
// that thread by its own ID, and the window, which keys threads by host, finds it under the same key.
describe('a hold another thread caused, on a paired host', () => {
  const refused = (over: Partial<BringBack> = {}): BringBack => ({ actionId, status: 'refused', target: 'main', branch: 'sotto/task', refusal: 'busy', checkedOut: 'project',
    message: 'Thread "Docs" is waiting for your answer. Nothing was brought back. Answer it, then try again.', heldBy: 'docs', at: '2026-10-30T00:00:00.000Z', ...over })
  /** The child's record as the window reads it, once the host's shell has come off the wire with it and the holder beside it. */
  function windowRecord(record: BringBack): BringBack | undefined {
    const { router, service, state } = remote(['bring-changes-back'])
    const child = state.host.threads[0]!
    const wire = protocolAgentStateSchema.parse({ ...state, host: { ...state.host, threads: [{ ...child, bringBack: record }, { ...child, id: 'docs', title: 'Docs' }] } })
    Object.assign(service, { cached: wire })
    try { return router.shell().host.threads.find(thread => thread.id === hostEntityKey(REMOTE, 'child'))?.bringBack } finally { router.dispose() }
  }

  it('names the thread holding the folder by this window’s key, and its words as the host wrote them', () => {
    expect(windowRecord(refused())).toEqual({ ...refused(), heldBy: hostEntityKey(REMOTE, 'docs') })
  })

  it('keeps an older host’s refusal, which names no thread, as it was', () => {
    const { heldBy: _named, ...older } = refused({ message: 'Thread "Docs" is waiting for your answer. Nothing was changed. Answer it, then try again.' })
    void _named
    expect(windowRecord(older)).toEqual(older)
  })
})

// A child on another machine than the thread it began from (#1030): the desktop moves the child's branch to that machine
// first, then sends the press there for the thread it began from, naming the move. Nothing reaches either host otherwise.
const MAC = '33333333-3333-4333-8333-333333333333'
// The desktop the press is made on, by its own computer's host ID, which started the worker unless a case says otherwise.
const HERE = '55555555-5555-4555-8555-555555555555', OTHER_DESKTOP = '66666666-6666-4666-8666-666666666666'
const MOVED = '4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d'
function acrossMachines(options: { macFeatures?: string[]; childStatus?: 'idle' | 'running'; moves?: boolean; moved?: BranchMoveReceipt; macConnected?: boolean; startedBy?: string | null } = {}) {
  const host = (hostId: string, name: string, features: string[], threads: unknown[], kind: 'local' | 'remote' = 'remote') => {
    const state = emptyDesktopState(hostId)
    state.host.connected = true; state.connection = 'connected'
    state.host.projects = [{ id: `${name}-project`, title: 'Project', path: '/repo' }]
    state.host.threads = threads as typeof state.host.threads
    const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
    const call = vi.fn(async (operation: HostOperation) => operation.op === 'command' ? { ...state, error: null } : state)
    Object.assign(service, { cached: state, features, call })
    const connection: DesktopHostConnection = { hostId, name, kind, service, detail: async () => null, preview: () => null }
    return { connection, call }
  }
  const forge = host(REMOTE, 'Forge', ['bring-changes-back'], [{ id: 'child', projectId: 'Forge-project', title: 'Task', modelId: '', providerId: 'codex', status: options.childStatus ?? 'idle', messages: [], requests: [],
    worktree: { mode: 'independent', status: 'ready', path: '/repo/.sotto/child', branch: 'feat/x-2', incomingRef: `refs/sotto/incoming/${MOVED}/feat/x`, madeFrom: { thread: 'parent', host: MAC, ...options.startedBy === null ? {} : { by: options.startedBy ?? HERE } } } }])
  const mac = host(MAC, 'Mac', options.macFeatures ?? ['bring-changes-back'], [{ id: 'parent', projectId: 'Mac-project', title: 'Parent', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [],
    worktree: { mode: 'shared', status: 'ready', branch: 'feat/x' } }])
  const local = host(HERE, 'This computer', [], [], 'local')
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(local.connection)
  router.add(forge.connection)
  if (options.macConnected !== false) router.add(mac.connection)
  router.select(REMOTE)
  const forStart = vi.fn(async (input: { readonly moveId: string }): Promise<BranchMoveReceipt> => options.moved
    ?? { type: 'moved', moveId: input.moveId, branch: 'feat/x-2', commit: 'a'.repeat(40), ref: `refs/sotto/incoming/${input.moveId}/feat/x-2` })
  if (options.moves !== false) router.useBranchMoves({ forStart })
  const press: AgentCommand = { type: 'bring-changes-back', threadId: hostEntityKey(REMOTE, 'child'), actionId }
  return { router, forge, mac, forStart, press }
}
const sent = (call: ReturnType<typeof vi.fn>): unknown[][] => call.mock.calls.filter(([operation]) => (operation as HostOperation).op === 'command')

describe('bringing changes back from a child on another machine', () => {
  it('moves the child’s branch to the parent’s machine, then asks that host to bring it to the parent’s branch', async () => {
    const { router, forge, mac, forStart, press } = acrossMachines()
    expect((await router.command(press, desktopWindowClient())).error ?? null).toBeNull()
    expect(forStart).toHaveBeenCalledWith(expect.objectContaining({ from: { hostId: REMOTE, threadId: 'child' }, to: { hostId: MAC, projectId: 'Mac-project' }, snapshot: false }))
    const moveId = forStart.mock.calls[0]![0].moveId
    expect(sent(mac.call)).toEqual([[{ op: 'command', command: { type: 'bring-changes-back', threadId: 'parent', actionId,
      away: { moveId, from: hostEntityKey(REMOTE, 'child'), target: 'feat/x' } } }, expect.any(String)]])
    expect(sent(forge.call)).toEqual([])
  })

  it('carries a yes to the merge-commit question to the parent’s machine with a fresh move', async () => {
    const { router, mac, forStart, press } = acrossMachines()
    await router.command({ ...press, mergeCommit: actionId } as AgentCommand, desktopWindowClient())
    expect(forStart).toHaveBeenCalledTimes(1)
    expect(sent(mac.call)[0]![0]).toMatchObject({ command: { mergeCommit: actionId, away: { target: 'feat/x' } } })
  })

  it('says in bring-back’s words when the child has uncommitted work, and sends the parent’s machine nothing', async () => {
    const { router, mac, press } = acrossMachines({ moved: { type: 'refused', reason: 'uncommitted', message: 'This thread has uncommitted changes. Commit them first, then move the branch. Nothing was moved.' } })
    expect((await router.command(press, desktopWindowClient())).error)
      .toBe('Nothing was brought to feat/x. feat/x-2 has uncommitted changes, and Sotto won’t bring back uncommitted work. Commit them first, then try again.')
    expect(sent(mac.call)).toEqual([])
  })

  it.each([
    ['the parent’s machine is not connected', { macConnected: false }, bringBackNotConnected('The machine it began on')],
    ['the parent’s machine predates it', { macFeatures: [] }, BRING_BACK_UNSUPPORTED],
    ['Work across machines is off, so nothing moves branches', { moves: false }, BRING_BACK_OFF],
    ['the child is working', { childStatus: 'running' as const }, 'Wait for this thread to finish its turn, then bring its changes back. Nothing changed.'],
    ['another desktop started the worker', { startedBy: OTHER_DESKTOP }, BRING_BACK_OTHER_DESKTOP],
    ['the worker’s record does not say which desktop started it', { startedBy: null }, BRING_BACK_OTHER_DESKTOP],
  ])('refuses when %s, and moves nothing', async (_name, options, words) => {
    const { router, forge, mac, forStart, press } = acrossMachines(options)
    expect((await router.command(press, desktopWindowClient())).error).toBe(words)
    expect(forStart).not.toHaveBeenCalled()
    expect([...sent(forge.call), ...sent(mac.call)]).toEqual([])
  })

  it('never takes a move named by the window', async () => {
    const { router, forStart, press, mac, forge } = acrossMachines()
    const named = { ...press, away: { moveId: MOVED, from: 'x', target: 'feat/x' } } as AgentCommand
    expect((await router.command(named, desktopWindowClient())).error).toBe(BRING_BACK_NO_TARGET)
    expect(forStart).not.toHaveBeenCalled()
    expect([...sent(forge.call), ...sent(mac.call)]).toEqual([])
  })

  it('takes away only from a client the host recorded as a desktop', () => {
    const away = { type: 'bring-changes-back', threadId: 'parent', actionId, away: { moveId: MOVED, from: 'x', target: 'main' } } as AgentCommand
    expect(agentCommandSchema.safeParse(away).success).toBe(true)
    expect(remoteCommandRefusal(away, { mayAnswer: false, bringBack: true })).toBe('forbidden')
    expect(remoteCommandRefusal(away, { mayAnswer: false, bringBack: true, desktop: true })).toBeNull()
  })
})
