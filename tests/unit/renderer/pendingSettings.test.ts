import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, PROVIDER_REJECTED_ACTION, type AgentState, type AgentThread } from '../../../src/shared/agents'
import { CONFIRMED_HOLD_MS, PendingSettingsStore, unconfirmedKinds, type SendSettings, type SettingValues } from '../../../src/renderer/src/agents/pendingSettings'

const caps = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, configureThread: true }
function state(thread: Partial<AgentThread> = {}, error: string | null = null, unconfirmed?: AgentState['unconfirmedSettings']): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected',
    host: { connected: true, name: 'Providers', version: '', capabilities: caps, projects: [],
      models: [{ id: 'model', name: 'Model', provider: 'Codex', providerId: 'codex', ready: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', runtimeModes: ['approval-required', 'full-access'] }],
      threads: [{ id: 'thread', providerId: 'codex', projectId: 'project', title: 'Work', modelId: 'model', status: 'idle', messages: [], requests: [], runtimeMode: 'approval-required', ...thread }] },
    assignments: [], queue: [], activeThreadId: 'thread', activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false,
    pendingRequest: '', globalLaneBusy: false, notice: '', error, speech: { id: 0, text: '' }, voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [], membership: { status: 'beta', label: 'Test', expiresAt: null },
    ...(unconfirmed ? { unconfirmedSettings: unconfirmed } : {}),
  }
}
const drawn = (permissions: string, effort = 'low'): SettingValues => ({ model: 'model', effort, permissions })
const settle = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }
const lost = 'Codex did not confirm the change, and the session stopped.'

afterEach(() => { vi.useRealTimers() })

describe('pending settings store', () => {
  it('holds a press per thread, whichever chip is on screen, until the window draws the answer', async () => {
    const store = new PendingSettingsStore()
    const send: SendSettings = vi.fn(async () => state({ runtimeMode: 'full-access' }))
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, send, drawn('approval-required'))
    expect(store.view('thread').pending.permissions).toEqual({ value: 'full-access', awaiting: 'provider', error: null })
    expect(store.view('other')).toEqual({ pending: {}, refusals: {} })
    await settle()
    // Answered, not yet drawn.
    expect(store.view('thread').pending.permissions).toEqual({ value: 'full-access', awaiting: 'window', error: null })
    store.observe('thread', drawn('approval-required'))
    expect(store.view('thread').pending.permissions?.value).toBe('full-access')
    store.observe('thread', drawn('full-access'))
    expect(store.view('thread').pending).toEqual({})
  })

  it('lets go of a confirmed press the window never draws after a while, and shows what the thread reports', async () => {
    vi.useFakeTimers()
    const store = new PendingSettingsStore()
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => state({ runtimeMode: 'full-access' }), drawn('approval-required'))
    await settle()
    expect(store.view('thread').pending.permissions?.awaiting).toBe('window')
    vi.advanceTimersByTime(CONFIRMED_HOLD_MS)
    expect(store.view('thread').pending).toEqual({})
  })

  it('sends nothing for a press on the value already in force', () => {
    const store = new PendingSettingsStore()
    const send = vi.fn<SendSettings>()
    store.press('thread', 'permissions', 'approval-required', { runtimeMode: 'approval-required' }, send, drawn('approval-required'))
    expect(send).not.toHaveBeenCalled()
    expect(store.view('thread').pending).toEqual({})
  })

  it('keeps a refusal per setting until that setting is pressed again, and drops it once the thread shows the value after all', async () => {
    const store = new PendingSettingsStore()
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => state({}, PROVIDER_REJECTED_ACTION), drawn('approval-required'))
    await settle()
    expect(store.view('thread').refusals.permissions).toMatchObject({ kind: 'permissions', wanted: 'full-access', error: PROVIDER_REJECTED_ACTION })
    expect(store.view('thread').pending).toEqual({})
    // Another chip's press leaves the permission alert, which is what says which mode is in force.
    store.press('thread', 'effort', 'high', { reasoningEffort: 'high' }, async () => state({ reasoningEffort: 'high' }), drawn('approval-required'))
    await settle()
    expect(store.view('thread').refusals.permissions).toBeDefined()
    store.observe('thread', drawn('full-access', 'high'))
    expect(store.view('thread').refusals.permissions).toBeUndefined()
  })

  it('keeps a press with no result on the chip until the thread shows it, and lets it go if main drops it otherwise', async () => {
    const store = new PendingSettingsStore()
    const unconfirmedReply = state({}, lost, [{ threadId: 'thread', runtimeMode: 'full-access' }])
    expect(unconfirmedKinds(unconfirmedReply, 'thread')).toEqual(new Set(['permissions']))
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => unconfirmedReply, drawn('approval-required'))
    await settle()
    expect(store.view('thread').pending.permissions).toEqual({ value: 'full-access', awaiting: 'unconfirmed', error: lost })
    expect(store.view('thread').refusals).toEqual({})
    // A state drawn from before main kept it does not let go of it.
    store.observe('thread', drawn('approval-required'), new Set())
    expect(store.view('thread').pending.permissions?.awaiting).toBe('unconfirmed')
    store.observe('thread', drawn('approval-required'), new Set(['permissions']))
    // The next start carries it: the thread shows it.
    store.observe('thread', drawn('full-access'), new Set(['permissions']))
    expect(store.view('thread').pending).toEqual({})

    store.press('thread', 'permissions', 'approval-required', { runtimeMode: 'approval-required' }, async () => state({ runtimeMode: 'full-access' }, lost, [{ threadId: 'thread', runtimeMode: 'approval-required' }]), drawn('full-access'))
    await settle()
    store.observe('thread', drawn('full-access'), new Set(['permissions']))
    expect(store.view('thread').pending.permissions?.awaiting).toBe('unconfirmed')
    // Main let it go without the thread showing it: the chip shows what the thread reports.
    store.observe('thread', drawn('full-access'), new Set())
    expect(store.view('thread').pending).toEqual({})
  })

  it('keeps the mark on a press back to the value in force while the save it follows is in flight', async () => {
    const store = new PendingSettingsStore()
    let release!: () => void
    const send = vi.fn<SendSettings>(async request => {
      await new Promise<void>(done => { release = done })
      return state({ runtimeMode: request.runtimeMode! })
    })
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, send, drawn('approval-required'))
    store.press('thread', 'permissions', 'approval-required', { runtimeMode: 'approval-required' }, send, drawn('approval-required'))
    // Full access may still land first, so the press back is still pending.
    expect(store.view('thread').pending.permissions).toEqual({ value: 'approval-required', awaiting: 'provider', error: null })
    release(); await settle()
    expect(send).toHaveBeenCalledTimes(2)
    store.observe('thread', drawn('full-access'))
    expect(store.view('thread').pending.permissions?.value).toBe('approval-required')
    release(); await settle()
    store.observe('thread', drawn('approval-required'))
    expect(store.view('thread').pending).toEqual({})
  })

  it('forgets threads the state no longer has', async () => {
    const store = new PendingSettingsStore()
    store.press('thread', 'permissions', 'full-access', { runtimeMode: 'full-access' }, async () => state({}, PROVIDER_REJECTED_ACTION), drawn('approval-required'))
    await settle()
    expect(store.view('thread').refusals.permissions).toBeDefined()
    store.prune(new Set(['other']))
    expect(store.view('thread')).toEqual({ pending: {}, refusals: {} })
  })
})
