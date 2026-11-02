/**
 * What marking a picture up costs (ADR-0170, part 5). Mark up lives in the viewer and adds nothing to a thread until the
 * user opens it: the transcript's own costs are `inlineMediaTranscript.perf.test.tsx`'s. Counted here, always:
 *
 *   - opening a picture: the commits and the elements the viewer draws, with Mark up among its controls;
 *   - opening the editor: it reads nothing more, since it draws the picture the viewer already holds;
 *   - drawing a pen line of 200 moves over a picture that already holds 20 marks: each move redraws only the line being
 *     drawn, never the marks already made, and the line is drawn as a finished mark once, when the pen lifts.
 *
 * The milliseconds print every run, for the before and after numbers docs/plans/inline-media.md asks of every pull
 * request; they are asserted only under SOTTO_PERF_ASSERT=1. Making the marked copy needs a canvas, which jsdom lacks;
 * `tests/e2e/inline-media-markup.spec.ts` times that in the built app.
 *
 *   npx vitest run tests/perf/markupEditor.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import React, { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { ActivityGroup } from '../../src/renderer/src/agents/threadActivityView'
import { round } from '../fixtures/perfBench'
import { upperMedian as median } from './support/statistics.mjs'

vi.mock('../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' }))
import { ThreadMediaTiles } from '../../src/renderer/src/agents/ThreadMediaTiles'
import * as markup from '../../src/renderer/src/agents/markup'
import * as replyAttach from '../../src/renderer/src/agents/replyAttach'

const RUNS = 5
const TILE = 'data:image/jpeg;base64,/9j/4AAQ'
const WHOLE = 'data:image/png;base64,iVBORw0KGgo='
const record: AgentActivity = { id: 'claude-tool-shot', turnId: 'turn', sequence: 0, kind: 'tool', status: 'completed', title: 'sotto_browser / screenshot',
  media: [{ id: 'm0', digest: '0'.repeat(64), kind: 'image', mimeType: 'image/png', sizeBytes: 40, width: 1920, height: 1200, name: 'checkout.png', source: 'tool' }] }
const groups = [{ key: 'g', turnId: 'turn', anchorMessageId: null, records: [record] }] as unknown as ActivityGroup[]

/** A thread pane's reply box, which takes the marked copy; before part 5 there was none, and the tiles render bare. */
const added: File[][] = []
function InPane({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  const context = (replyAttach as { ReplyAttachContext?: React.Context<unknown> }).ReplyAttachContext
  if (!context) return children
  const slot = { current: { refusal: () => null, add: async (files: readonly File[]) => { added.push([...files]); return null }, focus: () => undefined } }
  return <context.Provider value={slot}>{children}</context.Provider>
}
/** jsdom loads no image: the viewer's picture says it is 1920 by 1200 once it is told it loaded. */
function loaded(): void {
  const image = document.querySelector<HTMLImageElement>('.attachment-viewer img[src]')!
  Object.defineProperty(image, 'naturalWidth', { value: 1920, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: 1200, configurable: true })
  fireEvent.load(image)
}

class NearObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void { this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
  unobserve(): void { /* nothing held */ }
  disconnect(): void { /* nothing held */ }
}

describe('marking a picture up', () => {
  const real = globalThis.IntersectionObserver
  const threadMedia = vi.fn(async (request: { size: string }) => ({ dataUrl: request.size === 'tile' ? TILE : WHOLE }))
  beforeAll(() => {
    globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia } }
  })
  afterAll(() => { globalThis.IntersectionObserver = real; delete (window as unknown as { sotto?: unknown }).sotto })

  it('costs nothing until it is opened, and a line redraws only itself', async () => {
    const open: number[] = [], openCommits: number[] = [], openElements: number[] = []
    for (let run = 0; run < RUNS; run++) {
      let commits = 0
      render(<Profiler id="tiles" onRender={() => { commits += 1 }}><InPane><ThreadMediaTiles groups={groups} threadId="thread" /></InPane></Profiler>)
      await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(1))
      commits = 0
      const started = performance.now()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Open picture 1 of 1/u })) })
      await waitFor(() => expect(document.querySelector('.attachment-viewer img[src]')).toBeTruthy())
      open.push(performance.now() - started); openCommits.push(commits)
      openElements.push(document.querySelector('.attachment-viewer')!.querySelectorAll('*').length)
      cleanup()
    }
    const viewer = { openMs: round(median(open), 2), openCommits: median(openCommits), viewerElements: median(openElements) }

    const editor = typeof markup === 'object' && 'MARKUP_TOOLS' in markup ? await drawing(threadMedia) : null
    console.info(`markup: ${JSON.stringify({ viewer, editor })}`)
    if (process.env.SOTTO_PERF_ASSERT === '1') expect(viewer.openMs).toBeLessThan(200)
  }, 120_000)
})

/** Opens the editor on the picture, makes 20 marks, then draws a pen line of 200 moves and counts what each move redraws. */
async function drawing(threadMedia: ReturnType<typeof vi.fn>): Promise<Record<string, number>> {
  render(<InPane><ThreadMediaTiles groups={groups} threadId="thread" /></InPane>)
  await waitFor(() => expect(document.querySelectorAll('.thread-media img[src]')).toHaveLength(1))
  fireEvent.click(screen.getByRole('button', { name: /^Open picture 1 of 1/u }))
  await waitFor(() => expect(document.querySelector('.attachment-viewer img[src]')).toBeTruthy())
  loaded()
  const reads = threadMedia.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Mark up' }))
  const surface = await screen.findByRole('application', { name: /Picture to mark up/u })
  // jsdom has no layout: the surface stands at 0,0 and is the picture's own size, so a pointer's place is a pixel's.
  surface.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1920, bottom: 1200, width: 1920, height: 1200, toJSON: () => ({}) })
  const stroke = (from: number, moves: number, step: number): void => {
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: from, clientY: from, pointerType: 'mouse', button: 0 })
    for (let index = 1; index <= moves; index++) fireEvent.pointerMove(surface, { pointerId: 1, clientX: from + index * step, clientY: from + index * step, pointerType: 'mouse' })
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: from + moves * step, clientY: from + moves * step, pointerType: 'mouse' })
  }
  for (let index = 0; index < 20; index++) stroke(20 + index * 40, 4, 10)
  expect(surface.querySelectorAll('[data-markup-shape]')).toHaveLength(20)
  fireEvent.click(screen.getByRole('button', { name: /^Pen/u }))
  const marks = [...surface.querySelectorAll('[data-markup-shape]')]
  markup.markRedraws.count = 0
  const started = performance.now()
  stroke(100, 200, 4)
  const ms = performance.now() - started
  const kept = marks.every(mark => mark.isConnected)
  const result = { readsOpeningEditor: threadMedia.mock.calls.length - reads, marksBefore: 20, penMoves: 200, markRedraws: markup.markRedraws.count, marksKept: kept ? 1 : 0, strokeMs: round(ms, 1), perMoveMs: round(ms / 200, 3) }
  expect(result.readsOpeningEditor).toBe(0)
  // The new line is drawn once as a finished mark when the pen lifts; none of the 20 before it is drawn again.
  expect(result.markRedraws).toBe(1)
  expect(kept).toBe(true)
  expect(surface.querySelectorAll('[data-markup-shape]')).toHaveLength(21)
  cleanup()
  return result
}
