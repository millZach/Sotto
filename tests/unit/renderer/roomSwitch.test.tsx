import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RoomSwitch } from '../../../src/renderer/src/agents/SidebarFrame'

// The sidebar's switch follows Watcher's gate and whether dictation is on (ADR-0107).
const rooms = vi.hoisted(() => ({ watcher: true, dictation: false }))
vi.mock('../../../src/renderer/src/state/watcherFeature', () => ({
  useWatcherEnabled: () => rooms.watcher,
}))
vi.mock('../../../src/renderer/src/state/dictationFeature', () => ({
  useDictationOn: () => rooms.dictation,
}))

afterEach(() => {
  cleanup()
  rooms.watcher = true
  rooms.dictation = false
})

describe('RoomSwitch with dictation off', () => {
  it('draws owl and Threads', () => {
    render(<RoomSwitch className="thread-nav__seg" />)
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('data-room'))).toEqual(['watcher', 'threads'])
  })

  it('draws nothing when Threads is the only room left', () => {
    rooms.watcher = false
    const { container } = render(<RoomSwitch className="thread-nav__seg" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws all three rooms while dictation is on', () => {
    rooms.dictation = true
    render(<RoomSwitch className="thread-nav__seg" />)
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('data-room'))).toEqual(['dictate', 'watcher', 'threads'])
  })
})
