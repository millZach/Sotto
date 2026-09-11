import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentCommand, type AgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { VoiceSettings } from '../../../src/renderer/src/agents/VoiceSettings'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function harness(ready = false, options: { configuration?: Partial<AgentConfiguration>; keySaved?: boolean; voices?: Array<{ id: string; name: string }>; voiceError?: string } = {}) {
  const voiceModel = vi.fn(async (action: string) => { if (action === 'download') ready = true; return { ready, completedBytes: ready ? 100 : 0, totalBytes: 100 } })
  const grokVoices = vi.fn(async () => options.voices ?? [{ id: 'ara', name: 'Ara' }])
  vi.stubGlobal('sotto', { agents: { voiceModel, grokVoices } })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState>>(async () => ({ error: null } as AgentState))
  function View() {
    const [configuration, setConfiguration] = useState({ ...defaultAgentConfiguration(), ...options.configuration })
    const change = <K extends keyof AgentConfiguration>(key: K, value: AgentConfiguration[K]): void => { setConfiguration(current => ({ ...current, [key]: value })) }
    return <VoiceSettings configuration={configuration} change={change} command={command} grokKeySaved={options.keySaved} voiceError={options.voiceError} />
  }
  render(<View />)
  return { command, voiceModel, grokVoices }
}

describe('natural voice setup', () => {
  it('allows stopping a preview without enabling agent control', async () => {
    const h = harness()
    fireEvent.click(screen.getByRole('button', { name: 'Stop speech', exact: true }))
    expect(h.command).toHaveBeenCalledExactlyOnceWith({ type: 'voice', action: 'stop-speaking' })
  })

  it('checks installed files without downloading until requested and presents the actual license', async () => {
    const h = harness()
    await waitFor(() => expect(h.voiceModel).toHaveBeenCalledWith('status'))
    expect(h.voiceModel).not.toHaveBeenCalledWith('download')
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeDisabled()
    expect(screen.getByText(/Voice model terms/)).toBeInTheDocument()
    expect(screen.getByText(/BigScience Open RAIL-M License/u)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Download natural voices' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeEnabled())
    expect(h.voiceModel).toHaveBeenCalledWith('download')
  })

  it('saves the chosen voice before preview without changing the reasoning provider', async () => {
    const h = harness(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Voice', { exact: true }), { target: { value: 'M3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use and preview voice' }))
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2))
    expect(h.command.mock.calls).toEqual([
      [{ type: 'configure', patch: { speechProvider: 'natural', speechVoice: 'M3', speak: true } }],
      [{ type: 'preview-voice' }],
    ])
  })

  it('keeps the optional system voice usable without downloading a model', async () => {
    const h = harness()
    fireEvent.change(screen.getByLabelText('Speech voice'), { target: { value: 'system' } })
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Download natural voices' })).not.toBeInTheDocument()
    expect(h.voiceModel).not.toHaveBeenCalledWith('download')
  })
})

describe('Grok speech API setup', () => {
  it('explains separate usage billing and never reads the catalog or requests speech without a saved key', async () => {
    const h = harness()
    fireEvent.change(screen.getByLabelText('Speech voice'), { target: { value: 'grok' } })
    expect(screen.getByText(/\$15 per million characters, including previews/u)).toHaveTextContent('Billed separately from your Grok subscription.')
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeDisabled()
    expect(screen.getByLabelText('Grok speech API key')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Grok speech API key')).toHaveValue('')
    expect(h.command).not.toHaveBeenCalled()
    expect(h.grokVoices).not.toHaveBeenCalled()
  })

  it('saves a dedicated key, clears the input, and discovers all voices without paying for a preview', async () => {
    const voices = Array.from({ length: 12 }, (_, index) => ({ id: `catalog-voice-${index}`, name: `Catalog voice ${index}` }))
    const h = harness(false, { configuration: { speechProvider: 'grok' }, voices })
    fireEvent.change(screen.getByLabelText('Grok speech API key'), { target: { value: '  test-only-speech-key  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save API key' }))
    await waitFor(() => expect(h.grokVoices).toHaveBeenCalledTimes(1))
    expect(h.command.mock.calls).toEqual([[{ type: 'credential', slot: 'grokSpeech', value: 'test-only-speech-key' }]])
    expect(screen.getByLabelText('Grok speech API key')).toHaveValue('')
    expect(screen.getByLabelText('Grok speech API key')).toHaveAttribute('placeholder', 'Saved securely · enter to replace')
    for (const voice of voices) expect(screen.getByRole('option', { name: voice.name })).toHaveValue(voice.id)
    expect(screen.getByRole('option', { name: 'ara · saved voice' })).toHaveValue('ara')
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Grok voice'), { target: { value: 'catalog-voice-11' } })
    expect(screen.getByLabelText('Grok voice')).toHaveValue('catalog-voice-11')
    expect(h.command).toHaveBeenCalledTimes(1)
  })

  it('replaces and removes the saved speech key without touching reasoning credentials', async () => {
    const h = harness(false, { configuration: { speechProvider: 'grok' }, keySaved: true })
    await waitFor(() => expect(h.grokVoices).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Grok speech API key'), { target: { value: 'replacement-test-key' } })
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }))
    await waitFor(() => expect(screen.getByLabelText('Grok speech API key')).toHaveValue(''))
    expect(h.command).toHaveBeenLastCalledWith({ type: 'credential', slot: 'grokSpeech', value: 'replacement-test-key' })
    await waitFor(() => expect(h.grokVoices).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: 'Remove API key' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove API key' })).not.toBeInTheDocument())
    expect(h.command).toHaveBeenLastCalledWith({ type: 'credential', slot: 'grokSpeech', value: '' })
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeDisabled()
    expect(h.grokVoices).toHaveBeenCalledTimes(2)
  })

  it('previews the selected catalog voice only after saving speech settings and preserves reasoning', async () => {
    const h = harness(false, {
      configuration: { speechProvider: 'grok', reasoning: 'codex', reasoningModel: 'gpt-test', reasoningEffort: 'low' },
      keySaved: true, voices: [{ id: 'ara', name: 'Ara' }, { id: 'account-custom-voice', name: 'My custom voice' }],
    })
    await screen.findByRole('option', { name: 'My custom voice' })
    expect(h.command).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Grok voice'), { target: { value: 'account-custom-voice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use and preview voice' }))
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2))
    expect(h.command.mock.calls).toEqual([
      [{ type: 'configure', patch: { speechProvider: 'grok', grokSpeechVoice: 'account-custom-voice', speak: true } }],
      [{ type: 'preview-voice' }],
    ])
  })

  it('loads voices only after choosing Grok and gives an actionable refresh after discovery fails', async () => {
    const h = harness(false, { keySaved: true })
    expect(h.grokVoices).not.toHaveBeenCalled()
    h.grokVoices.mockRejectedValueOnce(new Error('xAI rejected this API key. Replace the key and try again.'))
    fireEvent.change(screen.getByLabelText('Speech voice'), { target: { value: 'grok' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Replace the key and try again.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh voices' }))
    await screen.findByRole('option', { name: 'Ara' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(h.command).not.toHaveBeenCalled()
  })

  it('retains an unsaved key on secure storage failure and does not enable preview', async () => {
    const h = harness(false, { configuration: { speechProvider: 'grok' } })
    h.command.mockResolvedValueOnce({ error: 'Secure credential storage is unavailable.' } as AgentState)
    fireEvent.change(screen.getByLabelText('Grok speech API key'), { target: { value: 'test-key-not-saved' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save API key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Secure credential storage is unavailable.')
    expect(screen.getByLabelText('Grok speech API key')).toHaveValue('test-key-not-saved')
    expect(screen.getByRole('button', { name: 'Use and preview voice' })).toBeDisabled()
    expect(h.grokVoices).not.toHaveBeenCalled()
  })

  it('shows asynchronous synthesis failures beside preview instead of a success notice', async () => {
    const h = harness(false, { configuration: { speechProvider: 'grok' }, keySaved: true, voiceError: 'xAI speech quota exceeded. Check your API billing.' })
    fireEvent.click(screen.getByRole('button', { name: 'Use and preview voice' }))
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('xAI speech quota exceeded. Check your API billing.')
    expect(screen.queryByText(/Your preview will play/u)).not.toBeInTheDocument()
  })
})
