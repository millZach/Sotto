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

describe('RoomSwitch drawn iconOnly, as the sidebar foot draws it', () => {
  it('shows no name on any tile, the lit one too, and names every tile on hover', () => {
    rooms.dictation = true
    const { container } = render(<RoomSwitch className="thread-nav__seg" iconOnly />)
    expect(container.querySelectorAll('.room-tab__name')).toHaveLength(0)
    expect(screen.getAllByRole('tab').map(tab => [tab.getAttribute('aria-label'), tab.getAttribute('title')])).toEqual([
      ['Dictate', 'Dictate'], ['Watcher', 'Watcher'], ['Threads', 'Threads'],
    ])
    expect(screen.getByRole('tab', { selected: true })).toHaveAttribute('data-room', 'threads')
  })

  it('keeps the lit name where it is not iconOnly, as where a switch shows its lit room's name', () => {
    const { container } = render(<RoomSwitch className="thread-nav__seg" />)
    expect(container.querySelectorAll('.room-tab__name')).toHaveLength(2)
    expect(screen.getByRole('tab', { selected: true })).not.toHaveAttribute('title')
  })
})
