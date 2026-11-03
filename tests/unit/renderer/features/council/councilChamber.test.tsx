import React from 'react'
import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOptionalAgents } from '../../../../../src/renderer/src/agents/AgentContext'
import { CouncilChamber } from '../../../../../src/renderer/src/features/council/CouncilChamber'
import { ChamberPainter } from '../../../../../src/renderer/src/features/council/chamberPainter'
import { chamberCouncil, CouncilView, useSeatsInForce } from '../../../../../src/renderer/src/features/council/CouncilView'
import { useOptionalApp, type AppContextValue } from '../../../../../src/renderer/src/state/AppContext'
import * as canvasColor from '../../../../../src/renderer/src/watcher/canvasColor'
import * as watcherScene from '../../../../../src/renderer/src/watcher/WatcherNightScene'
import type { AgentCommand, AgentModel, AgentState, AgentThread } from '../../../../../src/shared/agents'
import { DEFAULT_SETTINGS } from '../../../../../src/shared/settings'
import { agentContextFixture } from '../../../../fixtures/agentContext'
import { threadsStateFixture, withThread } from '../../../../fixtures/agentState'
import { councilFixture, row } from './chamberFixtures'

vi.mock('../../../../../src/renderer/src/state/AppContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/state/AppContext')>(),
  useOptionalApp: vi.fn(),
}))
vi.mock('../../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/renderer/src/agents/AgentContext')>(),
  useOptionalAgents: vi.fn(),
}))

const running = { status: 'running' as const, lastTurn: { id: 'turn', status: 'running' as const } }
function provide(threads: readonly Partial<AgentThread>[] = []) {
  const state = threadsStateFixture({ threads })
  const command = vi.fn<(request: AgentCommand) => Promise<AgentState | null>>(async () => state)
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, command))
  const navigate = vi.fn(), updateSettings = vi.fn(async () => true)
  vi.mocked(useOptionalApp).mockReturnValue({ navigation: 'council', platform: 'win32', settings: DEFAULT_SETTINGS, actions: { navigate, updateSettings } } as unknown as AppContextValue)
  /** The next state as main publishes it: one thread changed, every other the same object. */
  const publish = (id: string, change: (thread: AgentThread) => AgentThread): void => {
    const current = vi.mocked(useOptionalAgents).mock.results.at(-1)!.value as ReturnType<typeof agentContextFixture>
    vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(withThread(current.state!, id, change), command))
  }
  return { command, navigate, updateSettings, publish }
}
const noSeats = { panelists: [], chair: undefined }

/**
 * A chamber `width` by `height` pixels, with the canvas, observer and frames jsdom lacks, so it lays itself out as in the
 * window. Frames are held until `flush`; `asked` counts the frames the chamber asked for, one per wake while none waits.
 */
function withLayout(width = 1020, height = 380): { readonly asked: () => number; readonly flush: () => void; readonly resize: () => void } {
  const frames = new Map<number, FrameRequestCallback>()
  let asked = 0
  let resize = (): void => undefined
  const context = new Proxy({}, { get: (_, key) => key === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined, set: () => true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never)
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe(): void {} disconnect(): void {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { asked++; frames.set(asked, callback); return asked })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  const size = (pixels: number) => function (this: HTMLElement): number { return this.classList.contains('council-chamber') ? pixels : 0 }
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(size(width))
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(size(height))
  return { asked: () => asked, resize: () => resize(), flush: () => { const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(performance.now()) } }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.reducedMotion; vi.mocked(useOptionalAgents).mockReset(); vi.mocked(useOptionalApp).mockReset() })

describe('the chamber’s motion', () => {
  it('keeps fairness nods at 8 frames per second when poses lag and thread words keep arriving', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const layout = withLayout()
    vi.spyOn(ChamberPainter.prototype, 'ready', 'get').mockReturnValue(true)
    const draw = vi.spyOn(ChamberPainter.prototype, 'draw').mockReturnValue(true)
    const { publish } = provide([{ id: 'thread-a', ...running }])
    const council = councilFixture({ stage: 'fairness', rows: [row('A', 'fairness', 'working')] })
    const { rerender } = render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    layout.flush()
    for (let elapsed = 5; elapsed < 1000; elapsed += 5) {
      vi.advanceTimersByTime(5)
      if (elapsed % 20 === 0) {
        publish('thread-a', thread => ({ ...thread, messages: [{ id: 'm', role: 'assistant', text: `Fair. ${elapsed}`, createdAt: '2026-11-02T10:00:01.000Z' }] }))
        rerender(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
      }
      layout.flush()
    }
    expect(draw).toHaveBeenCalledTimes(8)
  })

  it.each(['resize', 'layout', 'theme', 'visibility'].flatMap(source => [false, true].map(reduced => ({ source, reduced }))))('redraws fairness promptly after $source with reduced motion $reduced', async ({ source, reduced }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    if (reduced) document.documentElement.dataset.reducedMotion = 'on'
    const layout = withLayout()
    const ink = vi.spyOn(canvasColor, 'toRgb').mockReturnValue({ r: 220, g: 220, b: 220 })
    vi.spyOn(watcherScene, 'surfaceOf').mockReturnValue({ r: 0, g: 0, b: 0 })
    vi.spyOn(ChamberPainter.prototype, 'ready', 'get').mockReturnValue(true)
    const draw = vi.spyOn(ChamberPainter.prototype, 'draw').mockReturnValue(true)
    const { publish } = provide([{ id: 'thread-a', ...running }])
    const council = councilFixture({ stage: 'fairness', rows: [row('A', 'fairness', 'working')] })
    const { rerender } = render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(20)
    if (source === 'resize') act(() => layout.resize())
    else if (source === 'layout') rerender(<CouncilChamber council={council} askSeats={noSeats} layout="half-circle" />)
    else if (source === 'theme') await act(async () => {
      ink.mockReturnValue({ r: 20, g: 20, b: 20 })
      // Notify the theme observer without leaving a changed style behind.
      document.documentElement.setAttribute('style', document.documentElement.getAttribute('style') ?? '')
    })
    else document.dispatchEvent(new Event('visibilitychange'))
    // A streaming update before the queued frame must not postpone the forced redraw either.
    publish('thread-a', thread => ({ ...thread, messages: [{ id: 'm', role: 'assistant', text: 'Fair.', createdAt: '2026-11-02T10:00:01.000Z' }] }))
    const chosen = source === 'layout' ? 'half-circle' : 'long-table'
    rerender(<CouncilChamber council={council} askSeats={noSeats} layout={chosen} />)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(2)
    expect(draw.mock.calls.at(-1)![0].still).toBe(reduced)
    vi.advanceTimersByTime(100)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(25)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(reduced ? 2 : 3)
  })

  it.each(['system', 'setting'])('stops animation when reduced motion is turned on by the %s, and redraws state changes still', async source => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const media = Object.assign(new EventTarget(), { matches: false })
    vi.stubGlobal('matchMedia', () => media)
    const layout = withLayout()
    vi.spyOn(ChamberPainter.prototype, 'ready', 'get').mockReturnValue(true)
    const draw = vi.spyOn(ChamberPainter.prototype, 'draw').mockReturnValue(true)
    provide()
    const { rerender } = render(<CouncilChamber council={councilFixture({ stage: 'reviews' })} askSeats={noSeats} layout="half-circle" />)
    layout.flush()
    await act(async () => {
      if (source === 'system') { media.matches = true; media.dispatchEvent(new Event('change')) }
      else document.documentElement.dataset.reducedMotion = 'on'
    })
    layout.flush()
    expect(draw.mock.calls.at(-1)![0].still).toBe(true)
    const stopped = draw.mock.calls.length
    vi.advanceTimersByTime(1000)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(stopped)
    rerender(<CouncilChamber council={councilFixture({ stage: 'fairness', rows: [row('A', 'fairness', 'working')] })} askSeats={noSeats} layout="half-circle" />)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(stopped + 1)
    expect(draw.mock.calls.at(-1)![0]).toMatchObject({ still: true, flights: [] })
    vi.advanceTimersByTime(1000)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(stopped + 1)
    await act(async () => {
      if (source === 'system') { media.matches = false; media.dispatchEvent(new Event('change')) }
      else delete document.documentElement.dataset.reducedMotion
    })
    layout.flush()
    expect(draw.mock.calls.at(-1)![0].still).toBe(false)
    const resumed = draw.mock.calls.length
    vi.advanceTimersByTime(125)
    layout.flush()
    expect(draw).toHaveBeenCalledTimes(resumed + 1)
  })
})

describe('the chamber’s figures', () => {
  it('puts a button over each figure, left to right, that names its model, what it does and what a press does, and keeps the canvas from assistive technology', () => {
    withLayout()
    provide([
      { id: 'thread-a', ...running, activities: [{ id: 'x', turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'Run', command: 'git log -5' }] },
      { id: 'thread-b', ...running, messages: [{ id: 'm', role: 'assistant', text: 'Now.', createdAt: '2026-11-02T10:00:01.000Z' }] },
      { id: 'thread-c', requests: [{ id: 'r', kind: 'question', title: 'Keep them?' } as never] },
      { id: 'thread-chair' },
    ])
    const council = councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'working'), row('B', 'answer', 'working'), row('C', 'answer', 'working')] })
    const { container } = render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true')
    // At the long table C sits furthest left, then A, the chair at the centre, and B.
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'C, Grok 4.7, needs your answer. Open its thread',
      'A, Opus 5.5, working: git log -5. Open its thread',
      'Chair, Wonder Full, listening. Open its thread',
      'B, GPT-6.1 Sol, writing its answer. Open its thread',
    ])
    const left = screen.getAllByRole('button').map(button => parseFloat(button.style.left))
    expect(left).toEqual([...left].sort((one, other) => one - other))
  })

  it('has no tab stop for a figure with no place on screen: none before it is laid out, and none in a chamber too small to draw', () => {
    provide()
    const council = councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'working')] })
    render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(screen.queryAllByRole('button')).toEqual([])
    cleanup()
    withLayout(1020, 6)
    render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('draws again for its own threads, and not for a thread elsewhere that changes', () => {
    const layout = withLayout()
    const { publish } = provide([{ id: 'thread-a', ...running, messages: [{ id: 'm', role: 'assistant', text: 'Wait.', createdAt: '2026-11-02T10:00:01.000Z' }] }, { id: 'elsewhere', ...running }])
    const council = councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'working')] })
    const { rerender } = render(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    layout.flush()
    const asked = layout.asked()
    publish('elsewhere', thread => ({ ...thread, messages: [{ id: 'x', role: 'assistant', text: 'Streaming elsewhere.', createdAt: '2026-11-02T10:00:02.000Z' }] }))
    rerender(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(layout.asked()).toBe(asked)
    publish('thread-a', thread => ({ ...thread, messages: [...thread.messages.slice(0, -1), { id: 'm', role: 'assistant', text: 'Wait until 0.2.', createdAt: '2026-11-02T10:00:01.000Z' }] }))
    rerender(<CouncilChamber council={council} askSeats={noSeats} layout="long-table" />)
    expect(layout.asked()).toBe(asked + 1)
  })

  it('keeps a finished Council’s scene and the Ask view still whatever the threads do', () => {
    const layout = withLayout()
    const { publish } = provide([{ id: 'thread-a', ...running }])
    const finished = councilFixture({ stage: 'done', rows: [row('A', 'answer', 'done')] }, { status: 'done' })
    const seats = { panelists: [undefined, undefined], chair: undefined }
    for (const council of [finished, null]) {
      const { rerender } = render(<CouncilChamber council={council} askSeats={seats} layout="half-circle" />)
      layout.flush()
      const asked = layout.asked()
      publish('thread-a', thread => ({ ...thread, messages: [{ id: 'y', role: 'assistant', text: 'More.', createdAt: '2026-11-02T10:00:03.000Z' }] }))
      rerender(<CouncilChamber council={council} askSeats={seats} layout="half-circle" />)
      expect(layout.asked()).toBe(asked)
      cleanup()
    }
  })

  it('keeps the Ask view’s seats while a new catalog holds the same models', () => {
    const models = [{ id: 'claude:opus', providerId: 'claude', provider: 'Claude', name: 'Opus 5.5', ready: true }] as AgentModel[]
    const panel = { panelists: [null, null], chair: null }
    const { result, rerender } = renderHook(({ catalog }) => useSeatsInForce(panel, catalog), { initialProps: { catalog: models } })
    const first = result.current
    rerender({ catalog: models.map(model => ({ ...model })) })
    expect(result.current).toBe(first)
    rerender({ catalog: models.map(model => ({ ...model, name: 'Opus 5.6' })) })
    expect(result.current).not.toBe(first)
  })

  it('opens a figure’s thread on a press', async () => {
    withLayout()
    const { command, navigate } = provide()
    render(<CouncilChamber council={councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'done')] })} askSeats={noSeats} layout="half-circle" />)
    await userEvent.click(screen.getByRole('button', { name: 'A, Opus 5.5, done. Open its thread' }))
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread-a' })
    expect(navigate).toHaveBeenCalledWith('threads')
  })

  it('reaches the figures from the keyboard and opens the focused thread with Enter', async () => {
    withLayout()
    const { command, navigate } = provide()
    render(<CouncilChamber council={councilFixture({})} askSeats={noSeats} layout="long-table" />)
    const user = userEvent.setup()
    await user.keyboard('{Tab}')
    const first = screen.getAllByRole('button')[0]!
    expect(first).toHaveFocus()
    expect(first).toHaveClass('council-chamber__figure', 'tt-focusable')
    await user.keyboard('{Enter}')
    expect(command).toHaveBeenCalledWith({ type: 'select-thread', threadId: 'thread-c' })
    expect(navigate).toHaveBeenCalledWith('threads')
  })

  it('asks for the Council’s threads’ histories while it shows them, and lets them go when it goes', () => {
    const { command } = provide()
    const { unmount } = render(<CouncilChamber council={councilFixture({})} askSeats={noSeats} layout="round-table" />)
    expect(command).toHaveBeenCalledWith({ type: 'observe-threads', threadIds: ['thread-a', 'thread-b', 'thread-c', 'thread-chair'] })
    unmount()
    expect(command).toHaveBeenLastCalledWith({ type: 'observe-threads', threadIds: [] })
  })

  it('has no buttons in the Ask view, where no thread has started, and asks for no history', () => {
    const { command } = provide()
    render(<CouncilChamber council={null} askSeats={{ panelists: [undefined, undefined], chair: undefined }} layout="long-table" />)
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(command).not.toHaveBeenCalled()
  })

  it('shows the Council being worked, the newest of them, else the newest finished one until a new question is started', () => {
    const older = councilFixture({}, { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-11-01T10:00:00.000Z', status: 'waiting' })
    const newer = councilFixture({}, { createdAt: '2026-11-02T10:00:00.000Z' })
    expect(chamberCouncil([older, newer], false)).toBe(newer)
    // Another Council at work takes the chamber from a finished one, whatever the Ask form holds.
    expect(chamberCouncil([older, { ...newer, status: 'done' }], true)).toBe(older)
    const done = { ...newer, status: 'done' as const }
    expect(chamberCouncil([done, { ...older, status: 'settled' }], false)).toBe(done)
    expect(chamberCouncil([done, { ...older, status: 'settled' }], true)).toBeNull()
    // A stopped or settled newest Council gives the Ask view, never an older finished one.
    expect(chamberCouncil([{ ...newer, status: 'stopped' }, { ...older, status: 'done' }], false)).toBeNull()
    expect(chamberCouncil([{ ...newer, status: 'settled' }, { ...older, status: 'done' }], false)).toBeNull()
    expect(chamberCouncil(null, false)).toBeNull()
  })

  it('keeps a finished Council’s figures to open, and asks for none of their histories', () => {
    withLayout()
    const { command } = provide()
    render(<CouncilChamber council={councilFixture({ stage: 'done', rows: [row('A', 'answer', 'done')] }, { status: 'done' })} askSeats={noSeats} layout="long-table" />)
    expect(screen.getByRole('button', { name: 'Chair, Wonder Full, holding up the verdict. Open its thread' })).toBeInTheDocument()
    expect(command).not.toHaveBeenCalled()
  })
})

describe('the Council page’s Layout menu', () => {
  it('names the layout, changes the setting, and closes on Escape with focus back on its button', async () => {
    const user = userEvent.setup()
    const { updateSettings } = provide()
    render(<CouncilView bridge={undefined} />)
    const button = screen.getByRole('button', { name: 'Layout: Long table' })
    await user.click(button)
    const menu = screen.getByRole('listbox', { name: 'Layout' })
    expect(within(menu).getAllByRole('option').map(option => option.textContent)).toEqual(['Long table', 'Half circle', 'Round table'])
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(button).toHaveFocus()
    await user.click(button)
    await user.click(screen.getByRole('option', { name: 'Round table' }))
    expect(updateSettings).toHaveBeenCalledWith({ councilLayout: 'round-table' })
    expect(button).toHaveFocus()
  })
})
