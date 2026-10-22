import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DictationRecord } from '../../../src/shared/dictationRecord'
import type { HistoryEntry } from '../../../src/shared/history'
import { DEFAULT_SETTINGS } from '../../../src/shared/settings'

// Every Journal row reads its clock label once per draw, so counting the calls counts the rows drawn.
const clockLabel = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../../src/renderer/src/features/dictate/journalFacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/features/dictate/journalFacts')>()
  return { ...actual, clockLabel: (...args: Parameters<typeof actual.clockLabel>) => { clockLabel.calls += 1; return actual.clockLabel(...args) } }
})

const { DictateRoom } = await import('../../../src/renderer/src/features/dictate/DictateRoom')

afterEach(cleanup)

const NOW = new Date(2026, 9, 21, 16, 20).valueOf()
const entries: HistoryEntry[] = Array.from({ length: 40 }, (_, index) => ({
  id: `entry-${index}`, text: `Transcript number ${index}`, createdAt: NOW - index * 60_000, durationMs: 4_000, language: 'en', modelPreset: 'parakeet',
}))
const records: DictationRecord[] = entries.map((entry) => ({ id: entry.id, createdAt: entry.createdAt, durationMs: entry.durationMs, words: 3, app: 'Slack' }))

// The app hands the room new handlers each time its state changes, as App does on every microphone level.
function roomWith(level: number): React.ReactElement {
  return <DictateRoom
    settings={{ ...DEFAULT_SETTINGS, onboardingComplete: true }}
    speechModel={{ state: 'ready' }}
    platform="win32"
    dictation={{ status: 'listening', sessionId: 'live', startedAt: NOW, level }}
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

it('redraws only the dictate bar, not the Journal, when the microphone level changes while recording', () => {
  const { rerender } = render(roomWith(0.1))
  expect(screen.getByText('Transcript number 0')).toBeVisible()
  const drawn = clockLabel.calls
  expect(drawn).toBeGreaterThan(0)

  for (const level of [0.2, 0.5, 0.9, 0.3]) rerender(roomWith(level))

  expect(clockLabel.calls).toBe(drawn)
})
