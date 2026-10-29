// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { HostConnectionError, SocketHostService } from '../../../src/main/agents/socketHostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { AgentCommand } from '../../../src/shared/agents'
import type { HostOperation } from '../../../src/shared/hostProtocol'

// The desktop's window confirms a merge, a close or an auto-merge itself; for a thread on a paired host, the router then asks
// that host for its confirmation receipt and sends the press with it, so the host runs it (#1691). Nothing else asks for one.

const REMOTE = '22222222-2222-4222-8222-222222222222'
const LOCAL = '44444444-4444-4444-8444-444444444444'
const URL = 'https://github.com/millZach/Sotto/pull/42'
const RECEIPT = '9e0c4d2a-6b1f-4c3e-8a5d-7f2b1c0e9d84'

function remote(features: string[], confirm: (operation: HostOperation) => unknown = () => ({ confirmation: RECEIPT, expiresAt: '2026-10-28T12:02:00.000Z' })) {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Badge', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [] }]
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
  const call = vi.fn(async (operation: HostOperation) => operation.op === 'pull-request-confirmation' ? confirm(operation)
    : operation.op === 'command' ? { ...state, error: null } : state)
  Object.assign(service, { cached: state, features, call })
  // As the desktop's host connections wire it (desktopHosts.ts).
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Forge', kind: 'remote', service, detail: async () => null, preview: () => null,
    confirmPullRequestAction: request => service.pullRequestConfirmation(request) }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection); router.select(REMOTE)
  const press = (fields: Record<string, unknown>) => ({ type: 'git-pull-request-action', threadId: hostEntityKey(REMOTE, 'thread'), url: URL, ...fields }) as AgentCommand
  const sent = () => call.mock.calls.map(([operation]) => operation).filter(operation => operation.op === 'pull-request-confirmation' || operation.op === 'command')
  return { router, press, sent }
}

describe('a merge, close or auto-merge on a paired host, from the window (#1691)', () => {
  it('asks the host for a receipt for exactly the confirmed press, then sends the press with it', async () => {
    const { router, press, sent } = remote(['pull-request-confirmation'])
    expect((await router.command(press({ action: 'merge', method: 'squash' }), desktopWindowClient())).error).toBeNull()
    expect(sent()).toEqual([
      { op: 'pull-request-confirmation', request: { threadId: 'thread', url: URL, action: 'merge', method: 'squash' } },
      { op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'merge', method: 'squash', confirmation: RECEIPT } },
    ])
    await router.command(press({ action: 'close' }), desktopWindowClient())
    expect(sent().slice(2)).toEqual([
      { op: 'pull-request-confirmation', request: { threadId: 'thread', url: URL, action: 'close' } },
      { op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'close', confirmation: RECEIPT } },
    ])
  })

  it('asks for none for a press that needs none, and sends a host from before receipts the press as before', async () => {
    const offered = remote(['pull-request-confirmation'])
    await offered.router.command(offered.press({ action: 'ready' }), desktopWindowClient())
    expect(offered.sent()).toEqual([{ op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'ready' } }])
    const older = remote([])
    await older.router.command(older.press({ action: 'enable-auto-merge', method: 'merge' }), desktopWindowClient())
    expect(older.sent()).toEqual([{ op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'enable-auto-merge', method: 'merge' } }])
  })

  it('never sends a receipt or a head the window named, only the one the host gave', async () => {
    const { router, press, sent } = remote(['pull-request-confirmation'])
    await router.command(press({ action: 'merge', method: 'rebase', confirmation: '11111111-1111-4111-8111-111111111111', matchHeadCommit: 'a'.repeat(40) }), desktopWindowClient())
    expect(sent().at(-1)).toEqual({ op: 'command', command: { type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'merge', method: 'rebase', confirmation: RECEIPT } })
  })

  it('says the host’s refusal of a receipt in its words, and sends no press', async () => {
    const words = 'This host has not read this pull request for this device since it started. Nothing was merged. Open the pull request again so Sotto reads it, then press Merge again.'
    const { router, press, sent } = remote(['pull-request-confirmation'], () => { throw new HostConnectionError(words, 'forbidden') })
    expect((await router.command(press({ action: 'merge', method: 'squash' }), desktopWindowClient())).error).toBe(words)
    expect(sent().map(operation => operation.op)).toEqual(['pull-request-confirmation'])
  })

  it('asks nothing for a thread on this computer, whose window’s confirmation is the confirmation', async () => {
    const state = emptyDesktopState(LOCAL)
    state.host.connected = true
    state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
    state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Badge', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [] }]
    const command = vi.fn(async () => ({ ...state, error: null }))
    const confirm = vi.fn(async () => RECEIPT)
    const router = new DesktopHostRouter(emptyDesktopState)
    router.add({ hostId: LOCAL, name: 'This computer', kind: 'local', service: { shell: () => state, command, subscribe: () => () => {} } as unknown as DesktopHostConnection['service'],
      detail: async () => null, preview: () => null, confirmPullRequestAction: confirm })
    router.select(LOCAL)
    await router.command({ type: 'git-pull-request-action', threadId: hostEntityKey(LOCAL, 'thread'), url: URL, action: 'merge', method: 'squash' }, desktopWindowClient())
    expect(confirm).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledWith({ type: 'git-pull-request-action', threadId: 'thread', url: URL, action: 'merge', method: 'squash' }, expect.anything())
  })
})
