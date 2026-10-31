import { randomUUID } from 'node:crypto'

import { expect, type Page } from '@playwright/test'

import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../../src/renderer/src/e2e/watcherStandIn'
import { openThreads } from './sottoLaunch'

type Row = WatcherRoomState['watchedThreads'][number]

/**
 * `release-notes` of the design fixture as a Watcher with a conversation of 24 messages, `<idPrefix>-0` to
 * `<idPrefix>-23`, watching `watched`. Reloads the window so the stand-in takes the seed, and opens Threads.
 */
export async function seedWatcherRoom(page: Page, { watched, idPrefix }: { readonly watched: readonly string[]; readonly idPrefix: string }): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const row = (threadId: string): Row => ({ target: target(threadId), title: threadId, watched: true, paused: false, status: 'idle', connected: true,
    settled: false, backgroundWorkCount: 0, participation: [], waitsOn: [] })
  const identity = { target: target('release-notes'), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(),
    createdAt: new Date(E2E_THREADS_NOW - 60_000).toISOString() }
  const seed: WatcherStandInSeed = {
    state: {
      current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
      history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [], requests: [], watchedThreads: watched.map(row),
      receipts: [], recoveryNotice: null, observedAt: new Date(E2E_THREADS_NOW).toISOString(),
    },
    created: identity,
  }
  await page.evaluate(async ({ key, seed, idPrefix, now }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', messages: Array.from({ length: 24 }, (_, index) => ({
      id: `${idPrefix}-${index}`, role: index % 2 ? 'assistant' as const : 'user' as const,
      text: index % 2
        ? `Watching it. Package (Windows) is still running for the release thread (${(index + 1) / 2}). The footer links thread waits on review, and the visual gate passed on its [second run](https://github.com/millZach/Sotto/actions).`
        : `Is the release thread green yet? (${index / 2 + 1})`,
      createdAt: new Date(now - (24 - index) * 60_000).toISOString() })) })
  }, { key: WATCHER_STAND_IN_KEY, seed, idPrefix, now: E2E_THREADS_NOW })
  await page.reload()
  await openThreads(page)
}

/** Watcher's room before Watcher starts: the stand-in's first entry, no Watcher and nothing watched. Reloads and opens Threads. */
export async function seedWatcherFirstEntry(page: Page): Promise<void> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const created = { target: { hostId: hostId!, threadId: 'release-notes' }, projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(),
    createdAt: new Date(E2E_THREADS_NOW - 60_000).toISOString() }
  const seed: WatcherStandInSeed = {
    state: {
      current: null, currentOptions: null, history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [], requests: [],
      watchedThreads: [], receipts: [], recoveryNotice: null, observedAt: new Date(E2E_THREADS_NOW).toISOString(),
    },
    created,
  }
  await page.evaluate(({ key, seed }) => localStorage.setItem(key, JSON.stringify(seed)), { key: WATCHER_STAND_IN_KEY, seed })
  await page.reload()
  await openThreads(page)
}
