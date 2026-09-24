import React from 'react'
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentState, AgentThread } from '../../../../src/shared/agents'
import type { GitStatus } from '../../../../src/shared/gitStatus'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../src/shared/settings'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import { useDiffPreferences, useMergeMethod } from '../../../../src/renderer/src/state/gitSettings'
import { ProactiveChangesWatch, useProactiveChanges } from '../../../../src/renderer/src/tools/proactivePanels'
import { ToolsPanel } from '../../../../src/renderer/src/tools/ToolsPanel'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../liveAgentState'
import { fakeFilesBridge } from './fakeFilesBridge'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(() => null),
}))

afterEach(() => { cleanup(); vi.mocked(useOptionalApp).mockReset().mockReturnValue(null) })

function withSettings(settings: Partial<AppSettings>, updateSettings = vi.fn(async () => true)) {
  vi.mocked(useOptionalApp).mockReturnValue({ settings: { ...DEFAULT_SETTINGS, ...settings }, actions: { updateSettings } } as unknown as AppContextValue)
  return updateSettings
}

const git = (changedFiles: number, lines: number, readAt: string): GitStatus => ({
  isRepository: true, branch: 'feature', upstream: null, hasRemote: false, defaultBranch: 'main', isDefaultBranch: false, dirty: changedFiles > 0,
  changedFiles, insertions: lines, deletions: 0, ahead: 0, behind: 0, aheadOfDefault: null, pullRequest: null, fetchedAt: null, readAt,
})
const thread = (id: string, status: AgentThread['status'], status_: GitStatus, extra: Partial<AgentThread> = {}): AgentThread => ({
  id, projectId: 'project', title: id, modelId: 'model', status, messages: [], requests: [],
  worktree: { mode: 'shared', status: 'ready', path: '/repo', git: status_ }, ...extra,
})

describe('the large-turn watch behind Proactive panels', () => {
  it('counts a turn as large at 3 files or 50 lines more than it started with, once, from the read after it ends', () => {
    const watch = new ProactiveChangesWatch()
    expect(watch.observe([thread('a', 'running', git(1, 10, 't0'))], 0)).toEqual([])
    // The turn ends before the host has read the folder again: not yet.
    expect(watch.observe([thread('a', 'idle', git(1, 10, 't0'))], 10)).toEqual([])
    expect(watch.observe([thread('a', 'idle', git(4, 12, 't1'))], 20)).toEqual(['a'])
    expect(watch.observe([thread('a', 'idle', git(9, 90, 't2'))], 30)).toEqual([]) // counted once
    // Lines alone are enough.
    watch.observe([thread('a', 'running', git(4, 12, 't2'))], 40)
    expect(watch.observe([thread('a', 'idle', git(4, 62, 't3'))], 50)).toEqual(['a'])
  })
  it('lets a small turn go at the first read after it, or after a minute with none, and ignores a paired host', () => {
    const watch = new ProactiveChangesWatch()
    watch.observe([thread('a', 'running', git(0, 0, 't0')), thread('remote', 'running', git(0, 0, 't0'), { remoteHost: { hostId: '00000000-0000-4000-8000-000000000001', name: 'Build box' } } as Partial<AgentThread>)], 0)
    // The turn ends on the status read before it did; the host reads the folder again just after.
    expect(watch.observe([thread('a', 'idle', git(0, 0, 't0')), thread('remote', 'idle', git(10, 500, 't1'), { remoteHost: { hostId: '00000000-0000-4000-8000-000000000001', name: 'Build box' } } as Partial<AgentThread>)], 10)).toEqual([])
    expect(watch.observe([thread('a', 'idle', git(1, 5, 't1'))], 15)).toEqual([])
    // The small turn's read has come and gone; a later edit by hand opens nothing.
    expect(watch.observe([thread('a', 'idle', git(8, 5, 't2'))], 20)).toEqual([])
    watch.observe([thread('a', 'running', git(8, 5, 't2'))], 30)
    expect(watch.observe([thread('a', 'idle', git(8, 5, 't2'))], 40)).toEqual([])
    expect(watch.observe([thread('a', 'idle', git(20, 5, 't2'))], 40 + 61_000)).toEqual([])
  })
})

describe('Proactive panels on the Tools panel store', () => {
  it('opens Changes quietly only when the panel is closed and not pinned to another thread', () => {
    const store = new ToolsPanelStore()
    expect(store.showChangesProactively('a')).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'changes' })
    expect(store.takeQuietOpen()).toBe(true)
    expect(store.takeQuietOpen()).toBe(false)
    store.setSurface('terminal')
    expect(store.showChangesProactively('a')).toBe(false) // open on another surface: left alone
    expect(store.getSnapshot().surface).toBe('terminal')
    store.setOpen(false); store.pin('b')
    expect(store.showChangesProactively('a')).toBe(false)
    expect(store.showChangesProactively('b')).toBe(true)
  })
  it('opens nothing while the setting is off, and opens for the focused thread only once it is on', () => {
    const store = new ToolsPanelStore()
    const state = (threads: AgentThread[]): AgentState => ({ ...threadsStateFixture(), host: { ...threadsStateFixture().host, threads } })
    const hook = renderHook(({ current, focused }: { current: AgentState; focused: string }) => useProactiveChanges(current, focused, store),
      { initialProps: { current: state([thread('a', 'running', git(0, 0, 't0'))]), focused: 'a' } })
    hook.rerender({ current: state([thread('a', 'idle', git(5, 0, 't1'))]), focused: 'a' })
    expect(store.getSnapshot().open).toBe(false)
    withSettings({ proactivePanels: true })
    hook.rerender({ current: state([thread('a', 'running', git(5, 0, 't1')), thread('b', 'running', git(0, 0, 't1'))]), focused: 'a' })
    hook.rerender({ current: state([thread('a', 'running', git(5, 0, 't1')), thread('b', 'idle', git(9, 0, 't2'))]), focused: 'a' })
    expect(store.getSnapshot().open).toBe(false) // another thread's turn
    hook.rerender({ current: state([thread('a', 'idle', git(9, 0, 't3')), thread('b', 'idle', git(9, 0, 't2'))]), focused: 'a' })
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'changes' })
  })
  it('keeps a large turn in a pane not in focus until that thread is focused, and lets it go once Changes has shown it', () => {
    withSettings({ proactivePanels: true })
    const state = (threads: AgentThread[]): AgentState => ({ ...threadsStateFixture(), host: { ...threadsStateFixture().host, threads } })
    const store = new ToolsPanelStore()
    const hook = renderHook(({ current, focused }: { current: AgentState; focused: string }) => useProactiveChanges(current, focused, store),
      { initialProps: { current: state([thread('a', 'idle', git(0, 0, 't0')), thread('b', 'running', git(0, 0, 't0')), thread('c', 'running', git(0, 0, 't0'))]), focused: 'a' } })
    const done = state([thread('a', 'idle', git(0, 0, 't0')), thread('b', 'idle', git(6, 0, 't1')), thread('c', 'idle', git(6, 0, 't1'))])
    hook.rerender({ current: done, focused: 'a' })
    expect(store.getSnapshot().open).toBe(false)
    // Later the user gets to b: its large turn is shown then.
    hook.rerender({ current: done, focused: 'b' })
    expect(store.getSnapshot()).toMatchObject({ open: true, surface: 'changes' })
    // c's turn is shown by the user opening Changes pinned to it; focusing c afterwards opens nothing more.
    act(() => { store.setOpen(false); store.pin('c'); store.setSurface('changes'); store.setOpen(true) })
    hook.rerender({ current: done, focused: 'b' })
    act(() => { store.setOpen(false); store.unpin() })
    hook.rerender({ current: done, focused: 'c' })
    expect(store.getSnapshot().open).toBe(false)
    // Shown once: focusing b again does not reopen it.
    hook.rerender({ current: done, focused: 'b' })
    expect(store.getSnapshot().open).toBe(false)
  })
  it('leaves keyboard focus where it was when Changes opens on its own', () => {
    const store = new ToolsPanelStore()
    render(<div className="thread-workspace__body"><input aria-label="Prompt" /><ToolsPanel focusedThreadId="visual-gate" state={threadsStateFixture()} files={fakeFilesBridge({})} store={store} /></div>)
    const prompt = screen.getByRole('textbox', { name: 'Prompt' })
    prompt.focus()
    act(() => { store.showChangesProactively('visual-gate') })
    expect(within(screen.getByRole('complementary', { name: 'Tools' })).getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
    expect(prompt).toHaveFocus()
  })
})

describe('the settings hooks other surfaces read', () => {
  it('gives Changes its starting layout, whitespace and file state, and nothing before settings arrive', () => {
    expect(renderHook(() => useDiffPreferences()).result.current).toBeNull()
    withSettings({})
    expect(renderHook(() => useDiffPreferences()).result.current).toEqual({ layout: 'stacked', hideWhitespace: true, fileState: 'collapsed' })
    withSettings({ diffLayout: 'split', diffHideWhitespace: false, diffFileState: 'expanded' })
    expect(renderHook(() => useDiffPreferences()).result.current).toEqual({ layout: 'split', hideWhitespace: false, fileState: 'expanded' })
  })
  it('starts a merge on the remembered method under Last selected and saves a new choice, and saves nothing under a fixed default', () => {
    const update = withSettings({ defaultMergeMethod: 'last', lastMergeMethod: 'squash' })
    const last = renderHook(() => useMergeMethod()).result.current
    expect(last.method).toBe('squash')
    last.remember('rebase')
    expect(update).toHaveBeenCalledExactlyOnceWith({ lastMergeMethod: 'rebase' })
    const fixed = withSettings({ defaultMergeMethod: 'merge', lastMergeMethod: 'squash' })
    const chosen = renderHook(() => useMergeMethod()).result.current
    expect(chosen.method).toBe('merge')
    chosen.remember('rebase')
    expect(fixed).not.toHaveBeenCalled()
  })
})
