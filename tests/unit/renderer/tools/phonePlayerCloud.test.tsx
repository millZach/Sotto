import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserEvent } from '../../../../src/shared/browser'
import type { CloudEvent, CloudIphoneBridge, CloudSession } from '../../../../src/shared/cloudIphone'
import type { ToolsResult } from '../../../../src/shared/tools'
import { PhonePlayer } from '../../../../src/renderer/src/tools/PhonePlayer'
import { CloudIphoneStore } from '../../../../src/renderer/src/tools/cloudIphoneStore'
import { PhonePlayerStore } from '../../../../src/renderer/src/tools/phonePlayerStore'
import { ToolsPanelStore } from '../../../../src/renderer/src/tools/toolsPanelStore'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function fakeEmptyBrowser(): BrowserBridge {
  const listeners = new Set<(event: BrowserEvent) => void>()
  return {
    tasks: vi.fn(async () => ok([])), list: vi.fn(async () => ok({ workspace: { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:/work', workspaceId: 'workspace' }, pages: [] })),
    create: vi.fn(), navigate: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(), close: vi.fn(), mount: vi.fn(async () => ok(undefined)),
    share: vi.fn(), viewport: vi.fn(), capture: vi.fn(),
    controlTask: vi.fn(), answerAction: vi.fn(), stopGrant: vi.fn(async () => ok(undefined)), openLink: vi.fn(),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
}

const session = (patch: Partial<CloudSession> = {}): CloudSession => ({
  id: '11111111-1111-4111-8111-111111111111', threadId: 'visual-gate', workspaceId: 'workspace',
  status: 'active', description: 'Checking the Needs you list', buildPath: 'apps/ios/build/Sotto.app.zip', buildBytes: 41_000_000,
  device: 'iPhone 16 · iOS 18', expiresAt: null, startedAt: Date.now(), endedAt: null, endReason: null, minutes: 3,
  problem: null, steps: [{ id: 'step-1', action: 'tap', status: 'completed', at: Date.now(), detail: 'Tapped Needs you' }], summary: null, unchecked: [],
  ...patch,
})

function fakeCloudBridge(initial: CloudSession[]) {
  const listeners = new Set<(event: CloudEvent) => void>()
  const bridge: CloudIphoneBridge = {
    status: vi.fn(async () => ok({ keySaved: true, month: '2026-10', monthMinutes: 38, capMinutes: 750, recent: [] })),
    setKey: vi.fn(), sessions: vi.fn(async () => ok(initial)),
    answer: vi.fn(), end: vi.fn(async ({ sessionId }) => ok(session({ id: sessionId, status: 'ended', endReason: 'user' }))),
    mount: vi.fn(async () => ok(undefined)),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: CloudEvent) => { for (const listener of [...listeners]) listener(event) } }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('the phone player’s cloud iPhone mode', () => {
  it('shows the cloud iPhone over the test iPhone once a session is active, and mounts it', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 800, y: 300, width: 240, height: 520 }))
    const browser = fakeEmptyBrowser()
    const cloud = fakeCloudBridge([session()])
    const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore(); const cloudStore = new CloudIphoneStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser} store={store} phoneStore={phoneStore} cloudStore={cloudStore} cloudBridge={cloud.bridge} />)
    const player = await screen.findByRole('complementary', { name: 'Cloud iPhone for Visual gate flake' })
    expect(player).toBeInTheDocument()
    expect(screen.getByText('iPhone · cloud')).toBeInTheDocument()
    expect(screen.getByText('3 min')).toBeInTheDocument()
    expect(screen.getByText('Tapped Needs you')).toBeInTheDocument()
    await waitFor(() => expect(cloud.bridge.mount).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session().id, bounds: { x: 800, y: 300, width: 240, height: 520 } })))
  })

  it('ends the session from the status line', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 800, y: 300, width: 240, height: 520 }))
    const browser = fakeEmptyBrowser()
    const cloud = fakeCloudBridge([session()])
    const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore(); const cloudStore = new CloudIphoneStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser} store={store} phoneStore={phoneStore} cloudStore={cloudStore} cloudBridge={cloud.bridge} />)
    await screen.findByRole('complementary', { name: 'Cloud iPhone for Visual gate flake' })
    fireEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(cloud.bridge.end).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session().id })))
  })

  it('keeps the test iPhone unchanged when there is no cloud session', async () => {
    const cloud = fakeCloudBridge([])
    const browser = fakeEmptyBrowser()
    const store = new ToolsPanelStore(); const phoneStore = new PhonePlayerStore(); const cloudStore = new CloudIphoneStore()
    render(<PhonePlayer state={threadsStateFixture()} focusedThreadId="visual-gate" bridge={browser} store={store} phoneStore={phoneStore} cloudStore={cloudStore} cloudBridge={cloud.bridge} />)
    act(() => phoneStore.show('visual-gate'))
    await waitFor(() => expect(cloud.bridge.sessions).toHaveBeenCalled())
    expect(screen.queryByRole('complementary', { name: /iPhone/ })).not.toBeInTheDocument()
  })
})
