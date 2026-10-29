import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PageLinks, RoomSwitch } from '../../../src/renderer/src/agents/SidebarFrame'

// The sidebar's switch follows Watcher's gate and whether dictation is on (ADR-0107).
const rooms = vi.hoisted(() => ({ watcher: true, dictation: false }))
vi.mock('../../../src/renderer/src/state/watcherFeature', () => ({
  useWatcherEnabled: () => rooms.watcher,
}))
vi.mock('../../../src/renderer/src/state/dictationFeature', () => ({
  useDictationOn: () => rooms.dictation,
}))

// Loaded settings give the page shortcuts' keys to the tabs and links (ADR-0158); none loaded gives none.
const app = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: () => app.value,
}))
const loaded = (threadShortcuts: Record<string, string | null> = {}) => ({
  settings: { threadShortcuts, hotkey: 'CommandOrControl+Shift+Space', pressShortcuts: [], holdShortcuts: [] },
  platform: 'win32', navigation: 'threads', update: null, actions: { navigate: vi.fn() },
})

afterEach(() => {
  cleanup()
  rooms.watcher = true
  rooms.dictation = false
  app.value = null
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

  it('keeps the lit name where it is not iconOnly, as where a switch shows the name of its lit room', () => {
    const { container } = render(<RoomSwitch className="thread-nav__seg" />)
    expect(container.querySelectorAll('.room-tab__name')).toHaveLength(2)
    expect(screen.getByRole('tab', { selected: true })).not.toHaveAttribute('title')
  })
})

describe('the keys that open each room and page (ADR-0158)', () => {
  it('names each room’s page shortcut in its title and aria-keyshortcuts', () => {
    rooms.dictation = true
    app.value = loaded()
    render(<RoomSwitch className="thread-nav__seg" iconOnly />)
    expect(screen.getAllByRole('tab').map(tab => [tab.getAttribute('title'), tab.getAttribute('aria-keyshortcuts')])).toEqual([
      ['Dictate (Ctrl+1)', 'Control+1'], ['Watcher (Ctrl+2)', 'Control+2'], ['Threads (Ctrl+3)', 'Control+3'],
    ])
  })

  it('names Settings’ shortcut on its page link, and none where the keys stand down or were removed', () => {
    rooms.dictation = true
    app.value = loaded({ 'new-thread': 'mod+1', 'page-settings': null })
    render(<><RoomSwitch className="thread-nav__seg" iconOnly /><PageLinks className="pages" linkClassName="page" /></>)
    expect(screen.getByRole('tab', { name: 'Dictate' })).not.toHaveAttribute('aria-keyshortcuts')
    expect(screen.getByRole('tab', { name: 'Dictate' })).toHaveAttribute('title', 'Dictate')
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-keyshortcuts')
    cleanup()
    app.value = loaded()
    render(<PageLinks className="pages" linkClassName="page" />)
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-keyshortcuts', 'Control+5')
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('title', 'Settings (Ctrl+5)')
  })
})
