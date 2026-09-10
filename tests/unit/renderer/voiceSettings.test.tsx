import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultAgentConfiguration, type AgentConfiguration, type AgentState } from '../../../src/shared/agents'
import { VoiceSettings } from '../../../src/renderer/src/agents/VoiceSettings'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function harness(ready = false) {
  const voiceModel = vi.fn(async (action: string) => { if (action === 'download') ready = true; return { ready, completedBytes: ready ? 100 : 0, totalBytes: 100 } })
  vi.stubGlobal('sotto', { agents: { voiceModel } })
  const command = vi.fn(async () => ({ error: null } as AgentState))
  function View() {
    const [configuration, setConfiguration] = useState(defaultAgentConfiguration())
    const change = <K extends keyof AgentConfiguration>(key: K, value: AgentConfiguration[K]): void => { setConfiguration(current => ({ ...current, [key]: value })) }
    return <VoiceSettings configuration={configuration} change={change} command={command} />
  }
  render(<View />)
  return { command, voiceModel }
}

describe('natural voice setup', () => {
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
