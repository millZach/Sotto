import { browserBridgeFixture } from '../../../fixtures/renderer/browserBridge'
import { cloudIphoneBridgeFixture, cloudStatus, cloudSession } from '../../../fixtures/renderer/cloudIphoneBridge'
import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge } from '../../../../src/shared/browser'
import type { CloudIphoneBridge, CloudIphoneStatus, CloudSession } from '../../../../src/shared/cloudIphone'
import type { ToolsResult } from '../../../../src/shared/tools'
import { useOptionalAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { IPhoneSurface } from '../../../../src/renderer/src/tools/IPhoneSurface'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { CloudIphoneStore } from '../../../../src/renderer/src/tools/cloudIphoneStore'
import { agentContextFixture } from '../../../fixtures/agentContext'
import { threadsStateFixture } from '../../../fixtures/renderer/liveAgentState'

vi.mock('../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn(),
}))

const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })
const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }

function fakeEmptyBrowser(): BrowserBridge {

  return browserBridgeFixture({ workspace,
    commands: { tasks: vi.fn(async () => ok([])),
    list: vi.fn(async () => ok({ workspace, pages: [] })),
    create: vi.fn(),
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reload: vi.fn(),
    close: vi.fn(),
    mount: vi.fn(async () => ok(undefined)),
    share: vi.fn(),
    viewport: vi.fn(),
    capture: vi.fn(),
    controlTask: vi.fn(),
    answerAction: vi.fn(),
    stopGrant: vi.fn(async () => ok(undefined)),
    openLink: vi.fn() } }).bridge
}

const session = (patch: Partial<CloudSession> = {}): CloudSession => cloudSession({ threadId: 'visual-gate', status: 'active', device: 'iPhone 16 \u00b7 iOS 18', expiresAt: null, startedAt: Date.now(), minutes: 3, ...patch })
const status = cloudStatus

function fakeCloudBridge(initialSessions: CloudSession[], initialStatus: CloudIphoneStatus) {
  const published = cloudIphoneBridgeFixture({ commands: {
    status: vi.fn(async () => ok(initialStatus)), setKey: vi.fn(),
    sessions: vi.fn(async () => ok(initialSessions)),
    answer: vi.fn(), end: vi.fn(async ({ sessionId }) => ok(session({ id: sessionId, status: 'ended' }))),
    mount: vi.fn(async () => ok(undefined)),
  } })
  return published.bridge
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function setup(cloudBridge: CloudIphoneBridge) {
  const browserBridge = fakeEmptyBrowser()
  const store = new BrowserStore(); const cloudStore = new CloudIphoneStore()
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(threadsStateFixture(), vi.fn()))
  await act(async () => { await store.activate(browserBridge, 'visual-gate') })
  render(<IPhoneSurface threadId="visual-gate" store={store} bridge={browserBridge} cloudStore={cloudStore} cloudBridge={cloudBridge} />)
}

describe('Tools > iPhone, the cloud iPhone card', () => {
  it('shows the build, device, this month’s minutes and End session for an active cloud session', async () => {
    const bridge = fakeCloudBridge([session()], status())
    await setup(bridge)
    await screen.findByText('apps/ios/build/Sotto.app.zip')
    expect(screen.getByText(/iPhone 16 · iOS 18/)).toBeInTheDocument()
    expect(screen.getByText('38 of 750 minutes')).toBeInTheDocument()
    expect(screen.getByText(/3 min/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'End session' }))
    await waitFor(() => expect(bridge.end).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session().id })))
  })

  it('points to Settings when no key is saved and no session exists', async () => {
    const bridge = fakeCloudBridge([], status({ keySaved: false }))
    await setup(bridge)
    expect(await screen.findByText(/Add a run\.cloud key in Settings/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeInTheDocument()
  })

  it('shows no cloud card when a key is saved and there is no session', async () => {
    const bridge = fakeCloudBridge([], status({ keySaved: true }))
    await setup(bridge)
    await waitFor(() => expect(bridge.status).toHaveBeenCalled())
    expect(screen.queryByText(/Add a run\.cloud key/)).toBeNull()
    expect(screen.queryByText('Cloud iPhone')).toBeNull()
  })
})
