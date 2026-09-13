import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../../src/shared/agents'
import type { FilesBridge } from '../../../../src/shared/files'
import { ToolsPanel, ToolsPanelToggle } from '../../../../src/renderer/src/tools/ToolsPanel'
import { MAX_RENDERED_MARKDOWN_LENGTH, trustedImageSource } from '../../../../src/renderer/src/tools/FilePreview'
import { ToolsPanelStore, TOOL_SURFACES } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../liveAgentState'
import { TOKEN_A, TOKEN_B, fakeFilesBridge, markdown, text } from './fakeFilesBridge'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII='

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function folders() {
  return {
    'visual-gate': { root: 'D:\\work\\workshop', token: TOKEN_A, tree: {
      src: { kind: 'directory' as const }, 'src/app.ts': { kind: 'file' as const, content: text('export const ready = true') },
      'README.md': { kind: 'file' as const, content: markdown('# Workshop\n\n<script>window.injected = true</script>\n\n![remote](https://example.com/x.png)') },
      'logo.png': { kind: 'file' as const, content: { kind: 'image' as const, mime: 'image/png' as const, dataUrl: PNG } },
      'blob.bin': { kind: 'fail' as const, error: 'binary' as const, as: 'file' as const },
      'huge.log': { kind: 'fail' as const, error: 'too-large' as const, as: 'file' as const },
    } },
    'grok-previews': { root: 'D:\\work\\previews-worktree', token: TOKEN_B, tree: { 'notes.txt': { kind: 'file' as const, content: text('notes') } } },
  }
}

function setup(options: { focused?: string | null; bridge?: FilesBridge | undefined; state?: AgentState } = {}) {
  const { focused = 'visual-gate', state = threadsStateFixture() } = options
  const bridge = 'bridge' in options ? options.bridge : fakeFilesBridge(folders())
  const store = new ToolsPanelStore()
  const command = vi.fn()
  const ui = (focusedThreadId: string | null) => <div className="thread-workspace__body">
    <ToolsPanelToggle store={store} />
    <ToolsPanel focusedThreadId={focusedThreadId} state={state} command={command} files={bridge} store={store} />
  </div>
  const view = render(ui(focused))
  return { store, command, bridge, state, rerender: (next: string | null) => view.rerender(ui(next)) }
}

const panel = () => screen.getByRole('complementary', { name: 'Tools' })
const tree = () => within(panel()).getByRole('tree')

describe('shared tools panel', () => {
  it('opens from the toggle with only the implemented Files surface and focuses its tab', async () => {
    const { store } = setup()
    expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true')
    const tabs = within(panel()).getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['Files'])
    expect(TOOL_SURFACES).toHaveLength(1)
    expect(tabs[0]).toHaveFocus()
    expect(within(panel()).getByRole('tabpanel')).toBeInTheDocument()
    expect(await within(panel()).findByText('D:\\work\\workshop')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    expect(store.getSnapshot().open).toBe(false)
  })

  it('follows the focused thread, keeps each thread’s browsing, and never sends agent commands', async () => {
    const { store, rerender, command } = setup()
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'src' }))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'app.ts' }))
    expect(await within(panel()).findByText('export const ready = true')).toBeInTheDocument()
    expect(within(panel()).getByText('Visual gate flake')).toBeInTheDocument()

    rerender('grok-previews')
    expect(await within(panel()).findByText('D:\\work\\previews-worktree')).toBeInTheDocument()
    expect(await within(tree()).findByRole('treeitem', { name: 'notes.txt' })).toBeInTheDocument()
    expect(within(panel()).queryByText('export const ready = true')).toBeNull()

    rerender('visual-gate')
    expect(within(tree()).getByRole('treeitem', { name: 'src' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(tree()).getByRole('treeitem', { name: 'app.ts' })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel()).getByText('export const ready = true')).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })

  it('stays on a pinned thread while focus moves and follows again when unpinned', async () => {
    const { store, rerender } = setup()
    act(() => store.setOpen(true))
    await within(panel()).findByText('D:\\work\\workshop')
    expect(store.getSnapshot().pinnedThreadId).toBeNull()
    await userEvent.click(within(panel()).getByRole('button', { name: /^Pin to / }))
    rerender('grok-previews')
    expect(within(panel()).getByText('Pinned')).toBeInTheDocument()
    expect(within(panel()).getByText('D:\\work\\workshop')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: /^Unpin from / }))
    expect(await within(panel()).findByText('D:\\work\\previews-worktree')).toBeInTheDocument()
    expect(within(panel()).queryByText('Pinned')).toBeNull()
  })

  it('browses with the keyboard as a single-tab-stop tree', async () => {
    const { store } = setup()
    act(() => store.setOpen(true))
    const first = await within(tree()).findByRole('treeitem', { name: 'src' })
    expect(within(tree()).getAllByRole('treeitem').filter(item => item.tabIndex === 0)).toHaveLength(1)
    first.focus()
    await userEvent.keyboard('{ArrowRight}')
    const child = await within(tree()).findByRole('treeitem', { name: 'app.ts' })
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(child).toHaveFocus())
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(within(tree()).getByRole('treeitem', { name: 'src' })).toHaveFocus())
    await userEvent.keyboard('{ArrowLeft}')
    expect(within(tree()).queryByRole('treeitem', { name: 'app.ts' })).toBeNull()
    await userEvent.keyboard('{End}{Enter}')
    expect(await within(panel()).findByRole('region', { name: 'Preview of README.md' })).toBeInTheDocument()
  })

  it('renders Markdown through the safe renderer with a source view, and raster images only from main', async () => {
    const { store } = setup()
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
    const preview = await within(panel()).findByRole('region', { name: 'Preview of README.md' })
    expect(await within(preview).findByRole('heading', { name: 'Workshop' })).toBeInTheDocument()
    expect(within(preview).getByText('<script>window.injected = true</script>')).toBeInTheDocument()
    expect(preview.querySelector('script, img, iframe')).toBeNull()
    expect(within(preview).getByRole('img', { name: 'Image not loaded: remote' })).toBeInTheDocument()
    await userEvent.click(within(preview).getByRole('button', { name: 'Source' }))
    expect(within(preview).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true')
    expect(preview.querySelector('pre')?.textContent).toContain('# Workshop')

    await userEvent.click(within(tree()).getByRole('treeitem', { name: 'logo.png' }))
    const image = await within(panel()).findByRole('img', { name: 'logo.png' })
    expect(image).toHaveAttribute('src', PNG)
    expect(trustedImageSource({ kind: 'image', mime: 'image/jpeg', dataUrl: PNG })).toBeNull()
    expect(trustedImageSource({ kind: 'image', mime: 'image/png', dataUrl: 'file:///C:/x.png' })).toBeNull()
  })

  it('shows long Markdown as source', async () => {
    const data = folders()
    data['visual-gate'].tree['README.md'] = { kind: 'file', content: markdown(`# Big\n${'x'.repeat(MAX_RENDERED_MARKDOWN_LENGTH)}`) }
    const { store } = setup({ bridge: fakeFilesBridge(data) })
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
    expect(await within(panel()).findByText('Long Markdown is shown as source.')).toBeInTheDocument()
    expect(within(panel()).queryByRole('button', { name: 'Source' })).toBeNull()
  })

  it('explains binary, oversized and missing files with a way back', async () => {
    const data = folders()
    const bridge = fakeFilesBridge(data)
    const { store } = setup({ bridge })
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'blob.bin' }))
    expect(await within(panel()).findByText('No preview for this file.')).toBeInTheDocument()
    await userEvent.click(within(tree()).getByRole('treeitem', { name: 'huge.log' }))
    expect(await within(panel()).findByText('Too large to preview.')).toBeInTheDocument()
    expect(within(panel()).getByText('fake too-large')).toBeInTheDocument()

    await userEvent.click(within(tree()).getByRole('treeitem', { name: 'src' }))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'app.ts' }))
    await within(panel()).findByText('export const ready = true')
    delete (data['visual-gate'].tree as Record<string, unknown>)['src/app.ts']
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refresh files' }))
    expect(await within(panel()).findByText('This file is no longer here.')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Refresh folder' }))
    await waitFor(() => expect(within(panel()).queryByRole('region', { name: /Preview of/ })).toBeNull())
    expect(within(tree()).queryByRole('treeitem', { name: 'app.ts' })).toBeNull()
  })

  it('copies and reveals paths through main with the workspace ID', async () => {
    const { store, bridge } = setup()
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
    const preview = await within(panel()).findByRole('region', { name: 'Preview of README.md' })
    await userEvent.click(within(preview).getByRole('button', { name: 'Copy path of README.md' }))
    expect(bridge!.copyPath).toHaveBeenCalledWith({ threadId: 'visual-gate', path: 'README.md', workspaceId: TOKEN_A })
    expect(await within(panel()).findByText('Path copied')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Show in File Explorer: working folder' }))
    expect(bridge!.reveal).toHaveBeenCalledWith({ threadId: 'visual-gate', path: '', workspaceId: TOKEN_A })
  })

  it('resets and explains a replaced working folder', async () => {
    const data = folders()
    const { store } = setup({ bridge: fakeFilesBridge(data) })
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
    await within(panel()).findByRole('region', { name: 'Preview of README.md' })
    data['visual-gate'] = { root: 'D:\\work\\workshop-2', token: 'c'.repeat(64), tree: { 'fresh.txt': { kind: 'file', content: text('fresh') } } } as never
    await userEvent.click(within(tree()).getByRole('treeitem', { name: 'logo.png' }))
    expect(await within(panel()).findByText('The working folder changed, so Files started over.')).toBeInTheDocument()
    expect(await within(tree()).findByRole('treeitem', { name: 'fresh.txt' })).toBeInTheDocument()
    expect(within(panel()).queryByRole('region', { name: /Preview of/ })).toBeNull()
    expect(within(panel()).getByText('D:\\work\\workshop-2')).toBeInTheDocument()
  })

  it('has recoverable states with no thread, a missing pinned thread, no bridge or an unavailable folder', async () => {
    const empty = setup({ focused: null })
    act(() => empty.store.setOpen(true))
    expect(within(panel()).getByText('Open a thread to browse its files.')).toBeInTheDocument()
    cleanup()

    const state = threadsStateFixture()
    const pinned = setup({ state })
    act(() => { pinned.store.setOpen(true); pinned.store.pin('removed-thread') })
    expect(within(panel()).getByText('The pinned thread is no longer listed.')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Unpin' }))
    expect(await within(panel()).findByText('D:\\work\\workshop')).toBeInTheDocument()
    cleanup()

    const bridgeless = setup({ bridge: undefined })
    act(() => bridgeless.store.setOpen(true))
    expect(await within(panel()).findByText('Files is not available in this window.')).toBeInTheDocument()
    cleanup()

    const unavailable = fakeFilesBridge(folders())
    vi.mocked(unavailable.list).mockResolvedValueOnce({ ok: false, error: { code: 'workspace-unavailable', message: 'not ready' } })
    const folder = setup({ bridge: unavailable })
    act(() => folder.store.setOpen(true))
    expect(await within(panel()).findByText('The working folder is not available.')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Retry' }))
    expect(await within(tree()).findByRole('treeitem', { name: 'src' })).toBeInTheDocument()
  })

  it('overlays the panes instead of shrinking them below a readable width, and Escape closes the overlay', async () => {
    const { store } = setup()
    const area = document.querySelector('.thread-workspace__body') as HTMLElement
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 600 })
    act(() => store.setOpen(true))
    await waitFor(() => expect(panel()).toHaveAttribute('data-mode', 'overlay'))
    fireEvent.keyDown(within(panel()).getAllByRole('tab')[0]!, { key: 'Escape' })
    expect(store.getSnapshot().open).toBe(false)
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 1200 })
    act(() => store.setOpen(true))
    await waitFor(() => expect(panel()).toHaveAttribute('data-mode', 'docked'))
    const handle = within(panel()).getByRole('separator', { name: 'Resize tools panel' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(store.getSnapshot().width).toBe(404)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(store.getSnapshot().width).toBe(320)
  })
})
