// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DesktopHostRouter, type DesktopHostConnection } from '../../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../../src/main/hosts/inactiveLocalHost'
import { desktopWindowClient } from '../../../src/main/agents/hostService'
import { SocketHostService } from '../../../src/main/agents/socketHostService'
import { hostEntityKey } from '../../../src/shared/clientIdentity'
import type { AgentCommand } from '../../../src/shared/agents'
import type { HostOperation } from '../../../src/shared/hostProtocol'
import { AGENT_FORK_GONE } from '../../../src/shared/threadStarts'

// Continuing an agent on a paired host (#1028): the host's own feature says it can, an older host is refused here in
// plain words, and a refusal answers the command alone rather than the window's banner.

const REMOTE = '22222222-2222-4222-8222-222222222222'
const newThreadId = '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b'

function remote(features: string[], answer: string | null = null) {
  const state = emptyDesktopState(REMOTE)
  state.host.connected = true; state.connection = 'connected'
  state.host.projects = [{ id: 'project', title: 'Project', path: '/repo' }]
  state.host.threads = [{ id: 'thread', projectId: 'project', title: 'Task', modelId: '', providerId: 'codex', status: 'idle', messages: [], requests: [] }]
  const service = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', catchUpEvents: false })
  const call = vi.fn(async (operation: HostOperation) => {
    if (operation.op === 'start-handover') return { handover: { text: 'The handover words.' } }
    if (operation.op === 'command') return { ...state, error: answer }
    return state
  })
  Object.assign(service, { cached: state, features, call })
  const connection: DesktopHostConnection = { hostId: REMOTE, name: 'Forge', kind: 'remote', service, detail: async () => null, preview: () => null }
  const router = new DesktopHostRouter(emptyDesktopState)
  router.add(connection); router.select(REMOTE)
  const continueAgent: AgentCommand = { type: 'continue-agent', threadId: hostEntityKey(REMOTE, 'thread'), agentId: 'codex-agent-1', newThreadId }
  return { router, call, service, continueAgent }
}

describe('continuing an agent on a paired host', () => {
  it('tells the user an older host cannot yet, and sends it nothing', async () => {
    const { router, call, continueAgent } = remote([])
    const answer = await router.command(continueAgent, desktopWindowClient())
    expect(answer.error).toBe('This host can’t continue an agent as a thread yet, and nothing was made. Update Sotto on the host, then try again.')
    expect(call.mock.calls.some(([operation]) => operation.op === 'command')).toBe(false)
    expect(router.shell().error).toBeNull()
    await expect(router.startHandover(hostEntityKey(REMOTE, 'thread'))).rejects.toThrow('can’t continue an agent as a thread yet')
  })

  it('sends the command to a host that offers it, under the host’s own IDs, and keeps its refusal off the banner', async () => {
    const { router, call, continueAgent } = remote(['thread-starts'], AGENT_FORK_GONE)
    const answer = await router.command(continueAgent, desktopWindowClient())
    expect(call).toHaveBeenCalledWith({ op: 'command', command: { type: 'continue-agent', threadId: 'thread', agentId: 'codex-agent-1', newThreadId } }, expect.any(String))
    expect(answer.error).toBe(AGENT_FORK_GONE)
    expect(router.shell().error).toBeNull()
  })

  it('reads a started thread’s handover on its host only when the host offers it', async () => {
    const { router, call, service } = remote(['thread-starts'])
    expect(service.supportsThreadStarts).toBe(true)
    expect(await router.startHandover(hostEntityKey(REMOTE, 'thread'))).toEqual({ text: 'The handover words.' })
    expect(call).toHaveBeenCalledWith({ op: 'start-handover', threadId: 'thread' })
    const older = remote([])
    expect(older.service.supportsThreadStarts).toBe(false)
    await expect(older.service.startHandover('thread')).rejects.toThrow()
  })
})
