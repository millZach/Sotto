import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PopupApp } from '../../../../src/renderer/src/popup/PopupApp'
import { readPopupMemory, writePopupMemory, type PopupTarget } from '../../../../src/renderer/src/popup/popupLogic'
import type { AgentThread } from '../../../../src/shared/agents'
import type { PopupBridge } from '../../../../src/shared/popup'
import { DEFAULT_SETTINGS } from '../../../../src/shared/settings'
import { agentThread, threadsStateFixture } from '../../../fixtures/agentState'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function setup({ thread = agentThread(), target = 'thread' }: { thread?: AgentThread; target?: PopupTarget } = {}) {
  const state = threadsStateFixture({ projects: [{ id: thread.projectId }], threads: [thread] })
  writePopupMemory(localStorage, { target, threadId: thread.id, projectId: thread.projectId })
  let shown = (): void => undefined
  let pushed: (thread: AgentThread) => void = () => undefined
  const bridge = {
    platform: 'darwin',
    getSettings: async () => DEFAULT_SETTINGS,
    onSettingsChanged: () => () => undefined,
    shell: vi.fn(async () => state),
    watcher: vi.fn(async () => ({ status: 'ok' as const, state: {
      current: null, currentOptions: null, history: [], requests: [], watchedThreads: [], receipts: [],
      recoveryNotice: null, observedAt: '2026-11-03T00:00:00.000Z',
    } })),
    threadDetail: vi.fn(async () => ({ threadId: thread.id, revision: 1, messages: [], activities: [] })),
    onThreadDetail: () => () => undefined,
    onThread: (listener: (thread: AgentThread) => void) => { pushed = listener; return () => undefined },
    command: vi.fn<PopupBridge['command']>(async () => ({ ...state, host: {
      ...state.host, models: { revision: 1, omitted: true }, clientHosts: [],
    } })),
    openExternalLink: async () => ({ ok: true }),
    hide: vi.fn(async () => undefined),
    fit: async () => undefined,
    open: async () => undefined,
    onShown: (listener: () => void) => { shown = listener; return () => undefined },
  } satisfies PopupBridge
  const view = render(<PopupApp bridge={bridge} />)
  await screen.findByRole('textbox', { name: `Message ${thread.title}` })
  return { bridge, view, thread, show: () => shown(), push: (next: AgentThread) => pushed(next) }
}

const lastTurn = { id: 'turn', status: 'running' as const }

describe('the popup regressions from #2061 (ADR-0181)', () => {
  it('shows Working and a Stop button when an idle thread still reports its last turn running', async () => {
    const { bridge, thread } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    expect(screen.getByRole('status')).toHaveTextContent('Working…')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop the running turn' })) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: thread.id })
    expect(bridge.hide).not.toHaveBeenCalled()
  })

  it('stops on Escape while the last turn runs, then hides once that turn completes', async () => {
    const { bridge, thread, push } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    const prompt = screen.getByRole('textbox')
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Escape' }) })
    expect(bridge.command).toHaveBeenCalledWith({ type: 'interrupt', threadId: thread.id })
    expect(bridge.hide).not.toHaveBeenCalled()

    await act(async () => { push({ ...thread, lastTurn: { ...lastTurn, status: 'completed' } }) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop the running turn' })).not.toBeInTheDocument()
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Escape' }) })
    expect(bridge.hide).toHaveBeenCalledOnce()
  })

  it('queues a prompt behind the last running turn, then sends normally after it completes', async () => {
    const { bridge, thread, push } = await setup({ thread: agentThread({ status: 'idle', lastTurn }) })
    const prompt = screen.getByRole('textbox')
    fireEvent.change(prompt, { target: { value: 'Do this next' } })
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
    expect(bridge.command).toHaveBeenCalledWith({
      type: 'queue-followup', threadId: thread.id, draftId: expect.any(String), text: 'Do this next',
    })
    expect(bridge.command.mock.calls.some(([command]) => command.type === 'manual-send')).toBe(false)

    await act(async () => { push({ ...thread, lastTurn: { ...lastTurn, status: 'completed' } }) })
    fireEvent.change(prompt, { target: { value: 'Do this now' } })
    await act(async () => { fireEvent.keyDown(prompt, { key: 'Enter' }) })
    expect(bridge.command).toHaveBeenCalledWith({
      type: 'manual-send', threadId: thread.id, draftId: expect.any(String), text: 'Do this now',
    })
  })

  it('says Watcher is not running once and keeps the thread target across shows and a remount', async () => {
    const { bridge, view, thread, show } = await setup({ target: 'watcher' })
    expect(screen.getByRole('alert')).toHaveTextContent('Watcher isn’t running, so the popup is on your thread.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () => { show() })
    expect(bridge.shell).toHaveBeenCalledTimes(2)
    expect(bridge.watcher).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(readPopupMemory(localStorage)).toEqual({ target: 'thread', threadId: thread.id, projectId: thread.projectId })

    view.unmount()
    await act(async () => { render(<PopupApp bridge={bridge} />) })
    expect(bridge.shell).toHaveBeenCalledTimes(3)
    expect(bridge.watcher).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('textbox', { name: `Message ${thread.title}` })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
