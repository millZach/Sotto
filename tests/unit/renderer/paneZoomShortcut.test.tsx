import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { ThreadPanes } from '../../../src/renderer/src/agents/ThreadPanes'
import { openBeside, SINGLE_VIEW } from '../../../src/renderer/src/agents/splitLayout'

vi.mock('../../../src/renderer/src/state/AppContext', () => ({ useOptionalApp: vi.fn() }))
afterEach(cleanup)

describe('pane zoom shortcut', () => {
  it.each(['win32', 'darwin'] as const)('yields Control+Shift+M to dictation on %s and restores it after a settings change', platform => {
    const onLayoutChange = vi.fn()
    const layout = openBeside(SINGLE_VIEW, 'a', 'b')
    const view = () => <ThreadPanes layout={layout} paneIds={['a', 'b']} rows={new Map()} focusedId="a" dragging={null}
      measuredWidth={1200} measuredHeight={800} renderPane={() => <textarea aria-label="Prompt" />}
      onFocusPane={vi.fn()} onLayoutChange={onLayoutChange} onDrop={vi.fn()} onClosePane={vi.fn()} />
    const settings = (hotkey: string) => vi.mocked(useOptionalApp).mockReturnValue({ platform, settings: { hotkey } } as AppContextValue)
    settings('Control+Shift+M')
    const rendered = render(view())
    const zoom = screen.getAllByRole('button', { name: 'Zoom Pane pane' })[0]!
    expect(zoom).not.toHaveAttribute('aria-keyshortcuts')
    expect(zoom).toHaveAttribute('title', 'Zoom pane')
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, { key: 'M', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(onLayoutChange).not.toHaveBeenCalled()
    fireEvent.click(zoom)
    expect(onLayoutChange).toHaveBeenCalledOnce()
    onLayoutChange.mockClear()
    settings(platform === 'darwin' ? 'CommandOrControl+Shift+M' : 'Control+Shift+Space')
    rendered.rerender(view())
    expect(zoom).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+M')
    expect(zoom).toHaveAttribute('title', 'Zoom pane (Ctrl+Shift+M)')
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, { key: 'm', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(onLayoutChange).toHaveBeenCalledOnce()
  })
})
