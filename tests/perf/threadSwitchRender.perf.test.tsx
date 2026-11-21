/**
 * What the window renders when the user picks another thread in the sidebar (#2733): the Threads page, sidebar and pane,
 * at the owner's scale, switching back and forth between two threads twenty times after ten to warm up. Each switch is
 * the selection's answer landing: the same state with another thread selected, shared against the last as the window
 * shares it. Reports the median time of a switch, React's render time for the page, and the sidebar's and the composer's
 * part of it, and how many reads of layout the switch makes before it paints (`getBoundingClientRect`, `getComputedStyle`,
 * and an element's client, offset or scroll size), each of which makes the browser lay the page out there and then, in the middle
 * of the commit. React's work only otherwise: jsdom lays out and paints nothing. Uses a copy of an explicitly selected data
 * folder.
 *
 *   Set SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA=<folder with workspace.json>.
 *   npx vitest run tests/perf/threadSwitchRender.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import { agentContextFixture } from '../fixtures/agentContext'
import { stateAround } from './support/transcriptState'
import { round } from '../fixtures/perfBench'
import { upperMedian as median } from './support/statistics.mjs'
import React, { Profiler, type ReactNode } from 'react'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { perfDataDirectory } from '../fixtures/perfWorkspace'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AgentHostSnapshot } from '../../src/shared/agents'
import { share } from '../../src/renderer/src/agents/stateSharing'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../src/renderer/src/agents/splitLayout'
import { Editor } from '@tiptap/core'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const parts = vi.hoisted(() => ({ sidebar: 0, composer: 0 }))
vi.mock('../../src/renderer/src/agents/ThreadSidebar', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/agents/ThreadSidebar')>()
  return { ...actual, ThreadSidebar: (props: Parameters<typeof actual.ThreadSidebar>[0]) =>
    <Profiler id="sidebar" onRender={(_id, _phase, actualDuration) => { parts.sidebar += actualDuration }}><actual.ThreadSidebar {...props} /></Profiler> }
})
vi.mock('../../src/renderer/src/agents/ThreadComposer', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/agents/ThreadComposer')>()
  return { ...actual, ThreadComposer: (props: Parameters<typeof actual.ThreadComposer>[0]) =>
    <Profiler id="composer" onRender={(_id, _phase, actualDuration) => { parts.composer += actualDuration }}><actual.ThreadComposer {...props} /></Profiler> }
})

const ITERATIONS = 20
const WARMUP = 10
const NOW = Date.parse('2026-11-20T18:30:00Z')

describe('thread switch render cost', async () => {
  const dataDirectory = await perfDataDirectory()
  /** Layout getters put back as they were once the run ends. */
  const restore: (() => void)[] = []
  afterAll(() => { cleanup(); for (const put of restore.splice(0)) put(); vi.unstubAllGlobals() })
  describe('requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json', () => {
    it.skipIf(dataDirectory === null)('reports what one switch to another thread renders', async () => {
      const workspace = JSON.parse(await readFile(join(dataDirectory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const host = workspace.snapshot
      const [first, second] = host.threads.filter(thread => thread.kind !== 'watcher' && thread.kind !== 'watcher-history')
      expect(first && second).toBeTruthy()
      let state = stateAround(host, first!.id)
      const command = vi.fn(async () => state)
      const store = new ThreadDraftStore(command)
      vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, command, { threadDrafts: store }))
      let commits = 0, committed = 0
      const view = (): ReactNode => <Profiler id="threads" onRender={(_id, _phase, actual) => { commits++; committed += actual }}>
        <ThreadsView now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} paneAreaHeight={800} />
      </Profiler>
      // jsdom has no ResizeObserver, and the window's measuring hooks stand down without one; a stand-in that never reports
      // lets them run as they do in the window.
      vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
      const canvas = HTMLCanvasElement.prototype.getContext
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: Parameters<typeof canvas>) {
        return (canvas.apply(this, args) ?? { font: '', measureText: (text: string) => ({ width: text.length * 7 }) }) as never
      } as typeof canvas)
      // Every read of layout, counted while a switch commits and its effects run.
      let counting = false, layoutReads = 0
      const count = (): void => { if (counting) layoutReads++ }
      const box = Element.prototype.getBoundingClientRect
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { count(); return box.call(this) })
      const computed = window.getComputedStyle.bind(window)
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => { count(); return computed(element, pseudo) })
      for (const [owner, names] of [[Element.prototype, ['clientWidth', 'clientHeight', 'scrollHeight']], [HTMLElement.prototype, ['offsetWidth', 'offsetHeight']]] as const) {
        for (const name of names) {
          const getter = Object.getOwnPropertyDescriptor(owner, name)!.get!
          Object.defineProperty(owner, name, { configurable: true, get(this: Element) { count(); return getter.call(this) as number } })
          restore.push(() => { Object.defineProperty(owner, name, { configurable: true, get: getter }) })
        }
      }
      // Every reply editor torn down over the timed switches: TipTap takes one down on a timer once its composer has gone, so
      // the count runs across the switches and the timers they leave (#2746).
      let editorsDestroyed = 0, timed = false
      const destroy = Editor.prototype.destroy
      vi.spyOn(Editor.prototype, 'destroy').mockImplementation(function (this: Editor) { if (timed) editorsDestroyed++; return destroy.call(this) })
      const rendered = render(view())
      const samples: number[] = []
      for (let index = 0; index < WARMUP + ITERATIONS; index++) {
        if (index === WARMUP) { commits = 0; committed = 0; parts.sidebar = 0; parts.composer = 0; layoutReads = 0; editorsDestroyed = 0; timed = true }
        const target = index % 2 === 0 ? second! : first!
        const answer = { ...state, activeThreadId: target.id, activeProjectId: target.projectId }
        const started = performance.now()
        state = share(state, answer)
        counting = true
        act(() => { rendered.rerender(view()) })
        counting = false
        if (index >= WARMUP) samples.push(performance.now() - started)
      }
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 50) }) })
      timed = false
      rendered.unmount()
      const report = { threads: host.threads.length, switches: ITERATIONS, msPerSwitch: round(median(samples), 2), reactMsPerSwitch: round(committed / ITERATIONS, 2),
        sidebarMsPerSwitch: round(parts.sidebar / ITERATIONS, 2), composerMsPerSwitch: round(parts.composer / ITERATIONS, 2), commits, layoutReadsPerSwitch: round(layoutReads / ITERATIONS, 1),
        editorsDestroyedPerSwitch: round(editorsDestroyed / ITERATIONS, 1) }
      console.info(`thread switch render: ${JSON.stringify(report)}`)
      expect(commits).toBeGreaterThan(0)
    }, 600_000)
  })
})
