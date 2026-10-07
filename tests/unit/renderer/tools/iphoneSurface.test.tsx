import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserBridge, BrowserEvent, BrowserPage } from '../../../../src/shared/browser'
import { TEST_IPHONE } from '../../../../src/shared/browser'
import type { ToolsResult } from '../../../../src/shared/tools'
import { useOptionalAgents } from '../../../../src/renderer/src/agents/AgentContext'
import { IPhoneSurface } from '../../../../src/renderer/src/tools/IPhoneSurface'
import { BrowserStore } from '../../../../src/renderer/src/tools/browserStore'
import { PhonePlayerStore } from '../../../../src/renderer/src/tools/phonePlayerStore'
import { agentContextFixture } from '../../../fixtures/agentContext'
import { threadsStateFixture } from '../liveAgentState'

vi.mock('../../../../src/renderer/src/agents/AgentContext', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/renderer/src/agents/AgentContext')>(), useOptionalAgents: vi.fn(),
}))

const workspace = { threadId: 'visual-gate', projectId: 'workshop', workingDirectory: 'D:\\work\\workshop', workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
const PHONE_PAGE = '11111111-1111-4111-8111-111111111111'
const page = (patch: Partial<BrowserPage> = {}): BrowserPage =>
  ({ id: PHONE_PAGE, workspace, url: 'http://localhost:8081/', title: '', status: 'ready', error: null, canGoBack: false, canGoForward: false, device: 'iphone', ...patch })
const ok = <T,>(value: T): ToolsResult<T> => ({ ok: true, value })

function fakeBrowser(initial: BrowserPage[] = []) {
  let pages = initial
  const listeners = new Set<(event: BrowserEvent) => void>()
  const bridge: BrowserBridge = {
    tasks: vi.fn(async () => ok([])),
    share: vi.fn(async ({ pageId, enabled }) => ok(page({ id: pageId, sharedOrigin: enabled ? 'http://localhost:8081' : null }))),
    viewport: vi.fn(async () => ok(page())),
    capture: vi.fn(async () => ok({ image: '', url: 'http://localhost:8081/', width: 393, height: 852, element: null })),
    controlTask: vi.fn(), answerAction: vi.fn(), stopGrant: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok({ workspace, pages })),
    create: vi.fn(async ({ url, device }) => { const created = page({ url, status: 'loading', device }); pages = [...pages, created]; return ok(created) }),
    navigate: vi.fn(async ({ pageId, url }) => ok(page({ id: pageId, url, canGoBack: true }))),
    back: vi.fn(async ({ pageId }) => ok(page({ id: pageId }))),
    forward: vi.fn(async ({ pageId }) => ok(page({ id: pageId }))),
    reload: vi.fn(async ({ pageId }) => ok(page({ id: pageId }))),
    close: vi.fn(async ({ pageId }) => { pages = pages.filter(item => item.id !== pageId); return ok(undefined) }),
    mount: vi.fn(async () => ok(undefined)),
    openLink: vi.fn(async () => ok({ destination: 'external' as const })),
    onEvent: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }),
  }
  return { bridge, emit: (event: BrowserEvent) => { for (const listener of [...listeners]) listener(event) } }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function setup(bridge: BrowserBridge | undefined, options: { store?: BrowserStore; phoneStore?: PhonePlayerStore; state?: ReturnType<typeof threadsStateFixture> } = {}) {
  const { store = new BrowserStore(), phoneStore = new PhonePlayerStore(), state = threadsStateFixture() } = options
  vi.mocked(useOptionalAgents).mockReturnValue(agentContextFixture(state, vi.fn()))
  if (bridge) await act(async () => { await store.activate(bridge, 'visual-gate') })
  render(<IPhoneSurface threadId="visual-gate" store={store} bridge={bridge} phoneStore={phoneStore} />)
  return { store, phoneStore }
}

describe('the test iPhone surface', () => {
  it('shows the empty state, and loading a web build opens it and shows the phone player', async () => {
    const browser = fakeBrowser([])
    const { phoneStore } = await setup(browser.bridge)
    expect(screen.getByText('No app on the test iPhone')).toBeInTheDocument()
    const address = screen.getByRole('textbox', { name: 'Address of the web build' })
    await userEvent.type(address, 'localhost:8081{Enter}')
    await waitFor(() => expect(browser.bridge.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'http://localhost:8081/', device: 'iphone' })))
    expect(phoneStore.isOpen('visual-gate')).toBe(true)
  })

  it('shows a problem for an invalid address without calling the bridge', async () => {
    const browser = fakeBrowser([])
    await setup(browser.bridge)
    const address = screen.getByRole('textbox', { name: 'Address of the web build' })
    await userEvent.type(address, 'ftp://files{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('The browser opens HTTP and HTTPS pages only.')
    expect(browser.bridge.create).not.toHaveBeenCalled()
  })

  it('navigates the existing app from its address', async () => {
    const browser = fakeBrowser([page()])
    await setup(browser.bridge)
    const address = await screen.findByRole('textbox', { name: 'Address of the web build' })
    expect(address).toHaveValue('http://localhost:8081/')
    await userEvent.clear(address)
    await userEvent.type(address, 'localhost:8081/app{Enter}')
    expect(browser.bridge.navigate).toHaveBeenCalledWith(expect.objectContaining({ pageId: PHONE_PAGE, url: 'http://localhost:8081/app' }))
  })

  it('reloads the app', async () => {
    const browser = fakeBrowser([page()])
    await setup(browser.bridge)
    await userEvent.click(await screen.findByRole('button', { name: 'Reload the test iPhone' }))
    expect(browser.bridge.reload).toHaveBeenCalledWith(expect.objectContaining({ pageId: PHONE_PAGE }))
  })

  it('closes the app and hides the phone player', async () => {
    const browser = fakeBrowser([page()])
    const { phoneStore } = await setup(browser.bridge)
    act(() => phoneStore.show('visual-gate'))
    await userEvent.click(await screen.findByRole('button', { name: 'Close the app on the test iPhone' }))
    await waitFor(() => expect(browser.bridge.close).toHaveBeenCalledWith(expect.objectContaining({ pageId: PHONE_PAGE })))
    expect(phoneStore.isOpen('visual-gate')).toBe(false)
  })

  it('shares the app with the agent and can stop sharing', async () => {
    const browser = fakeBrowser([page()])
    await setup(browser.bridge)
    const share = await screen.findByRole('button', { name: 'Share with agent' })
    await userEvent.click(share)
    await waitFor(() => expect(browser.bridge.share).toHaveBeenCalledWith(expect.objectContaining({ pageId: PHONE_PAGE, enabled: true })))
    const stop = await screen.findByRole('button', { name: 'Stop sharing' })
    await userEvent.click(stop)
    await waitFor(() => expect(browser.bridge.share).toHaveBeenCalledWith(expect.objectContaining({ pageId: PHONE_PAGE, enabled: false })))
  })

  it('shows the grant line, and Stop ends it and returns focus to the address', async () => {
    const browser = fakeBrowser([page()])
    vi.mocked(browser.bridge.list).mockImplementation(async () => ok({ workspace, pages: [page()], grant: { grantedAt: Date.now(), source: 'user' } }))
    await setup(browser.bridge)
    expect(await screen.findByText('This thread uses the browser and test iPhone without asking')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop letting this thread use the browser and test iPhone without asking' }))
    await waitFor(() => expect(browser.bridge.stopGrant).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'visual-gate' })))
    await waitFor(() => expect(screen.queryByText('This thread uses the browser and test iPhone without asking')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Address of the web build' })).toHaveFocus())
  })

  it('says under Runs as that the test iPhone is not iOS', async () => {
    const browser = fakeBrowser([])
    await setup(browser.bridge)
    expect(screen.getByText('Runs as')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`A ${TEST_IPHONE.width} by ${TEST_IPHONE.height} page`))).toBeInTheDocument()
    expect(screen.getByText(/It is not iOS\./)).toBeInTheDocument()
  })

  it('tells a Devin thread it cannot use Sotto browser tools, and offers no Share control', async () => {
    const browser = fakeBrowser([page()])
    const state = threadsStateFixture()
    state.host.threads = state.host.threads.map(thread => thread.id === 'visual-gate' ? { ...thread, providerId: 'devin' as const } : thread)
    await setup(browser.bridge, { state })
    expect(await screen.findByText('This Devin client does not support Sotto browser tools.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share with agent' })).not.toBeInTheDocument()
  })
})
