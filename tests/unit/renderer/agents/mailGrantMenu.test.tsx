import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMailGrantMenu } from '../../../../src/renderer/src/agents/mailGrantMenu'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'
import type { MailGrantStop, PluginsBridge, ThreadMailGrant } from '../../../../src/shared/plugins'
import { deferred } from '../../../fixtures/deferred'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))
afterEach(cleanup)

/**
 * Ask before this thread reads a mail account, in the thread's ··· menu (ADR-0205, decision 8; Zach's pick B on
 * November 13, 2026, of the tag prototype/plugin-mail-grants): a row for each account the thread has been let read,
 * there only while it can, which ends the grant.
 */
function owl(plugins: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.42-owl.20261113.1', phase: { phase: 'up-to-date' }, checkedAt: null, owlFeatures: { plugins } } } as unknown as AppContextValue)
}

/** Made-up accounts, by Sotto's IDs for them and the names the user gave them. */
const PERSONAL: ThreadMailGrant = { accountId: '33333333-3333-4333-8333-000000000001', plugin: 'gmail', name: 'Personal' }
const WORK: ThreadMailGrant = { accountId: '33333333-3333-4333-8333-000000000002', plugin: 'gmail', name: 'Work' }

/** The part of the bridge the menu uses, over the grants each thread holds. */
function bridge(held: Record<string, ThreadMailGrant[]>, options: { stops?: boolean } = {}) {
  const listeners = new Set<() => void>()
  const stopped: MailGrantStop[] = []
  const asked: string[] = []
  const made = {
    mailGrants: async (threadId: string) => { asked.push(threadId); return [...held[threadId] ?? []] },
    stopMailGrant: async (request: MailGrantStop) => {
      stopped.push(request)
      if (options.stops === false) return false
      held[request.threadId] = (held[request.threadId] ?? []).filter(grant => grant.accountId !== request.accountId)
      for (const listener of [...listeners]) listener()
      return true
    },
    onMailGrantsChanged: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } as unknown as PluginsBridge
  return { made, stopped, asked, listeners, changed: () => { for (const listener of [...listeners]) listener() } }
}
const labels = (items: readonly { label: string }[]): string[] => items.map(item => item.label)

it('offers a row for each mail account the thread can read, and none while it can read none', async () => {
  owl(true)
  const b = bridge({ one: [PERSONAL, WORK], two: [] })
  const one = renderHook(() => useMailGrantMenu('one', true, b.made))
  expect(one.result.current.items).toEqual([])
  await act(async () => undefined)
  expect(labels(one.result.current.items)).toEqual(['Ask before this thread reads Personal', 'Ask before this thread reads Work'])
  const two = renderHook(() => useMailGrantMenu('two', true, b.made))
  await act(async () => undefined)
  expect(two.result.current.items).toEqual([])
})

it('ends the grant on a press, and the row goes once the thread can no longer read the account', async () => {
  owl(true)
  const b = bridge({ one: [PERSONAL, WORK] })
  const { result } = renderHook(() => useMailGrantMenu('one', true, b.made))
  await act(async () => undefined)
  await act(async () => { result.current.items[0]!.run() })
  expect(b.stopped).toEqual([{ threadId: 'one', accountId: PERSONAL.accountId }])
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Work'])
  expect(result.current.problem).toBeNull()
})

it('says so when a grant could not be ended, and leaves the row, since the thread can still read the account', async () => {
  owl(true)
  const b = bridge({ one: [PERSONAL] }, { stops: false })
  const { result } = renderHook(() => useMailGrantMenu('one', true, b.made))
  await act(async () => undefined)
  await act(async () => { result.current.items[0]!.run() })
  expect(result.current.problem).toBe('Sotto could not stop this thread reading Personal, so it can still read it. Try again.')
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Personal'])
})

it('reads the thread’s grants again when main says one changed, as when the user allows a read', async () => {
  owl(true)
  const held: Record<string, ThreadMailGrant[]> = { one: [] }
  const b = bridge(held)
  const { result, unmount } = renderHook(() => useMailGrantMenu('one', true, b.made))
  await act(async () => undefined)
  expect(result.current.items).toEqual([])
  held.one = [PERSONAL]
  await act(async () => { b.changed() })
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Personal'])
  // It stops listening when the pane goes.
  unmount()
  expect(b.listeners.size).toBe(0)
})

it('shows another thread’s rows when the pane goes to it, and never one thread’s late answer in another', async () => {
  owl(true)
  const slow = deferred<ThreadMailGrant[]>()
  const made = {
    mailGrants: async (threadId: string) => threadId === 'one' ? slow.promise : [WORK],
    stopMailGrant: async () => true,
    onMailGrantsChanged: () => () => undefined,
  } as unknown as PluginsBridge
  const { result, rerender } = renderHook(({ id }) => useMailGrantMenu(id, true, made), { initialProps: { id: 'one' } })
  rerender({ id: 'two' })
  await act(async () => undefined)
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Work'])
  await act(async () => { slow.resolve([PERSONAL]) })
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Work'])
})

it('lets a Stop that finishes after the pane has gone to another thread, or has gone, touch nothing', async () => {
  owl(true)
  const stopping = deferred<boolean>()
  const asked: string[] = []
  const made = {
    mailGrants: async (threadId: string) => { asked.push(threadId); return threadId === 'one' ? [PERSONAL] : [WORK] },
    stopMailGrant: async () => stopping.promise,
    onMailGrantsChanged: () => () => undefined,
  } as unknown as PluginsBridge
  const { result, rerender } = renderHook(({ id }) => useMailGrantMenu(id, true, made), { initialProps: { id: 'one' } })
  await act(async () => undefined)
  act(() => { result.current.items[0]!.run() })
  rerender({ id: 'two' })
  await act(async () => undefined)
  asked.length = 0
  // The first thread's Stop could not be written. The pane shows the second thread now, and says nothing of it.
  await act(async () => { stopping.resolve(false) })
  expect(result.current.problem).toBeNull()
  expect(labels(result.current.items)).toEqual(['Ask before this thread reads Work'])
  expect(asked).toEqual([])

  // And one that succeeds after the pane has gone asks main for nothing more.
  const later = deferred<boolean>()
  const gone = { ...made, stopMailGrant: async () => later.promise } as unknown as PluginsBridge
  const pane = renderHook(() => useMailGrantMenu('one', true, gone))
  await act(async () => undefined)
  act(() => { pane.result.current.items[0]!.run() })
  pane.unmount()
  asked.length = 0
  await act(async () => { later.resolve(true) })
  expect(asked).toEqual([])
})

it('offers nothing for a thread on another computer, on stable, or without the bridge, and asks main nothing', async () => {
  owl(true)
  const b = bridge({ one: [PERSONAL] })
  const elsewhere = renderHook(() => useMailGrantMenu('one', false, b.made))
  await act(async () => undefined)
  expect(elsewhere.result.current.items).toEqual([])
  owl(false)
  const stable = renderHook(() => useMailGrantMenu('one', true, b.made))
  await act(async () => undefined)
  expect(stable.result.current.items).toEqual([])
  expect(b.asked).toEqual([])
  expect(b.listeners.size).toBe(0)
})
