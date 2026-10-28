// @vitest-environment node
// #1316 part 3 (Owl `cross-machine-work`): the window's Stop, Settle and Restore of a thread reach the threads it delegated
// to on other machines, and Stop says which working ones it could not reach, naming each machine.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { CascadedSettles, SETTLE_CASCADE_SKEW_MS, settledWithParent, stopUnreachedWords } from '../../../src/main/hosts/crossMachineCascade'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { AgentCommand, AgentThread } from '../../../src/shared/agents'
import type { StopLeft } from '../../../src/main/agents/delegationRelayHost'

const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const SETTLED_AT = '2026-10-28T10:00:00.000Z'

/**
 * A host with these threads. Given `stamp`, its Settle and Restore move a thread as the host's own would, settling it at its
 * own clock's time; without, they change nothing.
 */
function host(hostId: string, kind: 'local' | 'remote', name: string, threads: Partial<AgentThread>[], stamp?: () => string) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = threads.map(thread => ({ projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [], requests: [], id: 'thread', ...thread }) as AgentThread)
  const command = vi.fn(async (input: AgentCommand) => {
    if (stamp && (input.type === 'settle-thread' || input.type === 'restore-thread')) state.host.threads = state.host.threads.map(thread => thread.id !== input.threadId ? thread
      : { ...thread, workspaceSettledAt: input.type === 'settle-thread' ? thread.workspaceSettledAt ?? stamp() : null })
    return state
  })
  let available = true
  const connection: DesktopHostConnection = { hostId, name, kind, available: () => available, ...kind === 'remote' ? { clientId: 'desktop-a' } : {},
    service: { shell: () => state, subscribe: () => () => undefined, command }, detail: async threadId => ({ threadId, revision: 1, messages: [] }), observe: async () => undefined, preview: () => null }
  return { state, command, connection, away: () => { available = false }, back: () => { available = true } }
}
/** A thread on this computer that delegated a check to forge, which delegated in turn to the Mac through the relay. */
function machines(crossMachineWork = true, parent: Partial<AgentThread> = {}, children: { forge?: Partial<AgentThread>; mac?: Partial<AgentThread> } = {},
  options: ConstructorParameters<typeof DesktopHostRouter>[1] = {}, stamps: { local?: () => string; forge?: () => string; mac?: () => string } = {}) {
  const router = new DesktopHostRouter(emptyDesktopState, { crossMachineWork, ...options })
  const local = host(LOCAL, 'local', 'This computer', [{ id: 'parent', status: 'running', ...parent }], stamps.local)
  const forge = host(FORGE, 'remote', 'forge', [{ id: 'check', status: 'running', delegatedBy: 'relay:desktop-a:parent', ...children.forge }], stamps.forge)
  const mac = host(MAC, 'remote', 'the Mac', [{ id: 'mac-check', status: 'running', delegatedBy: `relay:desktop-a:${hostEntityKey(FORGE, 'check')}`, ...children.mac }], stamps.mac)
  for (const item of [local, forge, mac]) router.add(item.connection)
  return { router, local, forge, mac }
}
const parentKey = hostEntityKey(LOCAL, 'parent')

describe('Stop, Settle and Restore across machines', () => {
  it('names each machine it could not reach, with how many working threads it left there', async () => {
    const { router, forge, mac } = machines()
    try {
      // Every machine connected: delegation stops them there, and the window says nothing more.
      expect((await router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())).error).toBeNull()
      forge.away(); mac.away()
      const result = await router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())
      expect(result.error).toBe('Sotto couldn\'t stop 1 delegated thread on forge, because forge isn\'t connected. Sotto couldn\'t stop 1 delegated thread on the Mac, because the Mac isn\'t connected. '
        + 'They may still be working there. Open them from Tools › Agents and stop them once their machine is back.')
      // The window's Stop goes to the thread's own machine alone; delegation reaches the rest.
      expect(forge.command).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  it('keys each child under the thread that delegated to it, on whichever machine, only for this desktop\'s own callers', () => {
    const { router } = machines()
    try {
      expect(router.get().host.threads.map(thread => [thread.id, thread.delegatedBy])).toEqual([[parentKey, undefined],
        [hostEntityKey(FORGE, 'check'), parentKey], [hostEntityKey(MAC, 'mac-check'), hostEntityKey(FORGE, 'check')]])
    } finally { router.dispose() }
    // Another desktop's thread of the same ID is not this one's: its child stays keyed under its own host.
    const other = machines(true, {}, { forge: { delegatedBy: 'relay:desktop-b:parent' } })
    try {
      expect(other.router.get().host.threads.find(thread => thread.id === hostEntityKey(FORGE, 'check'))?.delegatedBy).toBe(hostEntityKey(FORGE, 'relay:desktop-b:parent'))
    } finally { other.router.dispose() }
  })

  it('says, once the cancels answer, which delegated threads it did not see stop, by machine', async () => {
    let answer: (left: StopLeft[]) => void = () => undefined
    const stopsLeft = vi.fn((_threadId: string) => { void _threadId; return new Promise<readonly StopLeft[]>(resolve => { answer = resolve }) })
    const { router, forge, mac } = machines(true, {}, {}, { stopsLeft })
    try {
      mac.away()
      const unreached = 'Sotto couldn\'t stop 1 delegated thread on the Mac, because the Mac isn\'t connected. It may still be working there. Open it from Tools › Agents and stop it once its machine is back.'
      // What the window already knows is said at once; the thread's own delegation is asked what its cancels left.
      expect((await router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())).error).toBe(unreached)
      expect(stopsLeft).toHaveBeenCalledWith('parent')
      const published: (string | null | undefined)[] = []
      router.subscribe(state => { published.push(state.error) })
      // Forge's cancel went, but its answer was lost as forge dropped: it may have stopped, so it is not said to be unreached.
      // The Mac's thread is counted once.
      forge.away()
      answer([{ machine: 'forge', hostId: FORGE, thread: 'check', reason: 'unconfirmed' }, { machine: 'the Mac', hostId: MAC, thread: 'mac-check', reason: 'away' }])
      await vi.waitFor(() => expect(published).toHaveLength(1))
      expect(published[0]).toBe(`${unreached} Sotto couldn't confirm that 1 delegated thread on forge stopped. It may still be working there. Open it from Tools › Agents to see where it stands.`)
      expect(forge.command).not.toHaveBeenCalled()
    } finally { router.dispose() }
    // A Stop whose cancels all answered says nothing more; a thread on another machine's Stop is that machine's to account for.
    const quiet = machines(true, {}, {}, { stopsLeft: () => Promise.resolve([]) })
    try {
      expect((await quiet.router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())).error).toBeNull()
      const asked = vi.fn(() => Promise.resolve([]))
      const elsewhere = machines(true, {}, {}, { stopsLeft: asked })
      try {
        await elsewhere.router.command({ type: 'interrupt', threadId: hostEntityKey(FORGE, 'check') }, desktopWindowClient())
        expect(asked).not.toHaveBeenCalled()
      } finally { elsewhere.router.dispose() }
    } finally { quiet.router.dispose() }
  })

  it('says nothing of a thread that was not working when last read', async () => {
    const { router, forge } = machines(true, {}, { forge: { status: 'idle' }, mac: { status: 'idle' } })
    try {
      forge.away()
      expect((await router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())).error).toBeNull()
    } finally { router.dispose() }
  })

  it('settles the open ones on their own machines as the thread goes from open to settled, and restores those settled with it', async () => {
    const { router, forge, mac } = machines()
    try {
      await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'check' }, desktopWindowClient())
      expect(mac.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'mac-check' }, desktopWindowClient())
    } finally { router.dispose() }
    // Restoring it restores the one its settle settled, a few seconds apart on forge's clock. The Mac's thread was settled on
    // its own a minute before, within the clocks' skew, so the settle left it and the restore does too.
    const clocks = { local: () => SETTLED_AT, forge: () => '2026-10-28T10:00:03.000Z', mac: () => '2026-10-28T10:00:05.000Z' }
    const settled = machines(true, { status: 'idle' }, { mac: { workspaceSettledAt: '2026-10-28T09:59:00.000Z' } }, {}, clocks)
    try {
      await settled.router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(settled.forge.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'check' }, desktopWindowClient())
      expect(settled.mac.command).not.toHaveBeenCalled()
      // Settling one already settled moves none of them, as on one machine.
      await settled.router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(settled.forge.command).toHaveBeenCalledTimes(1)
      await settled.router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
      expect(settled.forge.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'check' }, desktopWindowClient())
      expect(settled.mac.command).not.toHaveBeenCalled()
      expect(settled.router.get().error).toBeNull()
    } finally { settled.router.dispose() }
  })

  it('restores one its settle settled only while it is still settled with it', async () => {
    let forgeClock = '2026-10-28T10:00:03.000Z'
    const { router, forge } = machines(true, { status: 'idle' }, {}, {}, { local: () => SETTLED_AT, forge: () => forgeClock, mac: () => SETTLED_AT })
    try {
      await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      // The user restored forge's thread, then settled it on its own an hour later: it keeps its own settle.
      forge.state.host.threads = forge.state.host.threads.map(thread => ({ ...thread, workspaceSettledAt: null }))
      forgeClock = '2026-10-28T11:00:00.000Z'
      await forge.connection.service.command({ type: 'settle-thread', threadId: 'check' }, desktopWindowClient())
      forge.command.mockClear()
      await router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  it('says which it could not settle, settles them with a later Settle, and restores them with the rest', async () => {
    const clocks = { local: () => SETTLED_AT, forge: () => '2026-10-28T10:00:40.000Z', mac: () => '2026-10-28T10:00:02.000Z' }
    const { router, forge, mac } = machines(true, { status: 'idle' }, {}, {}, clocks)
    try {
      forge.away()
      expect((await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())).error)
        .toBe('Sotto couldn\'t settle 1 delegated thread on forge. Open it from Tools › Agents to settle it yourself.')
      expect(mac.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'mac-check' }, desktopWindowClient())
      expect(forge.command).not.toHaveBeenCalled()
      // Forge is back. Settle on the settled thread settles what the first one left open there, and nothing else again.
      forge.back()
      expect((await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())).error).toBeNull()
      expect(forge.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'check' }, desktopWindowClient())
      expect(mac.command).toHaveBeenCalledTimes(1)
      await router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'check' }, desktopWindowClient())
      expect(mac.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'mac-check' }, desktopWindowClient())
    } finally { router.dispose() }
  })

  it('says which it could not restore', async () => {
    const { router, mac } = machines(true, { status: 'idle' }, {}, {}, { local: () => SETTLED_AT, forge: () => SETTLED_AT, mac: () => SETTLED_AT })
    try {
      await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      mac.away()
      expect((await router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())).error)
        .toBe('Sotto couldn\'t restore 1 delegated thread on the Mac. Open it from Tools › Agents to restore it yourself.')
    } finally { router.dispose() }
  })

  it('keeps which it settled for a Restore after Sotto restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-cascade-unit-'))
    try {
      const clocks = { local: () => SETTLED_AT, forge: () => SETTLED_AT, mac: () => SETTLED_AT }
      const before = new CascadedSettles(directory)
      await before.load()
      const first = machines(true, { status: 'idle' }, {}, { cascadedSettles: before }, clocks)
      await first.router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      first.router.dispose()
      const after = new CascadedSettles(directory)
      await after.load()
      expect([...after.of(parentKey)?.settled ?? []].sort()).toEqual([hostEntityKey(FORGE, 'check'), hostEntityKey(MAC, 'mac-check')])
      // The restarted window's Restore finds them, here with the threads as the first window left them.
      const second = machines(true, { status: 'idle', workspaceSettledAt: SETTLED_AT }, { forge: { workspaceSettledAt: SETTLED_AT }, mac: { workspaceSettledAt: SETTLED_AT } }, { cascadedSettles: after }, clocks)
      try {
        await second.router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
        expect(second.forge.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'check' }, desktopWindowClient())
        expect(after.of(parentKey)).toBeUndefined()
      } finally { second.router.dispose() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('settles and restores a thread back on this computer that a thread on forge delegated to for it', async () => {
    // This computer's thread delegated a check to forge, which delegated a fix back to this computer: this computer's own
    // settle does not reach the fix, since its link runs through forge, and forge's does not either.
    const router = new DesktopHostRouter(emptyDesktopState, { crossMachineWork: true })
    const local = host(LOCAL, 'local', 'This computer', [{ id: 'parent' }, { id: 'fix', delegatedBy: hostEntityKey(FORGE, 'check') }, { id: 'own', delegatedBy: 'parent' }],
      () => SETTLED_AT)
    const forge = host(FORGE, 'remote', 'forge', [{ id: 'check', delegatedBy: 'relay:desktop-a:parent' }], () => '2026-10-28T10:00:04.000Z')
    for (const item of [local, forge]) router.add(item.connection)
    try {
      await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'check' }, desktopWindowClient())
      expect(local.command).toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'fix' }, desktopWindowClient())
      // A thread this computer's own thread delegated here is this computer's settle's to move, not the window's.
      expect(local.command).not.toHaveBeenCalledWith({ type: 'settle-thread', threadId: 'own' }, desktopWindowClient())
      await router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'check' }, desktopWindowClient())
      expect(local.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'fix' }, desktopWindowClient())
      expect(local.state.host.threads.find(thread => thread.id === 'fix')?.workspaceSettledAt).toBeNull()
    } finally { router.dispose() }
  })

  it('does none of it in stable', async () => {
    const { router, forge, mac } = machines(false)
    try {
      // Saved Owl links are kept as they are and keyed by their own host, as before: each child keeps its own row.
      const links = router.get().host.threads.map(thread => [thread.id, thread.delegatedBy])
      expect(links).toEqual([[parentKey, undefined], [hostEntityKey(FORGE, 'check'), hostEntityKey(FORGE, 'relay:desktop-a:parent')],
        [hostEntityKey(MAC, 'mac-check'), hostEntityKey(MAC, `relay:desktop-a:${hostEntityKey(FORGE, 'check')}`)]])
      expect(forge.state.host.threads[0]!.delegatedBy).toBe('relay:desktop-a:parent')
      forge.away(); mac.away()
      expect((await router.command({ type: 'interrupt', threadId: parentKey }, desktopWindowClient())).error).toBeNull()
      await router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(forge.command).not.toHaveBeenCalled()
    } finally { router.dispose() }
  })

  it('words one thread on one machine, and allows the two clocks a little skew', () => {
    expect(stopUnreachedWords([{ name: 'forge', count: 1 }])).toBe('Sotto couldn\'t stop 1 delegated thread on forge, because forge isn\'t connected. '
      + 'It may still be working there. Open it from Tools › Agents and stop it once its machine is back.')
    expect(stopUnreachedWords([{ name: 'forge', count: 3 }])).toMatch(/^Sotto couldn't stop 3 delegated threads on forge/u)
    expect(settledWithParent(SETTLED_AT, new Date(Date.parse(SETTLED_AT) - SETTLE_CASCADE_SKEW_MS).toISOString())).toBe(true)
    expect(settledWithParent(SETTLED_AT, new Date(Date.parse(SETTLED_AT) + SETTLE_CASCADE_SKEW_MS + 1).toISOString())).toBe(false)
    expect(settledWithParent(null, SETTLED_AT)).toBe(false)
  })
})
