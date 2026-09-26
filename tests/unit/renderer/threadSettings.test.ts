import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { CONFIRMED_HOLD_MS, ThreadSettingsStore, type SendThreadSettings, type ThreadSettingValues } from '../../../src/renderer/src/agents/threadSettings'

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function state(thread: Partial<AgentThread> = {}, error: string | null = null): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      models: [{ id: 'model', name: 'Model', provider: 'Codex', providerId: 'codex', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', runtimeModes: ['approval-required', 'full-access'] }],
      threads: [{ id: 'thread', providerId: 'codex', projectId: 'project', title: 'Work', modelId: 'model', status: 'idle', messages: [], requests: [], runtimeMode: 'approval-required', ...thread }] },
    assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
  }
}
const drawn = (permissions: string): ThreadSettingValues => ({ model: 'model', effort: 'low', permissions })
const settle = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }

afterEach(() => { vi.useRealTimers() })

describe('thread settings store', () => {
  it('holds a press per thread, whichever chip is on screen, until the window draws the answer', async () => {
    const store = new ThreadSettingsStore()
    const send: SendThreadSettings = vi.fn(async () => state({ runtimeMode: 'full-access' }))
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, send, drawn('approval-required'))
    expect(store.view('thread').pending.permissions).toEqual({ value: 'full-access', awaiting: 'provider' })
    expect(store.view('other')).toEqual({ pending: {}, refusal: null })
    await settle()
    // Answered, not yet drawn.
    expect(store.view('thread').pending.permissions).toEqual({ value: 'full-access', awaiting: 'window' })
    store.observe('thread', drawn('approval-required'))
    expect(store.view('thread').pending.permissions?.value).toBe('full-access')
    store.observe('thread', drawn('full-access'))
    expect(store.view('thread').pending).toEqual({})
  })

  it('lets go of a confirmed press the window never draws after a while, and shows what the thread reports', async () => {
    vi.useFakeTimers()
    const store = new ThreadSettingsStore()
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => state({ runtimeMode: 'full-access' }), drawn('approval-required'))
    await settle()
    expect(store.view('thread').pending.permissions?.awaiting).toBe('window')
    vi.advanceTimersByTime(CONFIRMED_HOLD_MS)
    expect(store.view('thread').pending).toEqual({})
  })

  it('sends nothing for a press on the value already in force', () => {
    const store = new ThreadSettingsStore()
    const send = vi.fn<SendThreadSettings>()
    store.press('thread', 'permissions', 'approval-required', { runtimeMode: 'approval-required' }, send, drawn('approval-required'))
    expect(send).not.toHaveBeenCalled()
    expect(store.view('thread').pending).toEqual({})
  })

  it('drops a refusal once the thread shows the value it asked for after all', async () => {
    const store = new ThreadSettingsStore()
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => state({}, 'Codex did not confirm this thread’s settings. Choose the thread settings again before sending.'), drawn('approval-required'))
    await settle()
    expect(store.view('thread').refusal).toMatchObject({ kind: 'permissions', wanted: 'full-access' })
    expect(store.view('thread').pending).toEqual({})
    store.observe('thread', drawn('full-access'))
    expect(store.view('thread').refusal).toBeNull()
  })
})
