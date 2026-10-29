import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DictateRoom } from '../../../src/renderer/src/features/dictate/DictateRoom'
import { OPENROUTER_KEY_MISSING_DETAIL, TRANSCRIPTION_KEPT_DETAIL } from '../../../src/shared/dictation'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

afterEach(() => cleanup())

const baseProps = {
  settings: { ...DEFAULT_SETTINGS, onboardingComplete: true, cloudTranscription: true },
  speechModel: null,
  platform: 'win32' as const,
  entries: [],
  records: [],
  historyStatus: 'ready' as const,
  onStart: vi.fn(async () => undefined),
  onStop: vi.fn(async () => undefined),
  onOpenSettings: vi.fn(),
  onCopy: vi.fn(async () => true),
}
const offline = { status: 'error' as const, sessionId: 'one', code: 'TRANSCRIPTION_OFFLINE', message: 'internal', kept: true }

// Transcribe with OpenRouter (ADR-0160): what the Dictate room offers when OpenRouter turns a dictation away.
describe('Dictate while OpenRouter transcribes', () => {
  it('offers Transcribe on this computer beside Try again when the speech model here is downloaded', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn(async () => undefined)
    const onTranscribeHere = vi.fn(async () => undefined)
    render(<DictateRoom {...baseProps} dictation={offline} onRetry={onRetry} onTranscribeHere={onTranscribeHere} onDismiss={vi.fn(async () => undefined)} />)
    expect(screen.getByRole('alert')).toHaveTextContent(TRANSCRIPTION_KEPT_DETAIL.TRANSCRIPTION_OFFLINE)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Try again' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Transcribe on this computer' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onTranscribeHere).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('offers no local transcription when no speech model is here, and Settings for a key it refused', () => {
    render(<DictateRoom {...baseProps} dictation={{ ...offline, code: 'TRANSCRIPTION_KEY_REJECTED' }} onRetry={vi.fn(async () => undefined)} />)
    expect(screen.queryByRole('button', { name: 'Transcribe on this computer' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument()
  })

  it('says where the key goes when a dictation is refused for want of one', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    render(<DictateRoom {...baseProps} onOpenSettings={onOpenSettings} dictation={{ status: 'error', sessionId: 'one', code: 'OPENROUTER_KEY_MISSING', message: 'internal' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(OPENROUTER_KEY_MISSING_DETAIL)
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledWith('settings-transcription')
  })

  it('reads ready, with no word about a speech model, while idle', () => {
    render(<DictateRoom {...baseProps} dictation={{ status: 'idle' }} />)
    expect(screen.getByRole('button', { name: 'Start dictation' })).toBeEnabled()
    expect(screen.queryByText(/speech model/iu)).toBeNull()
  })
})
