import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { ThreadPanes } from '../../../src/renderer/src/agents/ThreadPanes'
import { openBeside, SINGLE_VIEW } from '../../../src/renderer/src/agents/splitLayout'

vi.mock('../../../src/renderer/src/state/AppContext', () => ({ useOptionalApp: vi.fn() }))
afterEach(cleanup)

describe('pane zoom shortcut', () => {
  // Zoom follows the mod pattern like every other thread chord (ADR-0133): Ctrl+Shift+M off a Mac, Cmd+Shift+M on one.
  it.each([
    ['win32', 'Control+Shift+M', 'Control+Shift+M', 'Zoom pane (Ctrl+Shift+M)', { key: 'M', ctrlKey: true, shiftKey: true }, { key: 'm', ctrlKey: true, shiftKey: true }],
    ['darwin', 'Command+Shift+M', 'Meta+Shift+M', 'Zoom pane (Cmd+Shift+M)', { key: 'M', metaKey: true, shiftKey: true }, { key: 'm', metaKey: true, shiftKey: true }],
  ] as const)('yields its chord to dictation on %s and restores it after a settings change', (platform, held, keys, title, heldEvent, freeEvent) => {
    const onLayoutChange = vi.fn()
    const layout = openBeside(SINGLE_VIEW, 'a', 'b')
    const view = () => <ThreadPanes layout={layout} paneIds={['a', 'b']} rows={new Map()} focusedId="a" dragging={null}
      measuredWidth={1200} measuredHeight={800} renderPane={() => <textarea aria-label="Prompt" />}
      onFocusPane={vi.fn()} onLayoutChange={onLayoutChange} onDrop={vi.fn()} onClosePane={vi.fn()} />
    const settings = (hotkey: string) => vi.mocked(useOptionalApp).mockReturnValue({ platform, settings: { hotkey } } as AppContextValue)
    settings(held)
    const rendered = render(view())
    const zoom = screen.getAllByRole('button', { name: 'Zoom Pane pane' })[0]!
    expect(zoom).not.toHaveAttribute('aria-keyshortcuts')
    expect(zoom).toHaveAttribute('title', 'Zoom pane')
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, heldEvent)).toBe(true)
    expect(onLayoutChange).not.toHaveBeenCalled()
    fireEvent.click(zoom)
    expect(onLayoutChange).toHaveBeenCalledOnce()
    onLayoutChange.mockClear()
    settings('Control+Shift+Space')
    rendered.rerender(view())
    expect(zoom).toHaveAttribute('aria-keyshortcuts', keys)
    expect(zoom).toHaveAttribute('title', title)
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, freeEvent)).toBe(false)
    expect(onLayoutChange).toHaveBeenCalledOnce()
  })
})
