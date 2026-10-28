// @vitest-environment node
// #1316 part 3 (Owl `cross-machine-work`): the window's Stop, Settle and Restore of a thread reach the threads it delegated
// to on other machines, and Stop says which working ones it could not reach, naming each machine.
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { SETTLE_CASCADE_SKEW_MS, settledWithParent, stopUnreachedWords } from '../../../src/main/hosts/crossMachineCascade'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { AgentCommand, AgentThread } from '../../../src/shared/agents'

const LOCAL = '11111111-1111-4111-8111-111111111111', FORGE = '22222222-2222-4222-8222-222222222222', MAC = '33333333-3333-4333-8333-333333333333'
const SETTLED_AT = '2026-10-28T10:00:00.000Z'

function host(hostId: string, kind: 'local' | 'remote', name: string, threads: Partial<AgentThread>[]) {
  const state = emptyDesktopState(hostId)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = threads.map(thread => ({ projectId: 'project', title: 'Task', modelId: '', status: 'idle', messages: [], requests: [], id: 'thread', ...thread }) as AgentThread)
  const command = vi.fn(async (_input: AgentCommand) => { void _input; return state })
  let available = true
  const connection: DesktopHostConnection = { hostId, name, kind, available: () => available,
    service: { shell: () => state, subscribe: () => () => undefined, command }, detail: async threadId => ({ threadId, revision: 1, messages: [] }), observe: async () => undefined, preview: () => null }
  return { state, command, connection, away: () => { available = false } }
}
/** A thread on this computer that delegated a check to forge, which delegated in turn to the Mac through the relay. */
function machines(crossMachineWork = true, parent: Partial<AgentThread> = {}, children: { forge?: Partial<AgentThread>; mac?: Partial<AgentThread> } = {}) {
  const router = new DesktopHostRouter(emptyDesktopState, { crossMachineWork })
  const local = host(LOCAL, 'local', 'This computer', [{ id: 'parent', status: 'running', ...parent }])
  const forge = host(FORGE, 'remote', 'forge', [{ id: 'check', status: 'running', delegatedBy: 'relay:desktop-a:parent', ...children.forge }])
  const mac = host(MAC, 'remote', 'the Mac', [{ id: 'mac-check', status: 'running', delegatedBy: `relay:desktop-a:${hostEntityKey(FORGE, 'check')}`, ...children.mac }])
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
    // Restoring it restores the one its settle settled, a few seconds apart on forge's clock, and not one settled by itself later.
    const settled = machines(true, { workspaceSettledAt: SETTLED_AT, status: 'idle' }, { forge: { workspaceSettledAt: '2026-10-28T10:00:03.000Z' }, mac: { workspaceSettledAt: '2026-10-28T11:00:00.000Z' } })
    try {
      await settled.router.command({ type: 'restore-thread', threadId: parentKey }, desktopWindowClient())
      expect(settled.forge.command).toHaveBeenCalledWith({ type: 'restore-thread', threadId: 'check' }, desktopWindowClient())
      expect(settled.mac.command).not.toHaveBeenCalled()
      // Settling one already settled moves none of them, as on one machine.
      await settled.router.command({ type: 'settle-thread', threadId: parentKey }, desktopWindowClient())
      expect(settled.forge.command).toHaveBeenCalledTimes(1)
    } finally { settled.router.dispose() }
  })

  it('does none of it in stable', async () => {
    const { router, forge, mac } = machines(false)
    try {
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
