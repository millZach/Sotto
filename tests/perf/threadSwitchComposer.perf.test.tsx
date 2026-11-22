/**
 * Measures 20 `flushSync` thread switches between two held threads with 1,500 sidebar rows (#2733):
 * reports median commit time, composer render time, and `ThreadComposer` mount count across the switches.
 *
 *   PowerShell:  $env:SOTTO_PERF_BENCH = '1'; npx vitest run tests/perf/threadSwitchComposer.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 *   sh:          SOTTO_PERF_BENCH=1 npx vitest run tests/perf/threadSwitchComposer.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import React, { Profiler, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { defaultAgentConfiguration, EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentProject, type AgentState, type AgentThread } from '../../src/shared/agents'
import { share } from '../../src/renderer/src/agents/stateSharing'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../src/renderer/src/agents/splitLayout'
import { agentContextFixture } from '../fixtures/agentContext'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const composerStats = vi.hoisted(() => ({ mounts: 0, updates: 0, renderMs: 0 }))
vi.mock('../../src/renderer/src/agents/ThreadComposer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/agents/ThreadComposer')>()
  return {
    ...actual,
    ThreadComposer: (props: Parameters<typeof actual.ThreadComposer>[0]) => (
      <Profiler
        id="composer"
        onRender={(_id, phase, actualDuration) => {
          if (phase === 'mount') composerStats.mounts += 1
          else composerStats.updates += 1
          composerStats.renderMs += actualDuration
        }}
      >
        <actual.ThreadComposer {...props} />
      </Profiler>
    ),
  }
})

const THREAD_COUNT = 1_500
const SWITCHES = 20
const NOW = Date.parse('2026-11-22T18:30:00Z')

function buildState(count: number): { state: AgentState; first: AgentThread; second: AgentThread } {
  const project: AgentProject = {
    id: 'project-0',
    title: 'Sotto',
    path: 'C:/workspace/sotto',
    providerId: 'claude',
  }
  const models: AgentHostSnapshot['models'] = [
    { id: 'claude:sonnet', name: 'Claude Sonnet', provider: 'Claude Code', providerId: 'claude', ready: true, defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high'] },
  ]
  const threads: AgentThread[] = Array.from({ length: count }, (_, index) => {
    const id = `thread-${index}`
    const updatedAt = new Date(NOW - index * 60_000).toISOString()
    const messages = index < 2
      ? [
          { id: `u-${index}-1`, role: 'user' as const, text: `Inspect thread ${index}`, createdAt: updatedAt },
          { id: `a-${index}-1`, role: 'assistant' as const, text: `Summary for thread ${index}.`, createdAt: updatedAt },
        ]
      : []
    return {
      id,
      title: `Thread ${index}`,
      projectId: project.id,
      providerId: 'claude',
      modelId: 'claude:sonnet',
      status: 'idle',
      updatedAt,
      messages,
      requests: [],
      summary: { messageCount: 2, activityCount: 0, lastMessageAt: updatedAt },
    }
  })
  const state: AgentState = {
    configuration: { ...defaultAgentConfiguration(), enabled: true },
    connection: 'connected',
    host: {
      ...EMPTY_AGENT_HOST,
      hostId: 'laptop',
      connected: true,
      capabilities: { ...EMPTY_AGENT_HOST.capabilities, threads: true, submit: true, steer: true, interrupt: true, configureThread: true, skills: true },
      projects: [project],
      models,
      threads,
    },
    activeThreadId: threads[0]!.id,
    activeProjectId: project.id,
    draft: '',
    draftThreadId: null,
    draftAttachments: [],
    draftRequestId: null,
    threadDrafts: [
      { threadId: threads[0]!.id, draftId: 'draft-0', text: 'Draft on thread zero', attachments: [], requestId: null, updatedAt: new Date(NOW).toISOString() },
      { threadId: threads[1]!.id, draftId: 'draft-1', text: 'Draft on thread one', attachments: [], requestId: null, updatedAt: new Date(NOW).toISOString() },
    ],
    composing: false,
    globalLaneBusy: false,
    busyThreadIds: [],
    credentials: { reasoning: false, secure: false },
    reasoningAccounts: [],
    historyEnabled: true,
    notice: '',
    error: null,
  }
  return { state, first: threads[0]!, second: threads[1]! }
}

describe.skipIf(!PERF_BENCH)('thread switch composer mount and flushSync commit benchmark (requires SOTTO_PERF_BENCH=1)', () => {
  afterAll(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('times 20 switches between two held threads with 1,500 sidebar rows', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
    const canvas = HTMLCanvasElement.prototype.getContext
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: Parameters<typeof canvas>) {
      return (canvas.apply(this, args) ?? { font: '', measureText: (text: string) => ({ width: text.length * 7 }) }) as never
    } as typeof canvas)

    const built = buildState(THREAD_COUNT)
    let state = built.state
    const { first, second } = built
    const command = vi.fn(async () => state)
    const store = new ThreadDraftStore(command)
    store.receive(state)
    vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))

    const layoutStore = new SplitLayoutStore()
    const view = (): ReactNode => <ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />

    let editorsDestroyed = 0
    const destroy = Editor.prototype.destroy
    vi.spyOn(Editor.prototype, 'destroy').mockImplementation(function (this: Editor) { editorsDestroyed += 1; return destroy.call(this) })

    composerStats.mounts = 0
    composerStats.updates = 0
    composerStats.renderMs = 0

    const rendered = render(view())
    expect(composerStats.mounts).toBe(1)

    const initialMounts = composerStats.mounts
    const samples: number[] = []
    composerStats.renderMs = 0
    composerStats.updates = 0

    for (let index = 0; index < SWITCHES; index++) {
      const target = index % 2 === 0 ? second : first
      const next = share(state, { ...state, activeThreadId: target.id, activeProjectId: target.projectId })
      state = next
      const started = performance.now()
      act(() => {
        flushSync(() => {
          rendered.rerender(view())
        })
      })
      samples.push(performance.now() - started)
    }

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    const totalMounts = composerStats.mounts
    const mountsDuringSwitches = totalMounts - initialMounts
    rendered.unmount()

    console.log(
      `20 switches (${THREAD_COUNT} sidebar rows): flushSync median ${round(median(samples), 2)} ms (min ${round(Math.min(...samples), 2)}, max ${round(Math.max(...samples), 2)}) | composer render ${round(composerStats.renderMs / SWITCHES, 2)} ms/switch | ThreadComposer total mounts ${totalMounts} (${mountsDuringSwitches} during 20 switches) | editorsDestroyed ${editorsDestroyed}`,
    )
    expect(samples).toHaveLength(SWITCHES)
  }, 120_000)
})
