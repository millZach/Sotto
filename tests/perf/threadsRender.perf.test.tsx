/**
 * Measures what the window re-renders when one agent state update arrives: the Threads page with one thread
 * open, re-rendered 20 times with a state object that carries one more streaming chunk on the open thread.
 * Uses a copy of a real Sotto data folder and skips when none is available.
 *
 *   npx vitest run tests/perf/threadsRender.perf.test.tsx --disable-console-intercept
 *   SOTTO_PERF_DATA=<folder with workspace.json> to point elsewhere.
 */
import React, { Profiler, type ReactNode } from 'react'
import { mkdtemp, readFile, copyFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { defaultAgentConfiguration, type AgentHostSnapshot, type AgentState } from '../../src/shared/agents'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../src/renderer/src/agents/splitLayout'
import { share } from '../../src/renderer/src/agents/stateSharing'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const ITERATIONS = 20
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

function stateAround(host: AgentHostSnapshot, activeThreadId: string): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected', host,
    assignments: [], queue: [], activeThreadId,
    activeProjectId: host.threads.find(thread => thread.id === activeThreadId)?.projectId ?? host.projects[0]?.id ?? null,
    draft: '', draftThreadId: null, composing: false, draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
    pendingRequest: '', busy: false, notice: '', error: null, speech: { id: 0, text: '' },
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

describe('threads render cost', async () => {
  const present = await available()
  let directory = ''
  beforeAll(async () => {
    if (!present) return
    // The measurement never touches the live folder.
    directory = await mkdtemp(join(tmpdir(), 'sotto-perf-'))
    await copyFile(join(dataDirectory, 'workspace.json'), join(directory, 'workspace.json'))
  })
  afterAll(async () => { cleanup(); if (directory) await rm(directory, { recursive: true, force: true }) })

  it.skipIf(!present)('reports the cost of one state update with a thread open', async () => {
    const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
    const host = workspace.snapshot
    // The busiest thread is the one a streaming agent is writing into, and it is running: that is when
    // broadcasts arrive many times a second, and it is what decides how the transcript renders a chunk.
    const open = [...host.threads].sort((first, second) => second.messages.length - first.messages.length)[0]
    expect(open).toBeDefined()
    ;(open as { status: string }).status = 'running'
    const messages = host.threads.reduce((count, thread) => count + thread.messages.length, 0)

    let state = stateAround(host, open!.id)
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
    const rendered = render(view())

    // Every update is prepared outside the measured window: what is measured is receiving one and painting it.
    const updates = Array.from({ length: ITERATIONS }, (_unused, index) => withChunk(state, open!.id, ` chunk ${index}`))
    commits = 0
    committed = 0
    const samples: number[] = []
    for (const update of updates) {
      const started = performance.now()
      // Where the receive path shares structure with the previous state, that work belongs in the measurement.
      state = receive(state, update)
      act(() => { rendered.rerender(view()) })
      samples.push(performance.now() - started)
    }

    const report = {
      threads: host.threads.length, messages, openThreadMessages: open!.messages.length,
      updates: ITERATIONS, commits, msPerUpdate: round(median(samples)),
      reactMsPerUpdate: round(committed / ITERATIONS),
    }
    console.info(`threads render: ${JSON.stringify(report)}`)
    expect(commits).toBeGreaterThan(0)
  }, 120_000)
})

/** What AgentContext does with an arriving state before React sees it, so its cost stays inside the number. */
function receive(previous: AgentState, next: AgentState): AgentState {
  return share(previous, next)
}
