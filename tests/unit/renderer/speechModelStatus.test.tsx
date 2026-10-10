import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechModelStatus, speechModelSummary } from '../../../src/renderer/src/components/SpeechModelStatus'
import { SPEECH_MODEL_BYTES, type SpeechModelFailure } from '../../../src/shared/speechModel'

afterEach(cleanup)

const failed = (reason: SpeechModelFailure, receivedBytes = 0) => ({ state: 'failed' as const, reason, receivedBytes, totalBytes: SPEECH_MODEL_BYTES })

describe('speech model status', () => {
  it('sums up where the model stands in one line, naming what stopped it', () => {
    expect(speechModelSummary(null)).toBe('Checking the speech model')
    expect(speechModelSummary({ state: 'missing' })).toBe('Speech model not downloaded')
    expect(speechModelSummary({ state: 'downloading', receivedBytes: 280_000_000, totalBytes: SPEECH_MODEL_BYTES }))
      .toBe('Downloading the speech model · 280 of 670 MB')
    expect(speechModelSummary({ state: 'loading' })).toBe('Starting the speech model')
    expect(speechModelSummary({ state: 'ready' })).toBe('Parakeet v3 on this computer')
    expect(speechModelSummary(failed('network'))).toBe('Speech model download stopped')
    expect(speechModelSummary(failed('checksum'))).toBe('Speech model download did not match')
    expect(speechModelSummary(failed('disk'))).toBe('Speech model could not be saved')
    expect(speechModelSummary(failed('engine'))).toBe('Speech model would not start')
  })

  it('says what stopped the model and what Try again does, and Try again asks for it again', () => {
    const retry = vi.fn()
    render(<SpeechModelStatus status={failed('engine', SPEECH_MODEL_BYTES)} onRetry={retry} />)
    expect(screen.getByText(/the speech engine would not start on this computer/)).toBeTruthy()
    expect(screen.getByText(/Try again checks the files, downloads any that went bad, and starts it again\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('names the size once the model is ready', () => {
    render(<SpeechModelStatus status={{ state: 'ready' }} onRetry={vi.fn()} />)
    expect(screen.getByText(/670 MB on this computer\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
