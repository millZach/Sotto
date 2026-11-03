import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalApp, type AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { ThreadPanes, type PaneChrome } from '../../../src/renderer/src/agents/ThreadPanes'
import { openBeside, SINGLE_VIEW } from '../../../src/renderer/src/agents/splitLayout'

vi.mock('../../../src/renderer/src/state/AppContext', () => ({ useOptionalApp: vi.fn() }))
afterEach(cleanup)

/** A pane's ··· menu rows as plain buttons, as the header's menu presents them: the name, and the keys at the end. */
function Rows({ chrome }: { readonly chrome: PaneChrome }) {
  return <>{chrome.layout.map(item => <button key={item.id} type="button" aria-keyshortcuts={item.shortcut?.keys} data-keys={item.shortcut?.plain} onClick={item.run}>{item.label}</button>)}</>
}

describe('pane zoom shortcut', () => {
  // Zoom follows the mod pattern like every other thread chord (ADR-0133): Ctrl+Shift+M off a Mac, Cmd+Shift+M on one.
  // Zoom pane is a row of the pane's ··· menu (ADR-0163), with its keys at the row's end.
  it.each([
    ['win32', 'Control+Shift+M', 'Control+Shift+M', 'Ctrl+Shift+M', { key: 'M', ctrlKey: true, shiftKey: true }, { key: 'm', ctrlKey: true, shiftKey: true }],
    ['darwin', 'Command+Shift+M', 'Meta+Shift+M', 'Cmd+Shift+M', { key: 'M', metaKey: true, shiftKey: true }, { key: 'm', metaKey: true, shiftKey: true }],
  ] as const)('yields its chord to dictation on %s and restores it after a settings change', (platform, held, keys, plain, heldEvent, freeEvent) => {
    const onLayoutChange = vi.fn()
    const layout = openBeside(SINGLE_VIEW, 'a', 'b')
    const view = () => <ThreadPanes layout={layout} paneIds={['a', 'b']} rows={new Map()} focusedId="a" dragging={null}
      measuredWidth={1200} measuredHeight={800} renderPane={(_id, chrome) => <><Rows chrome={chrome} /><textarea aria-label="Prompt" /></>}
      onFocusPane={vi.fn()} onLayoutChange={onLayoutChange} onDrop={vi.fn()} onClosePane={vi.fn()} />
    const settings = (hotkey: string) => vi.mocked(useOptionalApp).mockReturnValue({ platform, settings: { hotkey } } as AppContextValue)
    settings(held)
    const rendered = render(view())
    const zoom = screen.getAllByRole('button', { name: 'Zoom pane' })[0]!
    expect(zoom).not.toHaveAttribute('aria-keyshortcuts')
    expect(zoom).not.toHaveAttribute('data-keys')
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, heldEvent)).toBe(true)
    expect(onLayoutChange).not.toHaveBeenCalled()
    fireEvent.click(zoom)
    expect(onLayoutChange).toHaveBeenCalledOnce()
    onLayoutChange.mockClear()
    settings('Control+Shift+Space')
    rendered.rerender(view())
    expect(zoom).toHaveAttribute('aria-keyshortcuts', keys)
    expect(zoom).toHaveAttribute('data-keys', plain)
    expect(fireEvent.keyDown(screen.getAllByRole('textbox')[0]!, freeEvent)).toBe(false)
    expect(onLayoutChange).toHaveBeenCalledOnce()
  })
})
