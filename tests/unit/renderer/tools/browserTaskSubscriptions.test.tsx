import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserStore, useThreadBrowserTasks } from '../../../../src/renderer/src/tools/browserStore'
import { useBrowserOpensItself } from '../../../../src/renderer/src/tools/browserOpensItself'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { browserBridgeFixture, browserTask } from '../../../fixtures/renderer/browserBridge'

afterEach(cleanup)
const workspace = { threadId: 'shown', projectId: 'project', workingDirectory: '/project', workspaceId: 'workspace' }

describe('browser task subscriptions', () => {
  it('keeps the selected thread snapshot and render count through unrelated broadcasts', () => {
    const store = new BrowserStore()
    const events = browserBridgeFixture({ workspace })
    store.watchTasks(events.bridge, [])
    const own = browserTask({ id: 'own', threadId: 'shown' })
    events.publish({ type: 'task', task: own })
    const render = vi.fn()
    const { result, rerender } = renderHook(({ threadId }) => {
      render()
      return useThreadBrowserTasks(store, threadId)
    }, { initialProps: { threadId: 'shown' as string | null } })
    const held = result.current
    render.mockClear()

    for (let updatedAt = 2; updatedAt <= 21; updatedAt++) act(() => {
      events.publish({ type: 'task', task: browserTask({ id: 'other', threadId: 'other', updatedAt }) })
    })
    expect(result.current).toBe(held)
    expect(render).not.toHaveBeenCalled()

    const changed = { ...own, status: 'paused' as const, updatedAt: 22 }
    act(() => events.publish({ type: 'task', task: changed }))
    expect(result.current).toEqual([changed])
    expect(render).toHaveBeenCalledTimes(1)

    rerender({ threadId: 'other' })
    expect(result.current.map(task => task.id)).toEqual(['other'])
    rerender({ threadId: null })
    expect(result.current).toEqual([])
    render.mockClear()
    act(() => events.publish({ type: 'task', task: { ...changed, updatedAt: 23 } }))
    expect(render).not.toHaveBeenCalled()
  })

  it('updates the slice when the global task limit evicts its last task', () => {
    const store = new BrowserStore()
    const events = browserBridgeFixture({ workspace })
    store.watchTasks(events.bridge, [])
    events.publish({ type: 'task', task: browserTask({ id: 'own', threadId: 'shown', updatedAt: 0 }) })
    const render = vi.fn()
    const { result } = renderHook(() => { render(); return useThreadBrowserTasks(store, 'shown') })
    render.mockClear()
    for (let index = 1; index <= 100; index++) act(() => {
      events.publish({ type: 'task', task: browserTask({ id: `other-${index}`, threadId: 'other', updatedAt: index }) })
    })
    expect(result.current).toEqual([])
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('observes all tasks without rendering its owner or opening an old task after focus changes', () => {
    const store = new ToolsPanelStore()
    const events = browserBridgeFixture({ workspace })
    store.browser.watchTasks(events.bridge, [])
    store.setOpen(true)
    store.setSurface('files')
    const showPage = vi.spyOn(store.browser, 'showPage')
    const render = vi.fn()
    const panel = { current: null }
    const { rerender, unmount } = renderHook(({ threadId }) => {
      render()
      useBrowserOpensItself(true, threadId, store, panel)
    }, { initialProps: { threadId: 'shown' } })
    render.mockClear()
    const other = browserTask({ id: 'other', threadId: 'other' })
    act(() => events.publish({ type: 'task', task: other }))
    expect(render).not.toHaveBeenCalled()
    expect(showPage).not.toHaveBeenCalled()

    rerender({ threadId: 'other' })
    act(() => events.publish({ type: 'task', task: { ...other, updatedAt: 2 } }))
    expect(showPage).not.toHaveBeenCalled()
    act(() => events.publish({ type: 'task', task: browserTask({ id: 'new', threadId: 'other', updatedAt: 3 }) }))
    expect(showPage).toHaveBeenCalledExactlyOnceWith('other', other.pageId)

    unmount()
    act(() => events.publish({ type: 'task', task: browserTask({ id: 'after-unmount', threadId: 'other', updatedAt: 4 }) }))
    expect(showPage).toHaveBeenCalledTimes(1)
  })
})
