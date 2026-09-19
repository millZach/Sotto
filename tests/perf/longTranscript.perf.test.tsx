/**
 * Measures what a long thread costs: the Threads page opened on a thread of 400 messages, built by repeating a
 * real thread's messages with fresh ids and timestamps. Reports the mount, one streaming update at the default
 * page of messages, and the same once the reader has shown every earlier message. Skips without a real folder.
 *
 *   npx vitest run tests/perf/longTranscript.perf.test.tsx --disable-console-intercept
 *   SOTTO_PERF_DATA=<folder with workspace.json> to point elsewhere.
 */
import React, { Profiler, type ReactNode } from 'react'
import { mkdtemp, readFile, copyFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyPerfHistory, hydratePerfHistory } from '../fixtures/perfWorkspace'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentHostSnapshot, type AgentMessage, type AgentState, type AgentThread } from '../../src/shared/agents'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../src/renderer/src/agents/splitLayout'
import { share } from '../../src/renderer/src/agents/stateSharing'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const LONG_THREAD = 400
const ITERATIONS = 20
const WARMUP = 10
const MOUNTS = 5
const MOUNT_WARMUP = 2
const NOW = Date.parse('2026-09-16T12:00:00Z')
const dataDirectory = process.env.SOTTO_PERF_DATA ?? (process.env.APPDATA ? join(process.env.APPDATA, 'sotto') : '')

async function available(): Promise<boolean> {
  if (!dataDirectory) return false
  try { await access(join(dataDirectory, 'workspace.json')); return true } catch { return false }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function round(value: number): number { return Math.round(value * 100) / 100 }

/**
 * A thread of `total` messages made from the real ones. The first copy keeps its own ids so the thread's
 * activities still anchor where they did; every later copy is a fresh id and a later timestamp.
 */
function lengthen(thread: AgentThread, total: number): AgentThread {
  const source = thread.messages
  expect(source.length).toBeGreaterThan(0)
  const first = Date.parse(source[0]!.createdAt) || NOW - total * 60_000
  const messages: AgentMessage[] = []
  for (let index = 0; index < total; index += 1) {
    const original = source[index % source.length]!
    const copy = Math.floor(index / source.length)
    messages.push(copy === 0
      ? original
      : { ...original, id: `${original.id}-copy${copy}`, createdAt: new Date(first + index * 60_000).toISOString() })
  }
  return { ...thread, messages }
}

function stateAround(host: AgentHostSnapshot, activeThreadId: string): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected', host,
    assignments: [], queue: [], activeThreadId,
    activeProjectId: host.threads.find(thread => thread.id === activeThreadId)?.projectId ?? host.projects[0]?.id ?? null,
    draft: '', draftThreadId: null, composing: false, draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Beta', expiresAt: null },
  }
}

/** One streaming chunk on the open thread's newest assistant message, as a whole new state object off the wire. */
function withChunk(state: AgentState, threadId: string, chunk: string): AgentState {
  const next = structuredClone(state)
  const thread = next.host.threads.find(item => item.id === threadId)
  const message = thread?.messages.findLast(item => item.role === 'assistant') ?? thread?.messages.at(-1)
  if (message) (message as { text: string }).text += chunk
  return next
}

/** What AgentContext does with an arriving state before React sees it, so its cost stays inside the number. */
function receive(previous: AgentState, next: AgentState): AgentState {
  return share(previous, next)
}

describe('long transcript cost', async () => {
  const present = await available()
  let directory = ''
  beforeAll(async () => {
    if (!present) return
    // The measurement never touches the live folder.
    directory = await mkdtemp(join(tmpdir(), 'sotto-perf-'))
    await copyFile(join(dataDirectory, 'workspace.json'), join(directory, 'workspace.json'))
    await copyPerfHistory(dataDirectory, directory)
  })
  afterAll(async () => { cleanup(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it.skipIf(!present)('reports the mount and update cost of a 400-message thread', async context => {
    const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
    const host = workspace.snapshot
    await hydratePerfHistory(host, directory)
    if (!host.threads.some(thread => thread.messages.length > 0)) context.skip('The profile has no retained messages to measure a transcript.')
    const busiest = [...host.threads].sort((first, second) => second.messages.length - first.messages.length)[0]
    expect(busiest).toBeDefined()
    const short = { ...busiest!, status: 'running' } as AgentThread
    const open = { ...lengthen(busiest!, LONG_THREAD), status: 'running' } as AgentThread
    const withThread = (thread: AgentThread): AgentHostSnapshot =>
      ({ ...host, threads: host.threads.map(item => item.id === thread.id ? thread : item) })

    let state = stateAround(withThread(short), short.id)
    const store = new ThreadDraftStore(vi.fn(async () => state))
    const connection = (): ReturnType<typeof useAgents> => ({
      state, command: vi.fn(async () => state), threadDrafts: store, error: null,
      voice: { status: 'off' }, muteVoice: vi.fn(), stopSpeech: vi.fn(), retryVoice: vi.fn(),
      attention: { items: [], show: false, dismiss: vi.fn(), reopen: vi.fn(), next: vi.fn(async () => undefined) },
    } as unknown as ReturnType<typeof useAgents>)

    let commits = 0
    let committed = 0
    const view = (): ReactNode => <Profiler id="threads" onRender={(_id, _phase, actual) => { commits++; committed += actual }}>
      <ThreadsView onOpenAgents={vi.fn()} now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} paneAreaHeight={800} />
    </Profiler>

    vi.mocked(useAgents).mockImplementation(connection)

    // Mount: opening the page on this thread, torn down and repeated so warm-up does not own the number.
    const measureMount = (): { readonly ms: number; readonly react: number } => {
      const mounts: number[] = []
      for (let index = 0; index < MOUNT_WARMUP + MOUNTS; index += 1) {
        if (index === MOUNT_WARMUP) { commits = 0; committed = 0 }
        const started = performance.now()
        const mounted = render(view())
        const elapsed = performance.now() - started
        if (index >= MOUNT_WARMUP) mounts.push(elapsed)
        mounted.unmount()
      }
      return { ms: round(median(mounts)), react: round(committed / MOUNTS) }
    }

    // The real thread first, as the yardstick the long one is read against.
    const shortMount = measureMount()
    state = stateAround(withThread(open), open.id)
    const longMount = measureMount()

    const rendered = render(view())
    const drawn = (): number => rendered.container.querySelectorAll('.thread-message').length

    const measureUpdates = (): { readonly ms: number; readonly react: number; readonly commits: number } => {
      const updates = Array.from({ length: WARMUP + ITERATIONS }, (_unused, index) => withChunk(state, open.id, ` chunk ${index}`))
      const samples: number[] = []
      updates.forEach((update, index) => {
        if (index === WARMUP) { commits = 0; committed = 0 }
        const started = performance.now()
        state = receive(state, update)
        act(() => { rendered.rerender(view()) })
        if (index >= WARMUP) samples.push(performance.now() - started)
      })
      return { ms: round(median(samples)), react: round(committed / ITERATIONS), commits }
    }

    const paged = drawn()
    const pagedUpdate = measureUpdates()

    // The reader asks for the whole history, which is the worst case the transcript can be put in.
    let expansions = 0
    for (;;) {
      const earlier = screen.queryAllByRole('button', { name: /Show earlier messages/ }).at(-1)
      if (!earlier || expansions > 20) break
      act(() => { earlier.click() })
      expansions += 1
    }
    const expanded = drawn()
    const expandedUpdate = measureUpdates()

    const report = {
      messages: open.messages.length, realMessages: short.messages.length, drawnAtOpen: paged, drawnWhenExpanded: expanded,
      realMountMs: shortMount.ms, realMountReactMs: shortMount.react,
      mountMs: longMount.ms, mountReactMs: longMount.react,
      msPerUpdate: pagedUpdate.ms, reactMsPerUpdate: pagedUpdate.react,
      msPerUpdateExpanded: expandedUpdate.ms, reactMsPerUpdateExpanded: expandedUpdate.react,
    }
    console.info(`long transcript: ${JSON.stringify(report)}`)
    expect(expanded).toBeGreaterThanOrEqual(paged)
  }, 300_000)
})
