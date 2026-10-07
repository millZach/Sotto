// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: vi.fn() }, ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }))
import { createSottoBridge } from '../../../src/preload'
import { SETTINGS_CHANGED } from '../../../src/shared/channels'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

function fixture() {
  const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
  const bridge = createSottoBridge(ipc, 'win32')
  const handler = ipc.on.mock.calls.find(([channel]) => channel === SETTINGS_CHANGED)![1] as (event: unknown, ...args: unknown[]) => void
  return { bridge, emit: (payload: unknown) => handler({}, payload) }
}

describe('buffered settings subscriptions', () => {
  it('delivers to later subscribers when an earlier subscriber throws', () => {
    const { bridge, emit } = fixture(), later = vi.fn()
    bridge.onSettingsChanged(() => { throw new Error('Synthetic subscriber failure') })
    bridge.onSettingsChanged(later)
    expect(() => emit(DEFAULT_SETTINGS)).not.toThrow()
    expect(later).toHaveBeenCalledWith(DEFAULT_SETTINGS)
    emit(DEFAULT_SETTINGS)
    expect(later).toHaveBeenCalledTimes(2)
  })

  it('keeps a throwing replay subscriber registered without preventing later delivery', () => {
    const { bridge, emit } = fixture(), later = vi.fn()
    emit(DEFAULT_SETTINGS)
    expect(() => bridge.onSettingsChanged(() => { throw new Error('Synthetic replay failure') })).not.toThrow()
    bridge.onSettingsChanged(later)
    emit(DEFAULT_SETTINGS)
    expect(later).toHaveBeenCalledWith(DEFAULT_SETTINGS)
  })

  it('delivers changes to both the app and voice settings and keeps the app subscribed after voice settings unmount', () => {
    const { bridge, emit } = fixture(), app = vi.fn(), voice = vi.fn()
    const offApp = bridge.onSettingsChanged(app)
    const offVoice = bridge.onSettingsChanged(voice)
    emit(DEFAULT_SETTINGS)
    expect(app).toHaveBeenCalledWith(DEFAULT_SETTINGS)
    expect(voice).toHaveBeenCalledWith(DEFAULT_SETTINGS)
    offVoice()
    offVoice()
    const next = { ...DEFAULT_SETTINGS, llmApiKey: 'saved' }
    emit(next)
    expect(app).toHaveBeenLastCalledWith(next)
    expect(voice).toHaveBeenCalledTimes(1)
    offApp()
  })

  it('buffers the latest valid settings while no listeners exist and replays them once', () => {
    const { bridge, emit } = fixture(), first = vi.fn(), second = vi.fn()
    emit({ ...DEFAULT_SETTINGS, llmApiKey: 'older' })
    emit(DEFAULT_SETTINGS)
    emit({ invalid: true })
    const off = bridge.onSettingsChanged(first)
    expect(first.mock.calls).toEqual([[DEFAULT_SETTINGS]])
    bridge.onSettingsChanged(second)
    expect(second).not.toHaveBeenCalled()
    off()
    emit(DEFAULT_SETTINGS)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps registrations independent when they share a callback and resumes buffering after the last unsubscribe', () => {
    const { bridge, emit } = fixture(), listener = vi.fn()
    const offFirst = bridge.onSettingsChanged(listener)
    const offSecond = bridge.onSettingsChanged(listener)
    offFirst()
    emit(DEFAULT_SETTINGS)
    expect(listener).toHaveBeenCalledTimes(1)
    offSecond()
    emit(DEFAULT_SETTINGS)
    expect(listener).toHaveBeenCalledTimes(1)
    bridge.onSettingsChanged(listener)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
