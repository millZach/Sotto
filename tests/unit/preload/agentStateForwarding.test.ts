// @vitest-environment node
import { preloadElectron } from '../../fixtures/preloadElectron'
import { threadsStateFixture } from '../../fixtures/agentState'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
import { createSottoWidgetBridge } from '../../../src/preload'
import { AGENT_STATE, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentState } from '../../../src/shared/agents'

const state: AgentState = threadsStateFixture({ cloneOverrides: false,
    configuration: defaultAgentConfiguration(),
    host: { ...EMPTY_AGENT_HOST, hostId: 'aaaaaaaa-0000-4000-8000-000000000000' },
    topLevel: { assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draftAttachments: [], credentials: { reasoning: false, grokSpeech: false, secure: false } } })

describe('agent state broadcast forwarding', () => {
  it('forwards a broadcast raw, without reassembling an omitted catalog itself', () => {
    const ipc = preloadElectron().ipcRenderer
    const bridge = createSottoWidgetBridge(ipc, 'win32').agents!
    const listener = vi.fn()
    bridge.onState(listener)
    const handler = ipc.on.mock.calls.find(([channel]) => channel === AGENT_STATE)![1] as (event: unknown, ...args: unknown[]) => void
    // A repeat the broadcaster omitted: `host.models` is a revision marker, not an array of models.
    const broadcast = { ...state, host: { ...state.host, models: { revision: 3, omitted: true } } }
    handler({}, broadcast)
    // The preload no longer puts the catalog back together: contextBridge would have to copy the
    // reassembled array a second time crossing back to the page, undoing most of what omitting it saved.
    // Reassembly now happens in the page; see src/renderer/src/agents/agentStateCatalogs.ts.
    expect(listener).toHaveBeenCalledWith(broadcast)
  })
})

describe('agent command receipt parsing', () => {
  it('accepts a receipt that names its catalog by revision and leaves putting it back to the page', async () => {
    const receipt = { ...state, host: { ...state.host, models: { revision: 3, omitted: true } } }
    const ipc = ({ ...preloadElectron().ipcRenderer, invoke: vi.fn(async () => receipt) })
    const bridge = createSottoWidgetBridge(ipc, 'win32').agents!
    await expect(bridge.command({ type: 'voice', action: 'mute' })).resolves.toMatchObject({ host: { models: { revision: 3, omitted: true } } })
  })

  it('refuses a receipt whose catalog is anything but a revision, a whole list included', async () => {
    for (const models of [{ revision: 3 }, []]) {
      const receipt = { ...state, host: { ...state.host, models } }
      const ipc = ({ ...preloadElectron().ipcRenderer, invoke: vi.fn(async () => receipt) })
      const bridge = createSottoWidgetBridge(ipc, 'win32').agents!
      await expect(bridge.command({ type: 'voice', action: 'mute' })).rejects.toThrow()
    }
  })
})
