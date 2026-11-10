import { randomUUID } from 'node:crypto'

import { expect, type Page } from '@playwright/test'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage, AgentRequest } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import type { WatcherRoomState } from '../../../src/shared/watcherRoom'
import { WATCHER_STAND_IN_KEY, type WatcherStandInSeed } from '../../../src/renderer/src/e2e/watcherStandIn'
import { openThreads } from './sottoLaunch'

type Row = WatcherRoomState['watchedThreads'][number]

/**
 * `release-notes` of the design fixture as a Watcher with a conversation of 24 messages, `<idPrefix>-0` to
 * `<idPrefix>-23`, watching `watched`. Reloads the window so the stand-in takes the seed, and opens Threads. With
 * `told`, Watcher sends that watched thread a message `afterMs` after the reload: its row then holds one message sent.
 */
export async function seedWatcherRoom(page: Page, { watched, idPrefix, told }: { readonly watched: readonly string[]; readonly idPrefix: string
  readonly told?: { readonly thread: string; readonly afterMs: number } }): Promise<void> {
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
    ...told === undefined ? {} : { script: [{ afterMs: told.afterMs, state: { watchedThreads: watched.map(threadId => threadId !== told.thread ? row(threadId) : { ...row(threadId),
      participation: [{ requestId: randomUUID(), startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 }] }) } }] },
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

/** A watched thread's structured question, which Watcher's conversation carries as a card under the reply that told of it. */
export const VOICE_QUESTION: AgentRequest = {
  id: 'grok-voices', kind: 'question', text: 'Voice previews', options: [], questions: [
    { id: 'voices', header: 'Voices', question: 'Which voices get a preview button?', multiSelect: true, allowFreeText: false,
      options: [{ id: 'ara', label: 'Ara' }, { id: 'rex', label: 'Rex' }, { id: 'sal', label: 'Sal' }, { id: 'eve', label: 'Eve' }, { id: 'leo', label: 'Leo' }] },
    { id: 'length', header: 'Sample', question: 'How long is each sample?', multiSelect: false, allowFreeText: false,
      options: [{ id: 'two', label: 'Two seconds' }, { id: 'five', label: 'Five seconds' }] },
    { id: 'key', header: 'Key', question: 'Where does the Grok key live?', multiSelect: false, allowFreeText: false,
      options: [{ id: 'keychain', label: 'System keychain' }, { id: 'settings', label: 'Settings file' }] },
  ],
}

/**
 * `release-notes` of the design fixture as a Watcher an afternoon into its work, as the owner's own room reads: one
 * request of the user's with Watcher's starts on Footer links and Weekly note still running (so Stop all has two to stop),
 * forge connected (so Move threads shows), three answers to news with the work each took folded into its header, two
 * replies a few seconds apart with nothing between them, and Grok voice previews' question placed under the second.
 * Reloads the window so the stand-in takes the seed, and opens Threads. The question itself is told to the thread after.
 */
export async function seedWatcherControls(page: Page): Promise<{ readonly hostId: string; readonly messages: readonly AgentMessage[]; readonly activities: readonly AgentActivity[] }> {
  const hostId = await page.evaluate(async () => (await window.sotto!.agents!.get()).hostId)
  expect(hostId, 'the window names its host').toBeTruthy()
  const at = (minutes: number, seconds = 0): string => new Date(E2E_THREADS_NOW - minutes * 60_000 + seconds * 1_000).toISOString()
  const target = (threadId: string) => ({ hostId: hostId!, threadId })
  const requestId = randomUUID()
  const identity = { target: target('release-notes'), projectId: 'workshop', provider: 'codex' as const, creationOperationId: randomUUID(), createdAt: at(60) }
  const started = ['footer-links', 'weekly-note']
  const participants = started.map(threadId => ({ requestId, startedBy: 'watcher' as const, generation: 0, state: 'participating' as const, target: target(threadId), promptCount: 1 }))
  const row = (threadId: string, status: 'running' | 'idle'): Row => ({ target: target(threadId), title: threadId, watched: true, paused: false, status, connected: true,
    settled: false, backgroundWorkCount: 0, waitsOn: [], participation: participants.filter(part => part.target.threadId === threadId) })
  const FORGE = '0b7f4c1e-2a9d-4f61-8c3e-5d2b9a7e4f10'
  const seed: WatcherStandInSeed = {
    state: {
      current: identity, currentOptions: { modelId: 'codex:gpt', reasoningEffort: null, runtimeMode: 'approval-required', status: 'idle', connected: true },
      history: [], runtimeMode: 'approval-required', ownChanges: [], standingWatches: [],
      requests: [{ id: requestId, watcher: identity.target, rootUserMessageId: 'c-0', state: 'active', createdAt: at(40), closedAt: null, participants }],
      watchedThreads: [row('footer-links', 'running'), row('weekly-note', 'running'), row('visual-gate', 'running'), row('grok-previews', 'idle')],
      receipts: [], recoveryNotice: null, observedAt: new Date(E2E_THREADS_NOW).toISOString(),
      asks: [{ target: target('grok-previews'), requestCardId: VOICE_QUESTION.id, kind: 'question', messageId: 'c-4', wakeUpMessageId: 'wake-grok' }],
    },
    created: identity,
    moves: { machines: [{ hostId: FORGE, name: 'forge', connected: true }], cards: [] },
  }
  const work = (turnId: string, minutes: number, seconds: number, tools: readonly string[]) => {
    const from = at(minutes, -seconds), to = at(minutes)
    return [{ id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence: 0, kind: 'turn' as const, status: 'completed' as const, title: 'Turn', startedAt: from, completedAt: to },
      ...tools.map((title, index) => ({ id: `${turnId}-${index}`, turnId, afterMessageId: turnId, sequence: index + 1, kind: 'tool' as const, status: 'completed' as const, title, startedAt: from, completedAt: to }))]
  }
  const messages = [
    { id: 'c-0', role: 'user' as const, text: 'Keep an eye on Footer links and the visual gate, and bring me anything that needs me.', createdAt: at(40) },
    { id: 'c-1', role: 'assistant' as const, text: 'Watching both. Visual gate flake is waiting for you on a permission to run the unit suite. Footer links is still fixing the help page.', createdAt: at(39) },
    { id: 'c-2', role: 'assistant' as const, text: 'Footer links is done and pushed as `bd77e60`. The worker checked the help page itself:\n\n- **Links:** every footer link now points at the new docs path.\n- **Help page:** it loads again, with no 404.\n- **Old paths:** the three old addresses redirect to the new ones.\n\nIts pull request is waiting on CI.', createdAt: at(27) },
    { id: 'c-3', role: 'assistant' as const, text: 'Nothing new from Visual gate flake: it is still waiting on your permission. Footer links’ checks are still running.', createdAt: at(13) },
    { id: 'c-4', role: 'assistant' as const, text: 'Grok voice previews has a question waiting for your answer.\n\nWeekly note is still writing the Friday wrap; I’ll pass on what it shows when it finishes.', createdAt: at(12, 38) },
    { id: 'c-5', role: 'assistant' as const, text: 'Grok voice previews took your answers and is adding the preview buttons now.', createdAt: at(4) },
  ]
  const activities = [...work('c-0', 39, 40, ['list_threads', 'read_thread']), ...work('news-1', 27, 4.1, ['read_thread', 'read_operation']),
    ...work('news-2', 13, 4, ['read_thread']), ...work('news-3', 4, 3.2, ['read_operation'])].map((record, sequence) => ({ ...record, sequence }))
  await page.evaluate(async ({ key, seed, messages, activities }) => {
    localStorage.setItem(key, JSON.stringify(seed))
    await window.sottoE2E!.agentEvent!({ type: 'history', threadId: 'release-notes', text: '', status: 'idle', messages, activities })
  }, { key: WATCHER_STAND_IN_KEY, seed, messages, activities })
  await page.reload()
  await openThreads(page)
  return { hostId: hostId!, messages, activities }
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
