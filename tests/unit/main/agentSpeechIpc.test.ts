import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcInvocationEvent, IpcMainAdapter, TrustedIpcSender } from '../../../src/main/ipc/registerIpc'
import { AGENT_COMMAND, AGENT_GROK_VOICES, AGENT_SPEECH, AGENT_SPEECH_CANCEL, defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'
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
  const kokoro = { synthesize: vi.fn<(text: string) => Promise<{ audioBase64: string; mimeType: 'audio/wav' }>>(async () => ({ audioBase64: 'kokoro-fixture', mimeType: 'audio/wav' })), cancel: vi.fn() }
  disposables.push(registerAgentIpc(ipc, control, () => [main, widget], 'win32', {
    status: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
    download: async () => ({ ready: true, completedBytes: 1, totalBytes: 1 }),
  }, grok, kokoro))
  const invoke = async (channel: string, payload?: unknown, source = main, frame = source.webContents.mainFrame) => listeners.get(channel)!({ sender: source.webContents, senderFrame: frame }, payload)
  return { state, control, grok, kokoro, invoke, main, widget }
}

describe('agent command IPC authorization', () => {
  it.each([false, true])('allows a trusted widget to configure speak=%s', async speak => {
    const f = fixture()
    const command = { type: 'configure', patch: { speak } }
    await expect(f.invoke(AGENT_COMMAND, command, f.widget)).resolves.toBe(f.state)
    expect(f.control.command).toHaveBeenCalledExactlyOnceWith(command)
  })

  it.each(Object.entries(defaultAgentConfiguration()).filter(([key]) => key !== 'speak'))(
    'keeps %s configuration and mixed speak patches main-only', async (key, value) => {
      const f = fixture()
      for (const patch of [{ [key]: value }, { speak: false, [key]: value }, { speak: true, [key]: undefined }]) {
        const command = { type: 'configure', patch }
        await expect(f.invoke(AGENT_COMMAND, command, f.widget)).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
        expect(f.control.command).not.toHaveBeenCalled()
        await expect(f.invoke(AGENT_COMMAND, command)).resolves.toBe(f.state)
        expect(f.control.command).toHaveBeenCalledExactlyOnceWith(command)
        f.control.command.mockClear()
      }
    },
  )

  it('rejects empty, non-boolean and unknown-key widget patches without dispatch', async () => {
    const f = fixture()
    for (const patch of [{}, { speak: undefined }, { speak: null }, { speak: 'false' }, { speak: 0 }, { speak: false, unknown: true }]) {
      await expect(f.invoke(AGENT_COMMAND, { type: 'configure', patch }, f.widget)).rejects.toThrow()
    }
    expect(f.control.command).not.toHaveBeenCalled()
  })

  it.each([
    ...['t3', 'reasoning', 'membership', 'grokSpeech'].map(slot => ({ type: 'credential', slot, value: 'fixture' })),
    { type: 'connect' }, { type: 'disconnect' },
    { type: 'membership', action: 'refresh' },
    { type: 'voice-state', status: 'idle', error: null },
    { type: 'check-reasoning', provider: 'codex' },
    { type: 'preview-voice' },
  ])('keeps privileged command %j main-only', async command => {
    const f = fixture()
    await expect(f.invoke(AGENT_COMMAND, command, f.widget)).rejects.toThrow('AGENT_MAIN_WINDOW_REQUIRED')
    expect(f.control.command).not.toHaveBeenCalled()
    await expect(f.invoke(AGENT_COMMAND, command)).resolves.toBe(f.state)
    expect(f.control.command).toHaveBeenCalledExactlyOnceWith(command)
  })

  it('rejects speak-only commands from child frames, navigated widgets and untrusted senders', async () => {
    const f = fixture()
    const command = { type: 'configure', patch: { speak: false } }
    await expect(f.invoke(AGENT_COMMAND, command, f.widget, { url: f.widget.url, parent: {} })).rejects.toThrow('AGENT_SENDER_REJECTED')
    const impostor = { ...f.widget, webContents: { ...f.widget.webContents } }
    await expect(f.invoke(AGENT_COMMAND, command, impostor)).rejects.toThrow('AGENT_SENDER_REJECTED')
    f.widget.webContents.getURL = () => 'https://untrusted.example/'
    await expect(f.invoke(AGENT_COMMAND, command, f.widget)).rejects.toThrow('AGENT_SENDER_REJECTED')
    expect(f.control.command).not.toHaveBeenCalled()
  })

  it.each(['mute', 'unmute'])('preserves widget microphone %s commands', async action => {
    const f = fixture()
    const command = { type: 'voice', action }
    await expect(f.invoke(AGENT_COMMAND, command, f.widget)).resolves.toBe(f.state)
    expect(f.control.command).toHaveBeenCalledExactlyOnceWith(command)
  })
})

describe('native speech IPC', () => {
  it('routes Kokoro using saved configuration, never falls back on failure, and cancels across a provider change', async () => {
    const f = fixture()
    f.state.configuration.speechProvider = 'kokoro'
    await expect(f.invoke(AGENT_SPEECH, 'Heart preview')).resolves.toMatchObject({ audioBase64: 'kokoro-fixture' })
    expect(f.kokoro.synthesize).toHaveBeenCalledExactlyOnceWith('Heart preview')
    f.kokoro.synthesize.mockRejectedValueOnce(new Error('Save your OpenRouter key.'))
    await expect(f.invoke(AGENT_SPEECH, 'No key')).rejects.toThrow('OpenRouter key')
    expect(f.grok.synthesize).not.toHaveBeenCalled()
    expect(synthesizeAgentSpeech).not.toHaveBeenCalled()
    let release!: (value: { audioBase64: string; mimeType: 'audio/wav' }) => void
    f.kokoro.synthesize.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const old = f.invoke(AGENT_SPEECH, 'Old Kokoro reply')
    f.state.configuration.speechProvider = 'grok'
    await f.invoke(AGENT_SPEECH_CANCEL)
    expect(f.kokoro.cancel).toHaveBeenCalledOnce()
    await expect(f.invoke(AGENT_SPEECH, 'Fresh Grok reply')).resolves.toMatchObject({ audioBase64: 'grok-fixture' })
    release({ audioBase64: 'late', mimeType: 'audio/wav' }); await old
    await expect(f.invoke(AGENT_SPEECH, 'Next Grok reply')).resolves.toMatchObject({ audioBase64: 'grok-fixture' })
  })
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
