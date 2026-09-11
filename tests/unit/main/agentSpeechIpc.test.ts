import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_GROK_VOICES, AGENT_SPEECH, AGENT_SPEECH_CANCEL, defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
import type { AgentControl } from '../../../src/main/agents/control'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => 'D:/fixture' } }))
vi.mock('../../../src/main/agents/speech', () => ({ synthesizeAgentSpeech: vi.fn(async () => ({ audioBase64: 'system-fixture', mimeType: 'audio/wav' })) }))
import { synthesizeAgentSpeech } from '../../../src/main/agents/speech'
import { registerAgentIpc } from '../../../src/main/agents/ipc'

const disposables: Array<() => void> = []
afterEach(() => { for (const dispose of disposables.splice(0)) dispose(); vi.clearAllMocks() })

function fixture() {
  const listeners = new Map<string, (event: IpcInvocationEvent, ...args: unknown[]) => unknown>()
  const ipc: IpcMainAdapter = { handle: (channel, handler) => { listeners.set(channel, handler) }, removeHandler: channel => { listeners.delete(channel) } }
  const sender = (role: 'main' | 'widget'): TrustedIpcSender => {
    const url = `file:///${role}.html`
    const mainFrame = { parent: null, url }
    return { role, url, webContents: { mainFrame, isDestroyed: () => false, getURL: () => url } }
  }
  const main = sender('main'), widget = sender('widget')
  const state = { configuration: { ...defaultAgentConfiguration(), speechProvider: 'grok', grokSpeechVoice: 'custom-voice' } } as AgentState
  const control = { get: () => state, command: vi.fn<AgentControl['command']>(async () => state) }
  const grok = {
    synthesize: vi.fn<(text: string, voice: string) => Promise<{ audioBase64: string; mimeType: 'audio/wav' }>>(async () => ({ audioBase64: 'grok-fixture', mimeType: 'audio/wav' })),
    voices: vi.fn(async () => [{ id: 'custom-voice', name: 'Custom' }]), cancel: vi.fn(),
  }
  disposables.push(registerAgentIpc(ipc, control, () => [main, widget], 'win32', {
    status: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
    download: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
  }, grok))
  const invoke = async (channel: string, payload?: unknown, source = main, frame = source.webContents.mainFrame) => listeners.get(channel)!({ sender: source.webContents, senderFrame: frame }, payload)
  return { state, grok, invoke, main, widget }
}

describe('native speech IPC', () => {
  it('uses only the saved provider and its exact voice, with no system fallback on Grok errors', async () => {
    const f = fixture()
    await expect(f.invoke(AGENT_SPEECH, 'Read this reply')).resolves.toMatchObject({ audioBase64: 'grok-fixture' })
    expect(f.grok.synthesize).toHaveBeenCalledWith('Read this reply', 'custom-voice')
    f.grok.synthesize.mockRejectedValueOnce(new Error('Grok speech API key was rejected.'))
    await expect(f.invoke(AGENT_SPEECH, 'Another reply')).rejects.toThrow('API key was rejected')
    expect(synthesizeAgentSpeech).not.toHaveBeenCalled()
    f.state.configuration.speechProvider = 'system'
    await f.invoke(AGENT_SPEECH, 'System reply')
    expect(synthesizeAgentSpeech).toHaveBeenCalledWith('System reply', 'win32')
    f.state.configuration.speechProvider = 'natural'
    await expect(f.invoke(AGENT_SPEECH, 'Local reply')).rejects.toThrow('local voice worker')
    expect(f.grok.synthesize).toHaveBeenCalledTimes(2)
  })

  it('rejects widgets and child frames before voice discovery, synthesis or cancellation', async () => {
    const f = fixture()
    for (const channel of [AGENT_GROK_VOICES, AGENT_SPEECH, AGENT_SPEECH_CANCEL]) {
      await expect(f.invoke(channel, channel === AGENT_SPEECH ? 'Speech' : undefined, f.widget)).rejects.toThrow('MAIN_WINDOW_REQUIRED')
      await expect(f.invoke(channel, undefined, f.main, { url: f.main.url, parent: {} })).rejects.toThrow('MAIN_WINDOW_REQUIRED')
    }
    expect(f.grok.synthesize).not.toHaveBeenCalled()
    expect(f.grok.voices).not.toHaveBeenCalled()
    expect(f.grok.cancel).not.toHaveBeenCalled()
    await expect(f.invoke(AGENT_GROK_VOICES)).resolves.toEqual([{ id: 'custom-voice', name: 'Custom' }])
  })

  it('releases a cancelled Grok request for a fresh preview and ignores its late completion', async () => {
    const f = fixture()
    let release!: (value: { audioBase64: string; mimeType: 'audio/wav' }) => void
    f.grok.synthesize.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = f.invoke(AGENT_SPEECH, 'Old reply')
    await expect(f.invoke(AGENT_SPEECH, 'Duplicate')).rejects.toThrow('already being prepared')
    await f.invoke(AGENT_SPEECH_CANCEL)
    await expect(f.invoke(AGENT_SPEECH, 'New reply')).resolves.toMatchObject({ audioBase64: 'grok-fixture' })
    release({ audioBase64: 'late', mimeType: 'audio/wav' })
    await old
    expect(f.grok.cancel).toHaveBeenCalledOnce()
    await expect(f.invoke(AGENT_SPEECH, 'Next reply')).resolves.toMatchObject({ audioBase64: 'grok-fixture' })
  })
})
