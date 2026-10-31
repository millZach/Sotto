import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DIVIDER_WIDTH, MIN_PANE_WIDTH } from '../../../src/renderer/src/agents/splitLayout'
import { BesideDivider, roomView, shownShare, useRoomView } from '../../../src/renderer/src/watcher/WatcherBeside'
import { RoomViewStore, WATCHER_SHARE_STORAGE_KEY } from '../../../src/renderer/src/watcher/watcherRoomView'

class MemoryStorage {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  setItem(key: string, value: string): void { this.items.set(key, value) }
}

const WIDTH = 1600
function Divider() {
  const { share } = useRoomView()
  return <BesideDivider width={WIDTH} share={share} controls="beside-pane" />
}

beforeEach(() => { roomView.set({ besideId: null, share: 0.5 }) })
afterEach(() => { cleanup(); localStorage.clear() })

describe('Watcher split persistence', () => {
  it('keeps the same share when another thread replaces the beside pane, it closes, or Sotto restarts', () => {
    const storage = new MemoryStorage()
    const store = new RoomViewStore(storage)
    store.set({ besideId: 'a', share: 0.3 })
    store.set({ besideId: 'b' })
    expect(store.get()).toEqual({ besideId: 'b', share: 0.3 })
    store.set({ besideId: null })
    store.set({ besideId: 'c' })
    expect(store.get()).toEqual({ besideId: 'c', share: 0.3 })
    expect([...storage.items.keys()]).toEqual([WATCHER_SHARE_STORAGE_KEY])
    const restarted = new RoomViewStore(storage)
    expect(restarted.get()).toEqual({ besideId: null, share: 0.3 })
    restarted.set({ besideId: 'd' })
    expect(restarted.get()).toEqual({ besideId: 'd', share: 0.3 })
  })

  it.each([null, 'not json', 'null', '"0.3"', '[0.3]', '0', '1', '-1', '1.1', '1e400'])('uses the default when the saved share is %s', text => {
    const storage = new MemoryStorage()
    if (text !== null) storage.setItem(WATCHER_SHARE_STORAGE_KEY, text)
    expect(new RoomViewStore(storage).get()).toEqual({ besideId: null, share: 0.5 })
  })

  it.each([0.01, 0.99])('keeps a saved share of %s within both panes’ minimum widths without forgetting it', share => {
    const storage = new MemoryStorage()
    storage.setItem(WATCHER_SHARE_STORAGE_KEY, JSON.stringify(share))
    const store = new RoomViewStore(storage)
    const minimum = MIN_PANE_WIDTH / (WIDTH - DIVIDER_WIDTH)
    const shown = shownShare(WIDTH, store.get().share)
    expect(shown).toBeGreaterThanOrEqual(minimum)
    expect(shown).toBeLessThanOrEqual(1 - minimum)
    expect(shownShare(700, store.get().share)).toBe(0.5)
    expect(shownShare(100_000, store.get().share)).toBe(share)
    expect(new RoomViewStore(storage).get().share).toBe(share)
  })

  it('keeps resizing in memory when storage cannot be read or written', () => {
    const store = new RoomViewStore({
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    expect(store.get().share).toBe(0.5)
    store.set({ share: 0.3 })
    store.set({ besideId: 'b' })
    expect(store.get()).toEqual({ besideId: 'b', share: 0.3 })
  })
})

describe('Watcher divider controls', () => {
  it('remembers keyboard resizing, both bounds and the even reset', () => {
    render(<Divider />)
    const divider = screen.getByRole('separator', { name: 'Resize panes' })
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '45')
    expect(new RoomViewStore(localStorage).get().share).toBeCloseTo(0.45)
    fireEvent.keyDown(divider, { key: 'Home' })
    expect(new RoomViewStore(localStorage).get().share).toBeCloseTo(MIN_PANE_WIDTH / (WIDTH - DIVIDER_WIDTH))
    fireEvent.keyDown(divider, { key: 'End' })
    expect(new RoomViewStore(localStorage).get().share).toBeCloseTo(1 - MIN_PANE_WIDTH / (WIDTH - DIVIDER_WIDTH))
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(divider).toHaveAttribute('aria-valuenow', '50')
    expect(new RoomViewStore(localStorage).get().share).toBe(0.5)
  })

  it('remembers a drag after leaving the room, reopening it and restarting, and saves a double-click reset', () => {
    const view = render(<Divider />)
    const divider = screen.getByRole('separator', { name: 'Resize panes' })
    Object.assign(divider, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0 })
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: (WIDTH - DIVIDER_WIDTH) * 0.3 + DIVIDER_WIDTH / 2 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '30')
    expect(divider).not.toHaveAttribute('data-dragging')
    expect(new RoomViewStore(localStorage).get().share).toBeCloseTo(0.3)
    view.unmount()
    roomView.set({ besideId: 'another-thread' })
    render(<Divider />)
    const reopened = screen.getByRole('separator', { name: 'Resize panes' })
    expect(reopened).toHaveAttribute('aria-valuenow', '30')
    fireEvent.doubleClick(reopened)
    expect(new RoomViewStore(localStorage).get().share).toBe(0.5)
  })
})
