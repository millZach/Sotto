import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WatcherCompactionDial } from '../../../src/renderer/src/features/settings/WatcherCompactionSetting'
import { settingsIndex } from '../../../src/renderer/src/features/settings/settingsPages'

afterEach(cleanup)

/** Compact Watcher at, in Settings > Watcher: Zach's pick C, a line on Watcher's conversation that he moves. */
describe('Compact Watcher at', () => {
  it('is a labelled slider from 200k to 1M on a 50k step, saved when it is let go', () => {
    const onSave = vi.fn()
    const { rerender } = render(<WatcherCompactionDial value={400_000} tokens={null} onSave={onSave} />)
    const slider = screen.getByRole('slider', { name: 'Compact Watcher at' }) as HTMLInputElement
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['200000', '1000000', '50000', '400000'])
    expect(slider.getAttribute('aria-valuetext')).toBe('400k tokens')
    expect(slider.dataset.setting).toBe('watcher-compact-at')
    fireEvent.change(slider, { target: { value: '250000' } })
    expect(screen.getByText('250k')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyUp(slider, { key: 'ArrowLeft' })
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ watcherCompactAtTokens: 250_000 })
    // Saved, then let go where it already was: nothing more to save.
    rerender(<WatcherCompactionDial value={250_000} tokens={null} onSave={onSave} />)
    fireEvent.pointerUp(slider)
    expect(onSave).toHaveBeenCalledOnce()
  })

  it('shows Watcher’s conversation now, and says when the point is below it', () => {
    const { rerender } = render(<WatcherCompactionDial value={400_000} tokens={312_000} onSave={() => {}} />)
    expect(screen.getByText('Watcher is at 312k.')).toBeTruthy()
    rerender(<WatcherCompactionDial value={250_000} tokens={312_000} onSave={() => {}} />)
    expect(screen.getByText('Watcher is at 312k: it compacts at its next rest.')).toBeTruthy()
    // No reading yet: nothing said about Watcher's size.
    rerender(<WatcherCompactionDial value={250_000} tokens={null} onSave={() => {}} />)
    expect(screen.queryByText(/Watcher is at/)).toBeNull()
  })

  it('follows a saved change made elsewhere', () => {
    const { rerender } = render(<WatcherCompactionDial value={400_000} tokens={null} onSave={() => {}} />)
    rerender(<WatcherCompactionDial value={1_000_000} tokens={null} onSave={() => {}} />)
    expect((screen.getByRole('slider', { name: 'Compact Watcher at' }) as HTMLInputElement).value).toBe('1000000')
    expect(screen.getByText('1M')).toBeTruthy()
  })

  it('is found by Find a setting on Watcher’s page, only while Watcher is on', () => {
    expect(settingsIndex('win32').find(entry => entry.id === 'watcher-compact-at')).toMatchObject({ label: 'Compact Watcher at', section: 'settings-watcher', gate: 'watcher' })
  })
})
