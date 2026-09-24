// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoWidgetBridge } from '../../../src/preload'
import { AGENT_STATE, defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentState } from '../../../src/shared/agents'

const state: AgentState = {
  configuration: defaultAgentConfiguration(), connection: 'connected',
  host: { ...EMPTY_AGENT_HOST, hostId: 'aaaaaaaa-0000-4000-8000-000000000000' },
  assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false,
  draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [], pendingRequest: '',
  globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
  voice: { status: 'off', error: null, action: 'none', revision: 0 },
  credentials: { reasoning: false, grokSpeech: false, secure: false },
  reasoningAccounts: [], membership: { status: 'active', label: 'Sotto', expiresAt: null },
}

describe('agent state broadcast forwarding', () => {
  it('forwards a broadcast raw, without reassembling an omitted catalog itself', () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
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
