import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateStatus } from '../../../src/shared/contracts'
import type { MainActivityBridge, MainActivityCommand, MainActivityState } from '../../../src/shared/mainActivity'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/shared/settings'
import { AppProvider } from '../../../src/renderer/src/state/AppContext'
import { MainFreezeNotice } from '../../../src/renderer/src/features/performance/MainFreezeNotice'
import { PerformanceSettings } from '../../../src/renderer/src/features/performance/PerformanceSettings'
import { takeNewThreadIntent } from '../../../src/renderer/src/agents/threadIntent'
import { createBridge, createController } from '../../fixtures/renderer/appHarness'

afterEach(cleanup)

const bars = Array.from({ length: 60 }, (_, index) => (index % 3 === 0 ? 900 : 300))
const frozen: MainActivityState = { reading: { blockedShare: 0.7, longestFreezeMs: 1_900, freezesOver100ms: 23, bars, frozen: true }, recording: { phase: 'idle' }, noticeHidden: false }
const calm: MainActivityState = { ...frozen, reading: { blockedShare: 0.03, longestFreezeMs: 90, freezesOver100ms: 0, bars: bars.map(() => 20), frozen: false } }
const saved: MainActivityState = { ...calm, recording: { phase: 'saved', name: 'sotto-activity-2026-10-20-14-32-05', folder: 'C:\\Sotto\\performance-recordings\\sotto-activity-2026-10-20-14-32-05',
  files: ['main.cpuprofile', 'window.cpuprofile', 'summary.json'], bytes: 3_400_000, windowRecorded: true } }

/** Main's side, as the bridge sees it: `answer` decides what each press changes. */
function activity(initial: MainActivityState, answer: (command: MainActivityCommand, current: MainActivityState) => MainActivityState = (_command, current) => current) {
  let current = initial
  const listeners = new Set<(state: MainActivityState) => void>()
  const command = vi.fn(async (request: MainActivityCommand) => { current = answer(request, current); return current })
  const bridge: MainActivityBridge = {
    read: vi.fn(async () => current),
    command,
    onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const publish = (next: MainActivityState): void => { current = next; act(() => { for (const listener of listeners) listener(next) }) }
  return { bridge, command, publish }
}

function update(owl: boolean): UpdateStatus {
  return { currentVersion: owl ? '0.1.38-owl.20261020.1' : '0.1.38', releaseTrack: owl ? 'owl' : 'stable', owlFeatures: { 'main-freeze': owl }, phase: { phase: 'unsupported' }, checkedAt: null }
}

function app(owl: boolean, children: React.ReactNode, settings: Partial<AppSettings> = {}) {
  return <AppProvider bridge={createBridge({ getUpdateStatus: async () => update(owl), getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }) })} createController={createController}>{children}</AppProvider>
}

describe('the main freeze notice', () => {
  it('shows nothing, and asks main nothing, where the Owl feature is off', async () => {
    const { bridge } = activity(frozen)
    const { container } = render(app(false, <MainFreezeNotice bridge={bridge} />))
    await act(async () => undefined)
    expect(container).toBeEmptyDOMElement()
    expect(bridge.read).not.toHaveBeenCalled()
  })

  it('shows while main is frozen and goes when it recovers', async () => {
    const { bridge, publish } = activity(calm)
    render(app(true, <MainFreezeNotice bridge={bridge} />))
    await act(async () => undefined)
    expect(screen.queryByRole('button', { name: /Main is slow/ })).toBeNull()
    publish(frozen)
    expect(await screen.findByRole('button', { name: 'Main is slow: blocked 70% of the last minute. Show details' })).toHaveTextContent('Main is slow')
    publish(calm)
    await waitFor(() => expect(screen.queryByRole('button', { name: /Main is slow/ })).toBeNull())
  })

  it('opens the numbers and the minute\'s chart, and Escape or a press outside closes them', async () => {
    const user = userEvent.setup()
    const { bridge } = activity(frozen)
    render(app(true, <><MainFreezeNotice bridge={bridge} /><button type="button">Elsewhere</button></>))
    const pill = await screen.findByRole('button', { name: /Main is slow/ })
    await user.click(pill)
    const dialog = screen.getByRole('dialog', { name: 'Main process' })
    expect(within(dialog).getByRole('heading', { name: 'Sotto\'s main process is slow' })).toHaveFocus()
    expect(dialog).toHaveTextContent('It was blocked 70% of the last minute. The longest freeze was 1.9 s.')
    expect(within(dialog).getByRole('img', { name: 'Main was blocked 70% of the last minute; the longest freeze was 1.9 s.' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('23freezes over 100 ms')
    expect(dialog).toHaveTextContent('nothing leaves this computer')
    expect(pill).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pill).toHaveFocus()
    await user.click(pill)
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes when Tab leaves it, and answers Escape wherever focus went', async () => {
    const user = userEvent.setup()
    const { bridge } = activity(frozen)
    render(app(true, <><MainFreezeNotice bridge={bridge} /><button type="button">Elsewhere</button></>))
    const pill = await screen.findByRole('button', { name: /Main is slow/ })
    await user.click(pill)
    const dialog = screen.getByRole('dialog', { name: 'Main process' })
    // Tab through the popover's controls and out past its last one.
    const controls = within(dialog).getAllByRole('button')
    for (let step = 0; step <= controls.length; step += 1) await user.tab()
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()

    // Focus lost to nothing leaves the popover open, and Escape on the page still closes it.
    await user.click(pill)
    expect(screen.getByRole('dialog', { name: 'Main process' })).toBeInTheDocument()
    act(() => { (document.activeElement as HTMLElement).blur() })
    expect(document.body).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Main process' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(pill).toHaveFocus()
  })

  it('Not now asks main to hide the notice until the next freeze', async () => {
    const user = userEvent.setup()
    const { bridge, command } = activity(frozen, (request, current) => request.type === 'not-now' ? { ...current, noticeHidden: true } : current)
    render(app(true, <MainFreezeNotice bridge={bridge} />))
    await user.click(await screen.findByRole('button', { name: /Main is slow/ }))
    await user.click(screen.getByRole('button', { name: 'Not now: hide this until main recovers and freezes again' }))
    expect(command).toHaveBeenCalledWith({ type: 'not-now' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays away while main is frozen when Settings turned it off, and still shows a running recording', async () => {
    const { bridge, publish } = activity(frozen)
    render(app(true, <MainFreezeNotice bridge={bridge} />, { mainFreezeNotice: false }))
    await act(async () => undefined)
    await waitFor(() => expect(bridge.read).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /Main is slow/ })).toBeNull()
    publish({ ...frozen, recording: { phase: 'recording', startedAt: Date.now(), durationMs: 60_000 } })
    expect(await screen.findByRole('button', { name: /Recording a minute, \d+ seconds left/ })).toHaveTextContent(/Recording, \d+ s/)
  })

  it('Record a minute counts down, then offers the saved recording to a new thread', async () => {
    const user = userEvent.setup()
    const { bridge, command, publish } = activity(frozen, (request, current) => request.type === 'record'
      ? { ...current, recording: { phase: 'recording', startedAt: Date.now(), durationMs: 60_000 } } : current)
    render(app(true, <MainFreezeNotice bridge={bridge} />))
    await user.click(await screen.findByRole('button', { name: /Main is slow/ }))
    await user.click(screen.getByRole('button', { name: 'Record a minute' }))
    expect(command).toHaveBeenCalledWith({ type: 'record' })
    const dialog = await screen.findByRole('dialog', { name: 'Main process' })
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Recording a minute' })).toBeInTheDocument())
    expect(within(dialog).getByRole('progressbar', { name: 'Recording' })).toBeInTheDocument()
    publish(saved)
    await waitFor(() => expect(within(dialog).getByRole('heading', { name: 'Activity recording saved' })).toBeInTheDocument())
    expect(dialog).toHaveTextContent('3 files, 3.4 MB')
    await user.click(within(dialog).getByRole('button', { name: 'Show in folder' }))
    expect(command).toHaveBeenLastCalledWith({ type: 'show-in-folder' })
    await user.click(within(dialog).getByRole('button', { name: 'Attach to a thread' }))
    const intent = takeNewThreadIntent()
    expect(intent?.carried?.text).toContain(saved.recording.phase === 'saved' ? saved.recording.folder : '')
    expect(intent?.carried?.text).toContain('main.cpuprofile, window.cpuprofile, summary.json')
    expect(intent?.carried?.attachments).toEqual([])
  })
})

describe('Settings > Performance', () => {
  it('shows the numbers, records, and turns the notice off', async () => {
    const user = userEvent.setup()
    const save = vi.fn(async () => true)
    const { bridge, command } = activity(calm)
    render(app(true, <PerformanceSettings visible bridge={bridge} settings={DEFAULT_SETTINGS} onUpdateSettings={save} />))
    expect(await screen.findByText('Main is keeping up. It was blocked 3% of the last minute, and the longest freeze was 90 ms.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Record a minute' }))
    expect(command).toHaveBeenCalledWith({ type: 'record' })
    const toggle = screen.getByRole('switch', { name: 'Tell me when main freezes' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    await user.click(toggle)
    expect(save).toHaveBeenCalledWith({ mainFreezeNotice: false })
  })

  it('reads the numbers once a second only while it shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { bridge } = activity(calm)
      const { rerender } = render(<PerformanceSettings visible={false} bridge={bridge} settings={DEFAULT_SETTINGS} onUpdateSettings={async () => true} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(bridge.read).toHaveBeenCalledTimes(1)
      rerender(<PerformanceSettings visible bridge={bridge} settings={DEFAULT_SETTINGS} onUpdateSettings={async () => true} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
      expect(vi.mocked(bridge.read).mock.calls.length).toBeGreaterThanOrEqual(4)
    } finally { vi.useRealTimers() }
  })
})
