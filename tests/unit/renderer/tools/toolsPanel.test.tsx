import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState } from '../../../../src/shared/agents'
import { EMPTY_SUBAGENT_SUMMARY, type SubagentsBridge } from '../../../../src/shared/subagents'
import type { FilesBridge } from '../../../../src/shared/files'
import type { BrowserBridge, BrowserEvent, BrowserPage, BrowserTask } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { ToolsPanel, ToolsPanelToggle } from '../../../../src/renderer/src/tools/ToolsPanel'
import { MAX_RENDERED_MARKDOWN_LENGTH, trustedImageSource } from '../../../../src/renderer/src/tools/FilePreview'
import { ToolsPanelStore, TOOL_SURFACES } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { CloudIphoneStore } from '../../../../src/renderer/src/tools/cloudIphoneStore'
import type { CloudIphoneBridge, CloudEvent } from '../../../../src/shared/cloudIphone'
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

function setup(options: { focused?: string | null; bridge?: FilesBridge | undefined; state?: AgentState; inPane?: boolean; subagents?: SubagentsBridge; browser?: BrowserBridge; cloudBridge?: CloudIphoneBridge } = {}) {
  const { focused = 'visual-gate', state = threadsStateFixture(), inPane = false } = options
  const bridge = 'bridge' in options ? options.bridge : fakeFilesBridge(folders())
  const store = new ToolsPanelStore()
  const cloudStore = new CloudIphoneStore()
  const command = vi.fn()
  // With `inPane`, the toggle sits in the focused pane's header, as the workspace places it.
  const ui = (focusedThreadId: string | null) => <div className="thread-workspace__body">
    {inPane && focusedThreadId !== null
      ? <section key={focusedThreadId} className="thread-pane" data-thread-id={focusedThreadId}><ToolsPanelToggle store={store} state={state} /></section>
      : <ToolsPanelToggle store={store} state={state} />}
    <ToolsPanel focusedThreadId={focusedThreadId} state={state} command={command} files={bridge} subagents={options.subagents} browser={options.browser} store={store}
      cloudStore={cloudStore} cloudBridge={options.cloudBridge} />
  </div>
  const view = render(ui(focused))
  return { store, command, bridge, state, cloudStore, rerender: (next: string | null) => view.rerender(ui(next)) }
}

const cloudOk = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
/** A minimal cloud iPhone bridge for the rail dot tests: only `sessions` and `onEvent` are ever read. */
function fakeCloudBridgeForDots() {
  const listeners = new Set<(event: CloudEvent) => void>()
  const bridge: CloudIphoneBridge = {
    status: vi.fn(async () => cloudOk({ keySaved: true, month: '2026-10', monthMinutes: 0, capMinutes: 750, recent: [] })),
    setKey: vi.fn(), sessions: vi.fn(async () => cloudOk([])), answer: vi.fn(), end: vi.fn(), mount: vi.fn(async () => cloudOk(undefined)),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: CloudEvent) => { for (const listener of [...listeners]) listener(event) } }
}

const browserOk = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
/** A minimal browser bridge for the rail dot tests: only `tasks` and `list` are ever read. */
function fakeBrowserForDots(tasksByThread: Record<string, BrowserTask[]> = {}) {
  const listeners = new Set<(event: BrowserEvent) => void>()
  const bridge: BrowserBridge = {
    tasks: vi.fn(async ({ threadId }) => browserOk(tasksByThread[threadId] ?? [])),
    list: vi.fn(async ({ threadId }) => browserOk({ workspace: { threadId, projectId: 'workshop', workingDirectory: 'D:\\work', workspaceId: 'workspace' }, pages: [] })),
    create: vi.fn(async () => browserOk({} as BrowserPage)), navigate: vi.fn(async () => browserOk({} as BrowserPage)),
    back: vi.fn(async () => browserOk({} as BrowserPage)), forward: vi.fn(async () => browserOk({} as BrowserPage)),
    reload: vi.fn(async () => browserOk({} as BrowserPage)), close: vi.fn(async () => browserOk(undefined)),
    mount: vi.fn(async () => browserOk(undefined)), share: vi.fn(async () => browserOk({} as BrowserPage)), viewport: vi.fn(async () => browserOk({} as BrowserPage)),
    capture: vi.fn(async () => browserOk({ image: '', url: '', width: 0, height: 0, element: null })),
    controlTask: vi.fn(async () => browserOk({} as BrowserTask)), answerAction: vi.fn(async () => browserOk({} as BrowserTask)), stopGrant: vi.fn(async () => browserOk(undefined)),
    openLink: vi.fn(async () => browserOk({ destination: 'external' as const })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => { for (const listener of [...listeners]) listener(event) } }
}
const phoneTask = (patch: Partial<BrowserTask> = {}): BrowserTask => ({
  id: 'phone-task', threadId: 'visual-gate', workspaceId: 'workspace', pageId: '11111111-1111-4111-8111-111111111111',
  status: 'working', description: 'Checking the app', steps: [], thumbnail: null, summary: null, unchecked: [], updatedAt: 1,
  pendingAction: null, output: null, device: 'iphone', ...patch,
})

const panel = () => screen.getByRole('complementary', { name: 'Tools' })
const tree = () => within(panel()).getByRole('tree')
/** The working folder line; its folder names are separate spans so it wraps between them. */
const getPath = (path: string): HTMLElement => {
  const element = panel().querySelector<HTMLElement>('.tools-panel__path-text')
  expect(element?.textContent).toBe(path)
  return element!
}
const findPath = (path: string): Promise<HTMLElement> => waitFor(() => getPath(path))

describe('shared tools panel', () => {
  it('shows only the selected thread’s agents while another working copy is pinned, including after reopening', async () => {
    const subagents: SubagentsBridge = {
      page: vi.fn<SubagentsBridge['page']>(async ({ threadId }) => ({ threadId, revision: 1, summary: { ...EMPTY_SUBAGENT_SUMMARY, total: 1, completed: 1 }, rows: [{
        id: 'child', assignmentId: 'task', assignmentCount: 1, sequence: 1, revision: 1,
        title: threadId === 'visual-gate' ? 'Review Workshop' : 'Review Previews', description: '', status: 'completed', lastObservedAt: '2026-09-23T10:00:00Z',
      }] })),
      assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })),
      onChanged: vi.fn(() => () => undefined),
    }
    const { store, rerender, bridge } = setup({ inPane: true, subagents })
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }))
    await findPath('D:\\work\\workshop')
    await userEvent.click(within(panel()).getByRole('button', { name: /^Pin to / }))
    await userEvent.click(within(panel()).getByRole('tab', { name: 'Agents' }))
    expect(await screen.findByText('Review Workshop')).toBeVisible()
    rerender('grok-previews')
    expect(await screen.findByText('Review Previews')).toBeVisible()
    expect(screen.queryByText('Review Workshop')).toBeNull()
    expect(panel().querySelector('.tools-panel__thread-title')).toHaveTextContent('Grok voice previews')
    expect(await findPath('D:\\work\\previews-worktree')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Copy working folder path' }))
    expect(bridge?.copyPath).toHaveBeenCalledWith({ threadId: 'grok-previews', path: '', workspaceId: TOKEN_B })
    expect(within(panel()).queryByRole('button', { name: /^(Unpin from|Pin to) / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Tools' })).not.toHaveAttribute('data-pinned-elsewhere')
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('title', 'Tools')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(await screen.findByText('Review Previews')).toBeVisible()
    expect(screen.queryByText('Review Workshop')).toBeNull()
    await userEvent.click(within(panel()).getByRole('tab', { name: 'Files' }))
    expect(await findPath('D:\\work\\workshop')).toBeInTheDocument()
    expect(panel().querySelector('.tools-panel__thread-title')).toHaveTextContent('Visual gate flake')
    expect(store.getSnapshot().pinnedThreadId).toBe('visual-gate')
    store.subagents.dispose()
  })

  it('shows the selected thread’s empty roster, then no roster when selection clears despite a working-copy pin', async () => {
    const subagents: SubagentsBridge = {
      page: vi.fn(async ({ threadId }) => ({ threadId, revision: 1, summary: EMPTY_SUBAGENT_SUMMARY, rows: [] })),
      assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })),
      onChanged: vi.fn(() => () => undefined),
    }
    const { store, rerender } = setup({ inPane: true, subagents })
    act(() => { store.setOpen(true); store.pin('visual-gate'); store.setSurface('agents') })
    rerender('grok-previews')
    expect(await within(panel()).findByText('No agents spawned in this thread yet.')).toBeVisible()
    expect(subagents.page).toHaveBeenLastCalledWith({ threadId: 'grok-previews' })
    expect(panel().querySelector('.tools-panel__thread-title')).toHaveTextContent('Grok voice previews')
    rerender(null)
    expect(within(panel()).getByText('Open a thread to see its agents.')).toBeVisible()
    expect(within(panel()).queryByText('No agents spawned in this thread yet.')).toBeNull()
    expect(within(panel()).queryByRole('button', { name: /^(Unpin from|Pin to) / })).toBeNull()
    await userEvent.click(within(panel()).getByRole('tab', { name: 'Files' }))
    expect(await findPath('D:\\work\\workshop')).toBeInTheDocument()
    expect(store.getSnapshot().pinnedThreadId).toBe('visual-gate')
  })

  it('opens from the toggle with the implemented surfaces and focuses the open one', async () => {
    const { store } = setup()
    expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Collapsed tools' })).toBeNull()
    expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: 'Tools' })])
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-pressed', 'true')
    const rail = within(panel()).getByRole('tablist', { name: 'Tools' })
    expect(rail).toHaveAttribute('aria-orientation', 'vertical')
    const tabs = within(rail).getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(TOOL_SURFACES.map(surface => surface.label))
    expect(TOOL_SURFACES.map(surface => surface.id)).toEqual(['browser', 'iphone', 'terminal', 'files', 'changes', 'pull-request', 'agents'])
    // The tile's word is short; its name is the surface's own.
    expect(within(rail).getByRole('tab', { name: 'Pull request' })).toHaveTextContent('PR')
    expect(within(panel()).getByRole('tab', { name: 'Files' })).toHaveFocus()
    expect(within(panel()).getByRole('tabpanel')).toBeInTheDocument()
    expect(await findPath('D:\\work\\workshop')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    expect(store.getSnapshot().open).toBe(false)
    expect(screen.queryByRole('navigation', { name: 'Collapsed tools' })).toBeNull()
    expect(screen.getAllByRole('button')).toEqual([screen.getByRole('button', { name: 'Tools' })])
  })

  it('shows working agents for the selected thread while closed without switching tabs', () => {
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, subagentSummary: { ...EMPTY_SUBAGENT_SUMMARY, total: 1, working: 1 } } : thread)
    const { store, rerender } = setup({ state, inPane: true })
    const dot = () => document.querySelector('.tools-toggle__agents-dot')
    expect(dot()).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAccessibleDescription('Agents are working')
    expect(store.getSnapshot()).toMatchObject({ open: false, surface: 'files' })
    act(() => store.pin('visual-gate'))
    rerender('grok-previews')
    expect(dot()).toBeNull()
    act(() => store.unpin())
    expect(dot()).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ open: false, surface: 'files' })
  })

  it('follows the focused thread, keeps each thread’s browsing, and never sends agent commands', async () => {
    const { store, rerender, command } = setup()
    act(() => store.setOpen(true))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'src' }))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'app.ts' }))
    expect(await within(panel()).findByText('export const ready = true')).toBeInTheDocument()
    expect(within(panel()).getByText('Visual gate flake')).toBeInTheDocument()

    rerender('grok-previews')
    expect(await findPath('D:\\work\\previews-worktree')).toBeInTheDocument()
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
    await findPath('D:\\work\\workshop')
    expect(store.getSnapshot().pinnedThreadId).toBeNull()
    await userEvent.click(within(panel()).getByRole('button', { name: /^Pin to / }))
    rerender('grok-previews')
    expect(within(panel()).getByText('Pinned')).toBeInTheDocument()
    expect(getPath('D:\\work\\workshop')).toBeInTheDocument()
    await userEvent.click(within(panel()).getByRole('button', { name: /^Unpin from / }))
    expect(await findPath('D:\\work\\previews-worktree')).toBeInTheDocument()
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
    expect(getPath('D:\\work\\workshop-2')).toBeInTheDocument()
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
    expect(await findPath('D:\\work\\workshop')).toBeInTheDocument()
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

  it('returns focus straight to the toggle when Close is activated, docked, pinned or overlaid', async () => {
    const { store, rerender } = setup({ inPane: true })
    const toggle = () => screen.getByRole('button', { name: 'Tools' })
    const closeFromKeyboard = (): void => {
      const button = within(panel()).getByRole('button', { name: 'Close tools panel' })
      button.focus()
      // Enter activates a focused button as a click; focus must already be on the toggle when the panel unmounts.
      fireEvent.click(button)
      expect(screen.queryByRole('complementary', { name: 'Tools' })).toBeNull()
      expect(toggle()).toHaveFocus()
    }
    act(() => store.setOpen(true))
    await findPath('D:\\work\\workshop')
    closeFromKeyboard()

    act(() => { store.setOpen(true); store.pin('visual-gate') })
    rerender('grok-previews')
    expect(within(panel()).getByText('Pinned')).toBeInTheDocument()
    closeFromKeyboard()

    const area = document.querySelector('.thread-workspace__body') as HTMLElement
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 600 })
    act(() => store.setOpen(true))
    await waitFor(() => expect(panel()).toHaveAttribute('data-mode', 'overlay'))
    closeFromKeyboard()
    act(() => store.setOpen(true))
    fireEvent.keyDown(within(panel()).getAllByRole('tab')[0]!, { key: 'Escape' })
    expect(toggle()).toHaveFocus()
  })

  it('hands focus to a toggle the closing layout re-mounted, but never takes it from where the user went', async () => {
    const { store, rerender } = setup({ inPane: true })
    act(() => store.setOpen(true))
    await findPath('D:\\work\\workshop')
    within(panel()).getByRole('button', { name: 'Close tools panel' }).focus()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    // The panes re-lay out after closing and the header holding the toggle is replaced.
    rerender('grok-previews')
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveFocus()

    act(() => store.setOpen(true))
    within(panel()).getByRole('button', { name: 'Close tools panel' }).focus()
    fireEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    const elsewhere = document.body.appendChild(document.createElement('button'))
    elsewhere.focus()
    rerender('visual-gate')
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })

  it('names the working copy it reads: project and branch, with the whole actual folder to copy', async () => {
    const state = threadsStateFixture()
    const worktree = 'C:\\Users\\me\\AppData\\Roaming\\Sotto\\thread-worktrees\\f2a30b8c-b55b-41ac-878c-d81608f6afb0'
    const thread = state.host.threads.find(item => item.id === 'visual-gate')!
    Object.assign(thread, { nativeSessionStarted: false, workingDirectory: worktree,
      worktree: { mode: 'independent', status: 'ready', path: worktree, repositoryRoot: 'C:/workshop', branch: 'sotto/thread-f2a30b8c', dirty: false } })
    const data = folders()
    const bridge = fakeFilesBridge({ ...data, 'visual-gate': { ...data['visual-gate'], root: worktree } })
    const { store } = setup({ state, bridge })
    act(() => store.setOpen(true))
    const path = await findPath(worktree)
    expect(path).toHaveAttribute('title', worktree)
    expect(path).toHaveClass('tools-panel__accessible')
    const copy = panel().querySelector('.tools-panel__copy')!
    expect(copy.textContent).toBe('workshop\u00b7sotto/thread-f2a30b8c\u00b7Worktree')
    expect(copy.querySelector('.tools-panel__branch')).toHaveTextContent('sotto/thread-f2a30b8c')
    expect(copy).toHaveAttribute('title', 'workshop \u00b7 Branch sotto/thread-f2a30b8c \u00b7 Worktree')
    // The working copy is the panel's footer: one copy and one reveal for the folder, and nothing else there repeats the path.
    expect(copy.closest('footer')).toHaveClass('tools-panel__foot')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Copy working folder path' }))
    expect(bridge.copyPath).toHaveBeenCalledWith({ threadId: 'visual-gate', path: '', workspaceId: TOKEN_A })
    expect(panel().querySelector('footer')!.textContent!.split(worktree)).toHaveLength(2)
  })

  it('shows the pane\u2019s toggle as not its own while the panel is pinned to another thread', async () => {
    const { store, rerender } = setup({ inPane: true })
    const toggle = () => screen.getByRole('button', { name: 'Tools' })
    act(() => store.setOpen(true))
    await findPath('D:\\work\\workshop')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Pin to Visual gate flake' }))
    expect(toggle()).not.toHaveAttribute('data-pinned-elsewhere')
    rerender('grok-previews')
    await waitFor(() => expect(toggle()).toHaveAttribute('data-pinned-elsewhere'))
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveAttribute('aria-description', 'Showing Visual gate flake, pinned')
    expect(toggle()).toHaveAttribute('title', 'Tools are pinned to Visual gate flake')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Unpin from Visual gate flake' }))
    expect(toggle()).not.toHaveAttribute('data-pinned-elsewhere')
    expect(toggle()).not.toHaveAttribute('aria-description')
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
    expect(store.getSnapshot().width).toBe(696)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(store.getSnapshot().width).toBe(380)
  })
  it('moves along the rail with the arrow keys, Home and End, as a single tab stop', async () => {
    const { store } = setup()
    act(() => store.setOpen(true))
    const tab = (name: string) => within(panel()).getByRole('tab', { name })
    expect(within(panel()).getAllByRole('tab').filter(item => item.tabIndex === 0)).toEqual([tab('Files')])
    tab('Files').focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(tab('Changes')).toHaveFocus()
    expect(tab('Changes')).toHaveAttribute('aria-selected', 'true')
    expect(store.getSnapshot().surface).toBe('changes')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(tab('Terminal')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('iPhone')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('Browser')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(tab('Agents')).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    expect(tab('Browser')).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(tab('Agents')).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Home}')
    expect(tab('Browser')).toHaveFocus()
    expect(within(panel()).getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tools-tab-browser')
  })

  it('reads rail, then the surface’s line of chrome, then its work, then the working-copy footer', async () => {
    const { store } = setup()
    act(() => store.setOpen(true))
    const tree = await within(panel()).findByRole('tree')
    const order = [
      within(panel()).getByRole('tab', { name: 'Files' }),
      within(panel()).getByRole('button', { name: 'Close tools panel' }),
      within(panel()).getByRole('button', { name: 'Refresh files' }),
      tree,
      within(panel()).getByRole('button', { name: 'Copy working folder path' }),
    ]
    for (let index = 1; index < order.length; index++) {
      expect(order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    // The pin, fill and close buttons sit at the rail's foot, not above the work.
    const foot = panel().querySelector('.tools-rail__foot')!
    expect(within(foot as HTMLElement).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Pin to Visual gate flake', 'Expand tools panel', 'Close tools panel'])
    expect(panel().querySelectorAll('.tools-chrome')).toHaveLength(1)
    expect(panel().querySelector('.tools-chrome')).toHaveTextContent('Files')
  })

  it('marks a surface with something live, and says what in the surface’s description', () => {
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, subagentSummary: { ...EMPTY_SUBAGENT_SUMMARY, total: 3, working: 2 } } : thread)
    const { store, rerender } = setup({ state })
    act(() => store.setOpen(true))
    const agents = within(panel()).getByRole('tab', { name: 'Agents' })
    expect(agents).toHaveAccessibleDescription('2 agents are working')
    expect(agents.querySelector('.tools-rail__live')).not.toBeNull()
    expect(agents.querySelector('.tools-rail__live')).toHaveAttribute('aria-hidden', 'true')
    for (const name of ['Browser', 'Terminal', 'Files', 'Changes']) {
      const tab = within(panel()).getByRole('tab', { name })
      expect(tab.querySelector('.tools-rail__live')).toBeNull()
      expect(tab).not.toHaveAttribute('aria-description')
    }
    // The open surface keeps its words but draws no dot; its line of chrome already says what is live.
    act(() => store.setSurface('agents'))
    expect(agents).toHaveAccessibleDescription('2 agents are working')
    expect(agents.querySelector('.tools-rail__live')).toBeNull()
    act(() => store.setSurface('files'))
    expect(agents.querySelector('.tools-rail__live')).not.toBeNull()
    rerender('grok-previews')
    expect(within(panel()).getByRole('tab', { name: 'Agents' }).querySelector('.tools-rail__live')).toBeNull()
  })

  it('marks iPhone live for a task on the test iPhone, waiting or working, while Browser never lights for it', async () => {
    const browser = fakeBrowserForDots({ 'visual-gate': [phoneTask()] })
    const { store } = setup({ browser: browser.bridge })
    act(() => store.setOpen(true))
    const iphone = await within(panel()).findByRole('tab', { name: 'iPhone' })
    const browserTab = within(panel()).getByRole('tab', { name: 'Browser' })
    await waitFor(() => expect(iphone).toHaveAccessibleDescription('An agent is working on the test iPhone'))
    expect(iphone.querySelector('.tools-rail__live')).not.toBeNull()
    expect(browserTab).not.toHaveAttribute('aria-description')
    expect(browserTab.querySelector('.tools-rail__live')).toBeNull()

    act(() => browser.emit({ type: 'task', task: phoneTask({ updatedAt: 2, pendingAction: {
      id: '33333333-3333-4333-8333-333333333333', action: { type: 'tap', x: 10, y: 20 }, description: 'Tap at 10, 20', expiresAt: Date.now() + 10000,
    } }) }))
    expect(iphone).toHaveAccessibleDescription('A test iPhone request is waiting for your answer')
    expect(browserTab).not.toHaveAttribute('aria-description')
  })

  it('marks iPhone live for a cloud iPhone request waiting for an answer, then for a running session', async () => {
    const cloud = fakeCloudBridgeForDots()
    const { store } = setup({ cloudBridge: cloud.bridge })
    act(() => store.setOpen(true))
    const iphone = await within(panel()).findByRole('tab', { name: 'iPhone' })
    expect(iphone).not.toHaveAttribute('aria-description')
    act(() => cloud.emit({ type: 'session', session: {
      id: '11111111-1111-4111-8111-111111111111', threadId: 'visual-gate', workspaceId: 'workspace', status: 'asking',
      description: 'Checking a build', buildPath: 'apps/ios/build/Sotto.app.zip', buildBytes: 1000, device: null,
      expiresAt: Date.now() + 300_000, startedAt: null, endedAt: null, endReason: null, minutes: 0, problem: null, steps: [], summary: null, unchecked: [],
    } }))
    expect(iphone).toHaveAccessibleDescription('A cloud iPhone request is waiting for your answer')
    act(() => cloud.emit({ type: 'session', session: {
      id: '11111111-1111-4111-8111-111111111111', threadId: 'visual-gate', workspaceId: 'workspace', status: 'active',
      description: 'Checking a build', buildPath: 'apps/ios/build/Sotto.app.zip', buildBytes: 1000, device: 'iPhone 16',
      expiresAt: null, startedAt: Date.now(), endedAt: null, endReason: null, minutes: 1, problem: null, steps: [], summary: null, unchecked: [],
    } }))
    expect(iphone).toHaveAccessibleDescription('A cloud iPhone session is running')
  })

  it('expands the tool without losing the selected file, restores width and reopens from the header toggle', async () => {
    const { store } = setup({ inPane: true })
    const area = document.querySelector('.thread-workspace__body') as HTMLElement
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 1200 })
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }))
    await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
    const previous = panel().style.getPropertyValue('--tools-width')
    expect(previous).toBe('672px')
    await userEvent.click(within(panel()).getByRole('button', { name: 'Expand tools panel' }))
    expect(panel()).toHaveAttribute('data-expanded', 'true')
    expect(panel().style.getPropertyValue('--tools-width')).toBe('1200px')
    expect(document.querySelector<HTMLElement>('.thread-pane')!.inert).toBe(true)
    expect(within(panel()).getByRole('region', { name: 'Preview of README.md' })).toBeInTheDocument()
    fireEvent.keyDown(within(panel()).getByRole('button', { name: 'Restore tools panel' }), { key: 'Escape' })
    expect(panel()).not.toHaveAttribute('data-expanded')
    expect(panel().style.getPropertyValue('--tools-width')).toBe(previous)
    expect(document.querySelector<HTMLElement>('.thread-pane')!.inert).toBe(false)
    await userEvent.click(within(panel()).getByRole('button', { name: 'Expand tools panel' }))
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close tools panel' }))
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveFocus()
    expect(store.getSnapshot().expanded).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: 'Tools' }))
    expect(within(panel()).getByRole('region', { name: 'Preview of README.md' })).toBeInTheDocument()
  })

})

const FORGE = '22222222-2222-4222-8222-222222222222'
/** Every thread on a paired host saved here as forge. */
function onForge(): AgentState {
  const state = threadsStateFixture()
  state.connections = [{ hostId: FORGE, name: 'forge', kind: 'remote', connected: true }]
  state.host.threads = state.host.threads.map(thread => ({ ...thread, remoteHost: true, hostId: FORGE }))
  return state
}

it('keeps a paired host\'s terminal, browser and test iPhone on the host without starting them here', async () => {
  const { store } = setup({ state: onForge() })
  const terminals = vi.spyOn(store.terminals, 'activate'), browser = vi.spyOn(store.browser, 'activate')
  act(() => { store.setOpen(true); store.setSurface('terminal') })
  expect(await screen.findByText('Terminal is on the host machine.')).toBeVisible()
  expect(screen.getByRole('tab', { name: 'Terminal' })).toBeVisible()
  act(() => store.setSurface('browser'))
  expect(screen.getByText('Browser is on the host machine.')).toBeVisible()
  act(() => store.setSurface('iphone'))
  expect(screen.getByText('iPhone is on the host machine.')).toBeVisible()
  expect(terminals).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled()
})

it('shows a paired host\'s Files as a local thread\'s, with "on forge" in the footer and no Show in folder (ADR-0025, October 5 amendment)', async () => {
  const { store, bridge } = setup({ state: onForge() })
  act(() => { store.setOpen(true); store.setSurface('files') })
  await userEvent.click(await within(tree()).findByRole('treeitem', { name: 'README.md' }))
  const preview = await within(panel()).findByRole('region', { name: 'Preview of README.md' })
  expect(screen.queryByText('Files is on the host machine.')).toBeNull()
  expect(within(preview).queryByRole('button', { name: /^Show in / })).toBeNull()
  expect(within(panel()).queryByRole('button', { name: /^Show in .*: working folder$/u })).toBeNull()
  expect(panel().querySelector('.tools-panel__host')).toHaveTextContent('on forge')
  expect(panel().querySelector('.tools-panel__copy')).toHaveAttribute('title', expect.stringContaining('on forge'))
  // Copy path goes to main, which copies the host's own path.
  await userEvent.click(within(preview).getByRole('button', { name: 'Copy path of README.md' }))
  expect(bridge!.copyPath).toHaveBeenCalledWith({ threadId: 'visual-gate', path: 'README.md', workspaceId: TOKEN_A })
  expect(await within(panel()).findByText('Path copied')).toBeInTheDocument()
  await userEvent.click(within(panel()).getByRole('button', { name: 'Copy working folder path' }))
  expect(bridge!.copyPath).toHaveBeenLastCalledWith({ threadId: 'visual-gate', path: '', workspaceId: TOKEN_A })
  expect(bridge!.reveal).not.toHaveBeenCalled()
})

it('names no host in the footer and keeps Show in folder for a thread on this computer', async () => {
  const { store } = setup()
  act(() => { store.setOpen(true); store.setSurface('files') })
  await findPath('D:\\work\\workshop')
  expect(panel().querySelector('.tools-panel__host')).toBeNull()
  expect(within(panel()).getByRole('button', { name: 'Show in File Explorer: working folder' })).toBeVisible()
})

it('shows what a paired host said when it could not be read, such as the version sentence of a host from before these reads', async () => {
  const sentence = 'This host is running a different version of Sotto. Nothing on the host was lost. Update it from the Threads page, or put the Sotto 0.1.31 host in its installation folder, stop the host on that machine, then connect again.'
  const files = fakeFilesBridge(folders())
  vi.mocked(files.list).mockResolvedValue({ ok: false, error: { code: 'unavailable', message: sentence } })
  const subagents: SubagentsBridge = {
    page: vi.fn<SubagentsBridge['page']>(async () => { throw new Error(`Error invoking remote method 'sotto:subagents:page': Error: ${sentence}`) }),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })), onChanged: vi.fn(() => () => undefined),
  }
  const { store } = setup({ state: onForge(), bridge: files, subagents })
  act(() => { store.setOpen(true); store.setSurface('files') })
  expect(await within(panel()).findByText(sentence)).toBeVisible()
  expect(within(panel()).getByText('Files could not read the working folder.')).toBeVisible()
  act(() => store.setSurface('agents'))
  expect(await within(panel()).findByText(sentence)).toBeVisible()
})

it('reads a paired host\'s agents again when the thread\'s agent counts move, since its host pushes no roster changes', async () => {
  const state = onForge()
  state.host.threads = state.host.threads.map(thread => ({ ...thread, subagentSummary: { ...EMPTY_SUBAGENT_SUMMARY } }))
  const subagents: SubagentsBridge = {
    page: vi.fn<SubagentsBridge['page']>(async ({ threadId }) => ({ threadId, revision: 1, rows: [], summary: EMPTY_SUBAGENT_SUMMARY })),
    assignments: vi.fn(async ({ threadId, agentId }) => ({ threadId, agentId, assignments: [] })),
    onChanged: vi.fn(() => () => undefined),
  }
  const { store, rerender } = setup({ state, subagents })
  act(() => { store.setOpen(true); store.setSurface('agents') })
  expect(await screen.findByText('No agents spawned in this thread yet.')).toBeVisible()
  expect(subagents.page).toHaveBeenCalledOnce()
  rerender('visual-gate')
  expect(subagents.page).toHaveBeenCalledOnce()
  state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, subagentSummary: { ...EMPTY_SUBAGENT_SUMMARY, total: 1, working: 1 } } : thread)
  rerender('visual-gate')
  await waitFor(() => expect(subagents.page).toHaveBeenCalledTimes(2))
  expect(subagents.page).toHaveBeenLastCalledWith({ threadId: 'visual-gate' })
})
