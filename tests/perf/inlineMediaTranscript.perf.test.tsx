/**
 * What an agent's pictures cost a long thread (ADR-0170): the Threads page opened on a thread of 400 messages whose 200
 * turns each took a screenshot, against the same thread with no pictures. Synthetic, so it runs in CI on every pull
 * request, where it holds the counts that do not wobble:
 *
 *   - a streamed chunk commits as often with pictures as without, and reads no picture;
 *   - opening the thread reads only the tiles near the screen;
 *   - a scroll step reads only the tiles that came near, and the tiles that left let go of their pictures;
 *   - the owl at the easel, playing while an image is made, draws nothing off screen or once the picture lands, no more
 *     than twelve frames a second in view, and never through React;
 *   - the same thread with a video in each turn (part 4): a chunk commits as often, nothing plays on its own, only the
 *     near tiles hold a video's source, and a video reads nothing until it is played.
 *
 * The milliseconds print every run, for the before and after numbers each pull request in docs/plans/inline-media.md
 * shows; they are asserted only under SOTTO_PERF_ASSERT=1. jsdom has no layout, so "near the screen" is the observer
 * this test drives, standing in for the scroller's.
 *
 *   npx vitest run tests/perf/inlineMediaTranscript.perf.test.tsx --maxWorkers=1 --disable-console-intercept
 */
import React, { Profiler, type ReactNode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentContextFixture } from '../fixtures/agentContext'
import { stateAround, withChunk } from './support/transcriptState'
import { round } from '../fixtures/perfBench'
import { upperMedian as median } from './support/statistics.mjs'
import { EMPTY_AGENT_HOST, type AgentHostSnapshot, type AgentMessage, type AgentThread } from '../../src/shared/agents'
import type { AgentActivity } from '../../src/shared/agentActivity'
import { share } from '../../src/renderer/src/agents/stateSharing'
import { useAgents } from '../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../src/renderer/src/agents/ThreadsView'
import { ThreadDraftStore } from '../../src/renderer/src/agents/threadDraftStore'
import { SplitLayoutStore } from '../../src/renderer/src/agents/splitLayout'
import { threadMediaRequests, threadVideoLoads } from '../../src/renderer/src/agents/threadMediaSources'
import { owlEaselFramesDrawn } from '../../src/renderer/src/agents/OwlEasel'

vi.mock('../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../src/renderer/src/state/owlFeature', () => ({ useOwlFeature: (id: string) => id === 'inline-media' }))

const TURNS = 200
const ITERATIONS = 20
const WARMUP = 10
const MOUNTS = 5
const MOUNT_WARMUP = 2
/** How many tiles count as near the screen at once: a screen and a half either side of a pane's worth. */
const NEAR = 6
/** How many one-turn scroll steps each run takes; fewer than the page's tiles less the near ones, so every step brings one in. */
const SCROLL_STEPS = 30
const NOW = Date.parse('2026-10-31T12:00:00Z')
const TILE = 'data:image/jpeg;base64,/9j/4AAQ'

/** The observer jsdom lacks. The test says which tiles are near; each change reaches the tile's own listener. */
class DrivenObserver {
  static all = new Set<DrivenObserver>()
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) { DrivenObserver.all.add(this) }
  observe(target: Element): void { this.targets.add(target) }
  unobserve(target: Element): void { this.targets.delete(target) }
  disconnect(): void { this.targets.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  /** Tells every observer which of its targets are near now. */
  static near(near: ReadonlySet<Element>): void {
    for (const observer of DrivenObserver.all) {
      const entries = [...observer.targets].map(target => ({ target, isIntersecting: near.has(target) }) as unknown as IntersectionObserverEntry)
      if (entries.length) observer.callback(entries, observer as unknown as IntersectionObserver)
    }
  }
}

/** The last `making` turns' steps are images still being made: running, with no picture yet. `media` is what each turn holds. */
function thread(media: boolean | 'videos', making = 0): AgentThread {
  const pictures = media !== false
  const messages: AgentMessage[] = []
  const activities: AgentActivity[] = []
  for (let index = 0; index < TURNS; index += 1) {
    const at = (offset: number) => new Date(NOW - (TURNS - index) * 120_000 + offset).toISOString()
    messages.push({ id: `u${index}`, role: 'user', text: `Check page ${index} and show me.`, createdAt: at(0) })
    messages.push({ id: `a${index}`, role: 'assistant', text: `Page ${index} looks right. The header holds and the footer is where it should be.`, createdAt: at(60_000) })
    activities.push({ id: `tool-${index}`, turnId: `u${index}`, sequence: index, afterMessageId: `u${index}`, kind: 'tool', status: 'completed',
      title: 'sotto_browser / screenshot', output: 'Took a screenshot.', startedAt: at(1_000), completedAt: at(2_000),
      ...media === 'videos' ? { media: [{ id: 'm0', digest: index.toString(16).padStart(64, '0'), kind: 'video' as const, mimeType: 'video/webm' as const,
        sizeBytes: 14_000_000, name: 'recording.webm', source: 'file' as const }] }
        : pictures ? { media: [{ id: 'm0', digest: index.toString(16).padStart(64, '0'), kind: 'image' as const, mimeType: 'image/png' as const,
        sizeBytes: 480_000, width: 1280, height: 800, name: 'picture-1.png', source: 'tool' as const }] } : {} })
    if (index >= TURNS - making) activities[index] = { ...activities[index]!, title: 'Image', status: 'running', generates: 'image', media: undefined, output: undefined, completedAt: undefined }
  }
  return { id: 'media-thread', projectId: 'project', title: 'Check every page', modelId: 'claude:test', providerId: 'claude', status: 'running', requests: [], messages, activities }
}

const host = (open: AgentThread): AgentHostSnapshot => ({ ...EMPTY_AGENT_HOST, connected: true, projects: [{ id: 'project', title: 'Project', path: '/repo' }], threads: [open] })

describe('inline media cost', () => {
  const realObserver = globalThis.IntersectionObserver
  const bridge = vi.fn(async () => ({ dataUrl: TILE }))
  beforeAll(() => {
    globalThis.IntersectionObserver = DrivenObserver as unknown as typeof IntersectionObserver
    ;(window as unknown as { sotto: unknown }).sotto = { agents: { threadMedia: bridge } }
  })
  afterEach(() => { cleanup(); DrivenObserver.all.clear() })
  afterAll(() => { globalThis.IntersectionObserver = realObserver; delete (window as unknown as { sotto?: unknown }).sotto })

  it('holds a streamed chunk, mount and scroll to their counts with 200 pictures', async () => {
    let commits = 0, committed = 0
    const measure = async (pictures: boolean | 'videos') => {
      const open = thread(pictures)
      let state = stateAround(host(open), open.id)
      const store = new ThreadDraftStore(vi.fn(async () => state))
      vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, vi.fn(async () => state), { threadDrafts: store }))
      const view = (): ReactNode => <Profiler id="threads" onRender={(_id, _phase, actual) => { commits++; committed += actual }}>
        <ThreadsView now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} paneAreaHeight={800} />
      </Profiler>

      const mounts: number[] = []
      for (let index = 0; index < MOUNT_WARMUP + MOUNTS; index += 1) {
        const started = performance.now()
        const mounted = render(view())
        if (index >= MOUNT_WARMUP) mounts.push(performance.now() - started)
        mounted.unmount(); DrivenObserver.all.clear()
      }

      const rendered = render(view())
      const tiles = (): HTMLButtonElement[] => [...rendered.container.querySelectorAll<HTMLButtonElement>('.thread-media .rich-attachment__frame')]
      const holding = (): number => rendered.container.querySelectorAll('.thread-media img[src], .thread-media video[src]').length
      const flush = async (): Promise<void> => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }

      // Opening: the newest tiles are near, as a pane opened at its end shows them.
      const readsBefore = threadMediaRequests(), loadsBefore = threadVideoLoads()
      await act(async () => { DrivenObserver.near(new Set(tiles().slice(-NEAR))) })
      await flush()
      const mountReads = threadMediaRequests() - readsBefore
      const mountVideoLoads = threadVideoLoads() - loadsBefore

      // Streaming: a chunk on the newest reply, as the window receives it.
      const samples: number[] = []
      const readsBeforeChunks = threadMediaRequests(), loadsBeforeChunks = threadVideoLoads()
      for (let index = 0; index < WARMUP + ITERATIONS; index += 1) {
        if (index === WARMUP) { commits = 0; committed = 0 }
        const started = performance.now()
        state = share(state, withChunk(state, open.id, ` chunk ${index}`))
        act(() => { rendered.rerender(view()) })
        if (index >= WARMUP) samples.push(performance.now() - started)
      }
      const chunkCommits = commits
      const chunkReact = committed / ITERATIONS
      const chunkReads = threadMediaRequests() - readsBeforeChunks
      const chunkVideoLoads = threadVideoLoads() - loadsBeforeChunks

      // Scrolling up a turn at a time: the near window moves by one, the same SCROLL_STEPS steps with pictures or without.
      // Without pictures nothing on the page watches the scroll, which is the cost a step had before (the baseline).
      const all = tiles()
      const steps: number[] = []
      const readsBeforeScroll = threadMediaRequests(), loadsBeforeScroll = threadVideoLoads()
      let mostHeld = holding()
      for (let step = 0; step < SCROLL_STEPS; step += 1) {
        const end = all.length - 1 - step
        const started = performance.now()
        await act(async () => { DrivenObserver.near(new Set(all.slice(Math.max(0, end - NEAR), Math.max(0, end)))) })
        await flush()
        steps.push(performance.now() - started)
        mostHeld = Math.max(mostHeld, holding())
      }
      const scrollReads = threadMediaRequests() - readsBeforeScroll
      const scrollVideoLoads = threadVideoLoads() - loadsBeforeScroll
      const result = { tiles: all.length, mountMs: round(median(mounts), 2), chunkMs: round(median(samples), 2), chunkReactMs: round(chunkReact, 3),
        chunkCommits, chunkReads, mountReads, scrollSteps: steps.length, scrollStepMs: round(median(steps), 2), scrollReads, mostHeld,
        mountVideoLoads, chunkVideoLoads, scrollVideoLoads }
      rendered.unmount()
      return result
    }

    const without = await measure(false)
    const withPictures = await measure(true)
    const played = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const withVideos = await measure('videos')
    console.info(`inline media: ${JSON.stringify({ without, withPictures, withVideos })}`)
    // A video never plays until it is pressed, holds its source only near the screen, and is read by its player, not as a picture.
    expect(played).not.toHaveBeenCalled()
    played.mockRestore()
    expect(withVideos.tiles).toBe(withPictures.tiles)
    expect(withVideos.chunkCommits).toBe(without.chunkCommits)
    expect(withVideos.chunkReads + withVideos.mountReads + withVideos.scrollReads).toBe(0)
    // Its player is given a source as its tile comes near, as a picture is read: the near ones at opening, one a scroll
    // step, none for a streamed chunk.
    expect(withVideos.mountVideoLoads).toBe(NEAR)
    expect(withVideos.chunkVideoLoads).toBe(0)
    expect(withVideos.scrollVideoLoads).toBe(withVideos.scrollSteps)
    expect(withPictures.mountVideoLoads + withPictures.scrollVideoLoads).toBe(0)
    expect(withVideos.mostHeld).toBeLessThanOrEqual(NEAR)

    // The page draws its newest messages first, so some of the 200 turns' tiles are on it, and none without pictures.
    expect(without.tiles).toBe(0)
    expect(withPictures.tiles).toBeGreaterThan(NEAR)
    // A streamed chunk is the same work with pictures as without, and reads none.
    expect(withPictures.chunkCommits).toBe(without.chunkCommits)
    expect(withPictures.chunkReads).toBe(0)
    // Opening reads only the near tiles; each scroll step reads only the tile that came near.
    expect(withPictures.mountReads).toBe(NEAR)
    expect(withPictures.scrollReads).toBe(withPictures.scrollSteps)
    expect(without.scrollReads).toBe(0)
    // A tile that leaves lets go of its picture, so the page never holds more than the near ones.
    expect(withPictures.mostHeld).toBeLessThanOrEqual(NEAR)
    if (process.env.SOTTO_PERF_ASSERT === '1') {
      expect(withPictures.chunkReactMs).toBeLessThan(Math.max(without.chunkReactMs * 1.25, without.chunkReactMs + 0.5))
      expect(withPictures.mountMs).toBeLessThan(without.mountMs * 1.5)
      expect(withPictures.scrollStepMs).toBeLessThan(without.scrollStepMs + 5)
      expect(withVideos.chunkReactMs).toBeLessThan(Math.max(without.chunkReactMs * 1.25, without.chunkReactMs + 0.5))
      expect(withVideos.mountMs).toBeLessThan(without.mountMs * 1.5)
    }
  }, 300_000)

  it('plays the owl at the easel only while in view and until the picture lands, outside React', async () => {
    const MAKING = 2, SECONDS = 2, FRAME = 1000 / 12
    // jsdom paints nothing, so the test is the display: it runs each frame the scene asked for, a sixtieth of a second apart.
    let queued = new Map<number, FrameRequestCallback>(), serial = 0, clock = 0
    const realFrame = globalThis.requestAnimationFrame, realCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = callback => { serial += 1; queued.set(serial, callback); return serial }
    globalThis.cancelAnimationFrame = handle => { queued.delete(handle) }
    const play = (seconds: number): void => {
      for (let tick = 0; tick < seconds * 60; tick += 1) { clock += 1000 / 60; const now = queued; queued = new Map(); for (const run of now.values()) run(clock) }
    }
    try {
      let open = thread(true, MAKING)
      let state = stateAround(host(open), open.id)
      const store = new ThreadDraftStore(vi.fn(async () => state))
      vi.mocked(useAgents).mockImplementation(() => agentContextFixture(state, vi.fn(async () => state), { threadDrafts: store }))
      let commits = 0
      const view = (): ReactNode => <Profiler id="threads" onRender={() => { commits++ }}>
        <ThreadsView now={NOW} layoutStore={new SplitLayoutStore()} paneAreaWidth={1200} paneAreaHeight={800} />
      </Profiler>
      const before = owlEaselFramesDrawn()
      const rendered = render(view())
      const scenes = (): Element[] => [...rendered.container.querySelectorAll('.owl-easel')]
      expect(scenes()).toHaveLength(MAKING)
      // A scene draws nothing until it first comes on screen.
      const mountFrames = owlEaselFramesDrawn() - before

      // Off screen: nothing runs.
      await act(async () => { DrivenObserver.near(new Set()) })
      let drawn = owlEaselFramesDrawn()
      play(SECONDS)
      const offScreenFrames = owlEaselFramesDrawn() - drawn
      const offScreenQueued = queued.size

      // In view: twelve frames a second each, written straight into the page.
      await act(async () => { DrivenObserver.near(new Set(scenes())) })
      drawn = owlEaselFramesDrawn(); commits = 0
      const started = performance.now()
      play(SECONDS)
      const playMs = performance.now() - started
      const inViewFrames = owlEaselFramesDrawn() - drawn
      const playCommits = commits

      // The pictures land: the scenes go, and with them every frame they asked for.
      open = { ...open, activities: open.activities!.map(record => record.generates ? { ...record, status: 'completed', media: [{ id: 'm0', digest: 'f'.repeat(64), kind: 'image', mimeType: 'image/png', sizeBytes: 900_000, width: 1024, height: 1024, name: 'picture-1.png', source: 'generated' }] } : record) }
      state = stateAround(host(open), open.id)
      act(() => { rendered.rerender(view()) })
      drawn = owlEaselFramesDrawn()
      play(SECONDS)
      const landedFrames = owlEaselFramesDrawn() - drawn
      const result = { scenes: MAKING, mountFrames, offScreenFrames, offScreenQueued, inViewFrames, inViewFramesPerSceneSecond: round(inViewFrames / MAKING / SECONDS, 1),
        playCommits, playFrameMs: round(playMs / Math.max(1, inViewFrames), 3), landedScenes: scenes().length, landedFrames, landedQueued: queued.size }
      console.info(`owl at the easel: ${JSON.stringify(result)}`)
      rendered.unmount()

      expect(mountFrames).toBe(0)
      expect(offScreenFrames).toBe(0)
      expect(offScreenQueued).toBe(0)
      expect(inViewFrames).toBeGreaterThan(0)
      // At most twelve a second each, and the one each draws the moment it comes on screen.
      expect(inViewFrames).toBeLessThanOrEqual(MAKING * (Math.ceil(SECONDS * 1000 / FRAME) + 1))
      expect(playCommits).toBe(0)
      expect(result.landedScenes).toBe(0)
      expect(landedFrames).toBe(0)
      expect(result.landedQueued).toBe(0)
      if (process.env.SOTTO_PERF_ASSERT === '1') expect(result.playFrameMs).toBeLessThan(1)
    } finally {
      globalThis.requestAnimationFrame = realFrame; globalThis.cancelAnimationFrame = realCancel
    }
  }, 120_000)
})
