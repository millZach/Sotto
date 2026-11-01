/**
 * Measures what the window re-renders when one agent state update arrives: the Threads page with one thread open, and
 * with two side by side, re-rendered ten times to warm up and twenty more that are timed, for three kinds of update
 * (#993): nothing changed (the page's parent re-rendered, as it did for each microphone level), one more streaming chunk
 * on the open thread, and one more on a thread that is not on screen. Each row gives the median time of an update, the
 * mean render time React's Profiler reports for the page (`reactMsPerUpdate`, its `actualDuration`), and the same for the
 * panes' composers and their branch toolbars. Uses a copy of an explicitly selected Sotto data folder.
 *
 *   Set SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA=<folder with workspace.json>.
 *   npx vitest run tests/perf/threadsRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import { agentContextFixture } from '../fixtures/agentContext'
import { stateAround, withChunk } from './support/transcriptState'
import { round } from '../fixtures/perfBench'
import { upperMedian as median } from './support/statistics.mjs'
import React, { Profiler, type ReactNode } from 'react'
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyPerfHistory, hydratePerfHistory, perfDataDirectory } from '../fixtures/perfWorkspace'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { share } from '../../src/renderer/src/agents/stateSharing'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore, openBeside } from '../../src/renderer/src/agents/splitLayout'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

// The render time of each pane's composer and of its branch toolbar, by React's Profiler around each, so the rows can say
// where an update's time goes inside a pane, not only on the page.
const parts = vi.hoisted(() => ({ composer: 0, toolbar: 0 }))
vi.mock('../../src/renderer/src/agents/ThreadComposer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/agents/ThreadComposer')>()
  return { ...actual, ThreadComposer: (props: Parameters<typeof actual.ThreadComposer>[0]) =>
    <Profiler id="composer" onRender={(_id, _phase, actualDuration) => { parts.composer += actualDuration }}><actual.ThreadComposer {...props} /></Profiler> }
})
vi.mock('../../src/renderer/src/agents/BranchToolbar', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/agents/BranchToolbar')>()
  return { ...actual, BranchToolbar: (props: Parameters<typeof actual.BranchToolbar>[0]) =>
    <Profiler id="toolbar" onRender={(_id, _phase, actualDuration) => { parts.toolbar += actualDuration }}><actual.BranchToolbar {...props} /></Profiler> }
})

const ITERATIONS = 20
const WARMUP = 10
const NOW = Date.parse('2026-09-16T12:00:00Z')

/** One streaming chunk on the open thread's newest assistant message, as a whole new state object off the wire. */

describe('threads render cost', async () => {
  const dataDirectory = await perfDataDirectory()
  const present = dataDirectory !== null
  let directory = ''
  beforeAll(async () => {
    if (!dataDirectory) return
    // The measurement never touches the live folder.
    directory = await mkdtemp(join(tmpdir(), 'sotto-perf-'))
    await copyFile(join(dataDirectory, 'workspace.json'), join(directory, 'workspace.json'))
    await copyPerfHistory(dataDirectory, directory)
  })
  afterAll(async () => { cleanup(); if (directory) await rm(directory, { recursive: true, force: true }) })

  describe("requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json", () => {
    it.skipIf(!present)('reports the cost of one state update with a thread open', async context => {
      const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const host = workspace.snapshot
      await hydratePerfHistory(host, directory)
      // The busiest thread is the one a streaming agent is writing into, and it is running: that is when
      // broadcasts arrive many times a second, and it is what decides how the transcript renders a chunk.
      if (!host.threads.some(thread => thread.messages.length > 0)) context.skip('The profile has no retained messages to measure a transcript.')
      const sorted = [...host.threads].sort((first, second) => second.messages.length - first.messages.length)
      const open = sorted[0]
      expect(open).toBeDefined()
      ;(open as { status: string }).status = 'running'
      // The second pane holds the next busiest thread; the off-screen update goes to a thread further down the list.
      const second = sorted[1] ?? open!
      const offScreen = sorted[Math.min(5, sorted.length - 1)]!
      const messages = host.threads.reduce((count, thread) => count + thread.messages.length, 0)

      const rows: Record<string, { msPerUpdate: number; reactMsPerUpdate: number; composerMsPerUpdate: number; toolbarMsPerUpdate: number; commits: number }> = {}
      for (const panes of [1, 2]) {
        let state = stateAround(host, open!.id)
        // One command for the whole run, as AgentContext keeps one: a new one per update would redraw every pane.
        const command = vi.fn(async () => state)
        const store = new ThreadDraftStore(command)
        const connection = (): ReturnType<typeof useAgents> => agentContextFixture(state, command, { threadDrafts: store })
        const layoutStore = new SplitLayoutStore()
        if (panes === 2) layoutStore.set(openBeside(layoutStore.get(), open!.id, second.id))

        let commits = 0
        let committed = 0
        const view = (): ReactNode => <Profiler id="threads" onRender={(_id, _phase, actual) => { commits++; committed += actual }}>
          <ThreadsView now={NOW} layoutStore={layoutStore} paneAreaWidth={1200} paneAreaHeight={800} />
        </Profiler>
        vi.mocked(useAgents).mockImplementation(connection)
        const rendered = render(view())

        const measure = (name: string, next: (index: number) => typeof state): void => {
          // Every update is prepared outside the measured window: what is measured is receiving one and painting it.
          const updates = Array.from({ length: WARMUP + ITERATIONS }, (_unused, index) => next(index))
          const samples: number[] = []
          updates.forEach((update, index) => {
            // The first arrivals pay for warm-up (parsers, styles, the browser's own caches) and are not counted.
            if (index === WARMUP) { commits = 0; committed = 0; parts.composer = 0; parts.toolbar = 0 }
            const started = performance.now()
            // Where the receive path shares structure with the previous state, that work belongs in the measurement.
            state = share(state, update)
            act(() => { rendered.rerender(view()) })
            if (index >= WARMUP) samples.push(performance.now() - started)
          })
          rows[`${panes} pane${panes === 1 ? '' : 's'}, ${name}`] = { msPerUpdate: round(median(samples), 2), reactMsPerUpdate: round(committed / ITERATIONS, 2),
            composerMsPerUpdate: round(parts.composer / ITERATIONS, 2), toolbarMsPerUpdate: round(parts.toolbar / ITERATIONS, 2), commits }
        }
        measure('nothing changed', () => state)
        measure('chunk on the open thread', index => withChunk(state, open!.id, ` chunk ${index}`))
        measure('chunk on a thread not on screen', index => withChunk(state, offScreen.id, ` chunk ${index}`))
        rendered.unmount()
      }

      const report = { threads: host.threads.length, messages, openThreadMessages: open!.messages.length, secondPaneMessages: second.messages.length, updates: ITERATIONS, rows }
      console.info(`threads render: ${JSON.stringify(report)}`)
      expect(Object.values(rows).some(row => row.commits > 0)).toBe(true)
    }, 120_000)
  })
})

/** What AgentContext does with an arriving state before React sees it, so its cost stays inside the number. */
