import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechModelStatus, speechModelSummary } from '../../../src/renderer/src/components/SpeechModelStatus'
import { PARAKEET_V3, speechModelBytes, type SpeechModelFailure, type SpeechModelOption } from '../../../src/shared/speechModel'

const V3_BYTES = speechModelBytes(PARAKEET_V3)

afterEach(cleanup)

const failed = (reason: SpeechModelFailure, receivedBytes = 0) => ({ state: 'failed' as const, reason, receivedBytes, totalBytes: V3_BYTES })

describe('speech model status', () => {
  it('sums up where the model stands in one line, naming what stopped it', () => {
    expect(speechModelSummary(null)).toBe('Checking the speech model')
    expect(speechModelSummary({ state: 'missing' })).toBe('No speech model chosen')
    expect(speechModelSummary({ state: 'downloading', receivedBytes: 280_000_000, totalBytes: V3_BYTES }))
      .toBe('Downloading the speech model · 280 of 670 MB')
    expect(speechModelSummary({ state: 'loading' })).toBe('Starting the speech model')
    expect(speechModelSummary({ state: 'ready' })).toBe('Parakeet v3 on this computer')
    expect(speechModelSummary({ state: 'ready' }, 'Parakeet Ultra')).toBe('Parakeet Ultra on this computer')
    expect(speechModelSummary(failed('network'))).toBe('Speech model download stopped')
    expect(speechModelSummary(failed('checksum'))).toBe('Speech model download did not match')
    expect(speechModelSummary(failed('disk'))).toBe('Speech model could not be saved')
    expect(speechModelSummary(failed('engine'))).toBe('Speech model would not start')
    expect(speechModelSummary(failed('gone'))).toBe('Speech model is no longer on this computer')
  })

  it('says what stopped the model and what Try again does, and Try again asks for it again', () => {
    const retry = vi.fn()
    render(<SpeechModelStatus status={failed('engine', V3_BYTES)} onRetry={retry} />)
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

  it('offers no download while no model is chosen: nothing downloads by itself', () => {
    render(<SpeechModelStatus status={{ state: 'missing' }} onRetry={vi.fn()} />)
    expect(screen.getByText('No speech model chosen yet. Choose one above.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  const ultra: SpeechModelOption = { id: 'fluidaudio:parakeet-ultra', name: 'Parakeet Ultra', maker: 'Moondream', languages: '25 European languages', source: 'fluidaudio', installed: true, bytes: 2_400_000_000 }

  it('names a model it did not download by its own size, and never promises a download for it', () => {
    const { rerender } = render(<SpeechModelStatus status={{ state: 'ready' }} model={ultra} onRetry={vi.fn()} />)
    expect(screen.getByText(/2\.4 GB on this computer\./)).toBeTruthy()
    rerender(<SpeechModelStatus status={{ state: 'loading' }} model={ultra} onRetry={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Starting the speech model…')
    rerender(<SpeechModelStatus status={failed('engine')} model={ultra} onRetry={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('The speech engine would not start this model on this computer. Try again starts it again.')
  })

  it('says a gone model\'s files left this computer, that nothing is lost, and what to do next', () => {
    render(<SpeechModelStatus status={failed('gone')} model={ultra} onRetry={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('The model\u2019s files are no longer on this computer. Nothing is lost. Choose another model, or reinstall it in the app that downloaded it.')
  })
})
