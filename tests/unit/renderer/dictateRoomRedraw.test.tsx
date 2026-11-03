import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DictationRecord } from '../../../src/shared/dictationRecord'
import type { LiveLevel } from '../../../src/renderer/src/audio/liveLevel'
import type { HistoryEntry } from '../../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

// Every Journal row reads its clock label once per draw, so counting the calls counts the rows drawn.
const clockLabel = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../src/renderer/src/features/dictate/journalFacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/features/dictate/journalFacts')>()
  return { ...actual, clockLabel: (...args: Parameters<typeof actual.clockLabel>) => { clockLabel.calls += 1; return actual.clockLabel(...args) } }
})

const { LiveLevelStore } = await import('../../../src/renderer/src/audio/liveLevel')
const { DictateRoom } = await import('../../../src/renderer/src/features/dictate/DictateRoom')

afterEach(cleanup)

const NOW = new Date(2026, 9, 21, 16, 20).valueOf()
const entries: HistoryEntry[] = Array.from({ length: 40 }, (_, index) => ({
  id: `entry-${index}`, text: `Transcript number ${index}`, createdAt: NOW - index * 60_000, durationMs: 4_000, language: 'en', modelPreset: 'parakeet',
}))
const records: DictationRecord[] = entries.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, durationMs: entry.durationMs, words: 3, app: 'Slack' }))

// The app hands the room new handlers each time its state changes, as App does when the speaking gate moves.
function roomWith(speaking: boolean, level?: LiveLevel): React.ReactElement {
  return <DictateRoom
    settings={{ ...DEFAULT_SETTINGS, onboardingComplete: true }}
    speechModel={{ state: 'ready' }}
    platform="win32"
    dictation={{ status: 'listening', sessionId: 'live', startedAt: NOW, speaking }}
    {...(level === undefined ? {} : { level })}
    entries={entries}
    records={records}
    historyStatus="ready"
    now={NOW}
    query=""
    onQueryChange={() => undefined}
    onStart={async () => undefined}
    onStop={async () => undefined}
    onOpenSettings={() => undefined}
    onCopy={async () => true}
    onDelete={async () => true}
    onClear={async () => true}
  />
}

it('redraws only the dictate bar, not the Journal, when the speaking gate changes while recording', () => {
  const { rerender } = render(roomWith(false))
  expect(screen.getByText('Transcript number 0')).toBeVisible()
  const drawn = clockLabel.calls
  expect(drawn).toBeGreaterThan(0)

  for (const speaking of [true, false, true, false]) rerender(roomWith(speaking))

  expect(clockLabel.calls).toBe(drawn)
})

it('redraws the wave alone, not the room, for each microphone level (#993)', () => {
  const level = new LiveLevelStore()
  render(roomWith(true, level))
  const drawn = clockLabel.calls
  const meter = document.querySelector('.voice-wave')!

  for (const value of [0.2, 0.5, 0.9, 0.3]) act(() => level.set(value))

  expect(meter).toHaveAttribute('aria-valuenow', '0.3')
  expect(clockLabel.calls).toBe(drawn)
})
