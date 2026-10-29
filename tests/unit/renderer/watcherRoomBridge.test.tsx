import React, { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../../fixtures/preloadElectron')).preloadElectron())
vi.mock('../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn(), useOptionalAgents: vi.fn(() => null) }))

import { preloadElectron } from '../../fixtures/preloadElectron'
import { createSottoBridge } from '../../../src/preload'
import { WATCHER_CHANGED, WATCHER_GET, watcherRoomStateSchema, type WatcherBridge, type WatcherRoomState } from '../../../src/shared/watcherRoom'
import type { AppContextValue } from '../../../src/renderer/src/state/AppContext'
import { useOptionalApp } from '../../../src/renderer/src/state/AppContext'
import { WatcherRoomProvider, useWatcherRoom } from '../../../src/renderer/src/watcher/watcherRoom'

afterEach(cleanup)

const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const at = (second: number) => new Date(Date.UTC(2026, 9, 28, 0, 0, second)).toISOString()
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const digest = 'a'.repeat(64)

/** One of Watcher's operations as its receipt rides in the room: every field a sent start carries. */
const receipt = (index: number) => ({ id: uuid(index), requestId: uuid(1), retryKey: uuid(100_000 + index), digest, inputDigest: digest,
  action: 'send', target: { hostId: HOST, threadId: `worker-${index % 7}` }, generation: index, deliveryState: 'accepted',
  createdAt: at(0), updatedAt: at(0), receiptId: `receipt-${index}`, cardId: `card-${index}`, messageId: `message-${index}`, outcome: 'answered' })

const roomWith = (receipts: number): WatcherRoomState => ({
  current: { target: { hostId: HOST, threadId: 'watcher' }, projectId: 'workshop', provider: 'codex', creationOperationId: uuid(0), createdAt: at(0) },
  currentOptions: null, history: [],
  requests: [{ id: uuid(1), watcher: { hostId: HOST, threadId: 'watcher' }, rootUserMessageId: 'prompt', state: 'active', createdAt: at(0), closedAt: null, participants: [] }],
  watchedThreads: [{ target: { hostId: HOST, threadId: 'worker-0' }, watched: true, title: 'Worker', status: 'running', connected: true, settled: false,
    backgroundWorkCount: 0, waitsOn: [], participation: [] }],
  receipts: Array.from({ length: receipts }, (_, index) => receipt(index)) as unknown as WatcherRoomState['receipts'],
  recoveryNotice: null, observedAt: at(1), sequence: 1,
})

/**
 * The preload's Watcher bridge as the page reaches it through Electron's context bridge, which copies every argument and
 * answer that crosses it: so does this, and it counts what every room change hands across.
 */
function acrossTheBridge(bridge: WatcherBridge, crossed: number[]): WatcherBridge {
  return {
    ...bridge,
    get: async () => structuredClone(await bridge.get()),
    onChanged: listener => bridge.onChanged(change => {
      crossed.push(JSON.stringify(change).length)
      listener(structuredClone(change))
    }),
  }
}

function Page({ seen }: { readonly seen: WatcherRoomState[] }): null {
  const state = useWatcherRoom()?.state ?? null
  useEffect(() => { if (state !== null) seen.push(state) }, [state])
  return null
}

const UPDATES = 20

/** Mounts Watcher's room on the real preload, sends the room whole once, then updates that touch one small field each. */
async function streamUpdates(receipts: number) {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { watcherEnabled: true } } as unknown as AppContextValue)
  const ipc = preloadElectron().ipcRenderer
  const room = roomWith(receipts)
  // The room the page reads when it opens is older than anything main sends after.
  ipc.invoke.mockImplementation(async (channel: string) => channel === WATCHER_GET ? { status: 'ok', state: { ...room, sequence: 0 } } : undefined)
  const crossed: number[] = [], seen: WatcherRoomState[] = []
  render(<WatcherRoomProvider bridge={acrossTheBridge(createSottoBridge(ipc, 'win32', true).watcher!, crossed)}><Page seen={seen} /></WatcherRoomProvider>)
  await waitFor(() => expect(seen.length).toBeGreaterThan(0))
  const receive = ipc.on.mock.calls.find(call => call[0] === WATCHER_CHANGED)![1] as (event: unknown, ...payload: unknown[]) => void
  act(() => receive({}, { revision: 1, base: null, room }))
  const whole = seen.at(-1)!
  crossed.length = 0
  for (let update = 1; update <= UPDATES; update++) {
    act(() => receive({}, { revision: update + 1, base: update, room: { recoveryNotice: `Reconnecting ${update}`, observedAt: at(1 + update), sequence: 1 + update },
      lists: { watchedThreads: { length: 1, at: [], patch: [[0, { set: { status: update % 2 ? 'idle' : 'running' } }]] } } }))
  }
  return { crossed, whole, last: seen.at(-1)!, seen }
}

it('hands the page only what changed in Watcher\'s room, however many receipts it holds, and keeps every list the change did not touch (#1759)', async () => {
  // Main's own room, already what the full schema gives.
  expect(watcherRoomStateSchema.parse(roomWith(3))).toStrictEqual(roomWith(3))
  const short = await streamUpdates(50)
  cleanup()
  const long = await streamUpdates(2_000)
  for (const run of [short, long]) {
    expect(run.crossed).toHaveLength(UPDATES)
    expect(run.last.recoveryNotice).toBe(`Reconnecting ${UPDATES}`)
    expect(run.last.watchedThreads[0]!.status).toBe('running')
  }
  // What crosses for a change is the change: the same with 2,000 receipts as with 50, and each a few hundred bytes.
  const total = (crossed: readonly number[]) => crossed.reduce((sum, bytes) => sum + bytes, 0)
  expect(total(long.crossed)).toBe(total(short.crossed))
  expect(Math.max(...long.crossed)).toBeLessThan(1_000)
  // The page keeps the very lists the changes did not name, so what it builds from them is not built again.
  expect(long.last.receipts).toHaveLength(2_000)
  expect(long.last.receipts).toBe(long.whole.receipts)
  expect(long.last.requests).toBe(long.whole.requests)
  expect(long.last.watchedThreads).not.toBe(long.whole.watchedThreads)
})
