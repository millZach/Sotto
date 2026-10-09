/**
 * An interactive visual in the transcript (ADR-0060): the card asks main for a one-time page address by thread and
 * visual, never sends the page, runs at most three pages at once and only near the view, sizes the page to the height
 * the guest measured, and gives focus back to the card on Escape. The guest itself is Electron's; here it is the bare
 * `<webview>` element jsdom makes.
 */
import React from 'react'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentVisual } from '../../../src/shared/visuals'
import type { VisualPageRequest, VisualPageResult } from '../../../src/shared/visualPages'
import { VisualCard } from '../../../src/renderer/src/agents/VisualCard'
import { visualThemeFrom } from '../../../src/renderer/src/agents/InteractiveVisual'
import { pageFallbackHint } from '../../../src/renderer/src/agents/InteractiveVisualCard'
import { LIVE_PAGES_MAX } from '../../../src/renderer/src/agents/visualPageSlots'
import { hostClientBridge } from '../../../src/preload/hostClientBridge'
import { EMPTY_AGENT_HOST, defaultAgentConfiguration, type AgentState } from '../../../src/shared/agents'

const page = (id: string, title = `Page ${id}`): AgentVisual => ({ id, title, kind: 'interactive', source: '<h1>Mine</h1><script>1</script>',
  intro: 'It fills.', steps: [{ text: 'One.' }, { text: 'Two.' }] })

// Every observed card is near the view unless a test moves it away.
const observed = new Map<Element, (entries: { isIntersecting: boolean }[]) => void>()
const roots: (Element | null | undefined)[] = []
class FakeIntersectionObserver {
  constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void, options?: { root?: Element | null }) { roots.push(options?.root) }
  observe(element: Element): void { observed.set(element, this.callback); this.callback([{ isIntersecting: true }]) }
  disconnect(): void { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element) }
}
const away = (element: Element): void => { act(() => observed.get(element)?.([{ isIntersecting: false }])) }

let opens: VisualPageRequest[] = []
let answer: (request: VisualPageRequest) => VisualPageResult = request => ({ ok: true, url: `sotto-visual://page/${request.visualId.padEnd(43, 'x')}` })
beforeEach(() => {
  opens = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  Object.assign(window, { sotto: { visuals: { open: vi.fn(async (request: VisualPageRequest) => { opens.push(request); return answer(request) }) } } })
})
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); observed.clear(); roots.length = 0; delete (window as { sotto?: unknown }).sotto
  answer = request => ({ ok: true, url: `sotto-visual://page/${request.visualId.padEnd(43, 'x')}` })
})

describe('an interactive visual\'s card', () => {
  it('has the diagram card\'s header and explanation, and asks main for the page by thread and visual', async () => {
    render(<VisualCard visual={page('v1', 'A queue')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: A queue' })
    expect(within(card).getByText('Interactive page')).toBeInTheDocument()
    for (const name of ['Read all', 'Show source', 'Copy source', 'Expand A queue']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
    expect(within(card).getByText('Step 1 of 2')).toBeInTheDocument()
    expect(within(card).getByText('One.')).toBeInTheDocument()
    const guest = await vi.waitFor(() => { const element = card.querySelector('webview'); if (!element) throw new Error('no guest'); return element })
    expect(guest.getAttribute('src')).toBe(`sotto-visual://page/${'v1'.padEnd(43, 'x')}`)
    expect(guest.getAttribute('partition')).toBe('sotto-visual')
    expect(guest).toHaveAttribute('aria-label', 'A queue, interactive page')
    expect(guest.hasAttribute('allowpopups')).toBe(false)
    expect(guest.hasAttribute('nodeintegration')).toBe(false)
    expect(opens).toHaveLength(1)
    expect(Object.keys(opens[0]!).sort()).toEqual(['theme', 'threadId', 'visualId'])
    expect(opens[0]).toMatchObject({ threadId: 'thread-1', visualId: 'v1' })
    expect(JSON.stringify(opens[0])).not.toContain('Mine')
  })

  it('runs at most three pages at once, says so on a fourth in view, and starts the next when one moves away', async () => {
    const { container } = render(<>{['a', 'b', 'c', 'd'].map(id => <VisualCard key={id} visual={page(id)} threadId="thread-1" />)}</>)
    await vi.waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX))
    const fourth = screen.getByRole('region', { name: 'Visual: Page d' })
    expect(within(fourth).getByText('Three other pages are running, the most Sotto runs at once. Its steps are below.')).toBeInTheDocument()
    expect(within(fourth).getByRole('button', { name: 'Run this page' })).toBeInTheDocument()
    away(screen.getByRole('region', { name: 'Visual: Page a' }).querySelector('.interactive-visual')!)
    await vi.waitFor(() => expect(fourth.querySelector('webview')).not.toBeNull())
    expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX)
  })

  it('runs a crowded page on request, stopping the page that came into view first', async () => {
    const { container } = render(<>{['a', 'b', 'c', 'd'].map(id => <VisualCard key={id} visual={page(id)} threadId="thread-1" />)}</>)
    await vi.waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX))
    const fourth = screen.getByRole('region', { name: 'Visual: Page d' })
    act(() => { within(fourth).getByRole('button', { name: 'Run this page' }).click() })
    await vi.waitFor(() => expect(fourth.querySelector('webview')).not.toBeNull())
    expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX)
    expect(screen.getByRole('region', { name: 'Visual: Page a' }).querySelector('webview')).toBeNull()
  })

  it('says a page that failed to load or stopped can be tried again, and asks main for a new address when it is', async () => {
    render(<VisualCard visual={page('v1', 'A queue')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: A queue' })
    const guest = async (): Promise<HTMLElement> => vi.waitFor(() => { const element = card.querySelector('webview'); if (!element) throw new Error('no guest'); return element as HTMLElement })
    act(() => { void guest().then(element => element.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, errorCode: -20 }))) })
    expect(await within(card).findByText('The page could not be loaded. Try again to start it from the top. Its steps are below.')).toBeInTheDocument()
    expect(opens).toHaveLength(1)
    act(() => { within(card).getByRole('button', { name: 'Try again' }).click() })
    const second = await guest()
    expect(opens).toHaveLength(2)
    act(() => { second.dispatchEvent(new Event('render-process-gone')) })
    expect(await within(card).findByText('The page stopped. Try again to start it from the top. Its steps are below.')).toBeInTheDocument()
    act(() => { within(card).getByRole('button', { name: 'Try again' }).click() })
    const third = await guest()
    expect(opens).toHaveLength(3)
    // An address main no longer holds is answered with Not found, which commits as a page rather than failing.
    act(() => { third.dispatchEvent(Object.assign(new Event('did-navigate'), { httpResponseCode: 404 })) })
    expect(await within(card).findByText('The page could not be loaded. Try again to start it from the top. Its steps are below.')).toBeInTheDocument()
  })

  it('takes the height the guest measured, held between 160 and 640 pixels', async () => {
    render(<VisualCard visual={page('v1')} threadId="thread-1" />)
    const guest = await vi.waitFor(() => { const element = document.querySelector('webview'); if (!element) throw new Error('no guest'); return element })
    const frame = guest.parentElement!
    expect(frame.style.height).toBe('160px')
    const measured = (height: unknown): void => { act(() => { guest.dispatchEvent(Object.assign(new Event('ipc-message'), { channel: 'sotto-visual:height', args: [height] })) }) }
    measured(300); expect(frame.style.height).toBe('300px')
    measured(5_000); expect(frame.style.height).toBe('640px')
    measured(12); expect(frame.style.height).toBe('160px')
    measured('tall'); expect(frame.style.height).toBe('160px')
  })

  it('sends the theme and the walkthrough\'s first step once the page is ready, and gives focus back to the card on Escape', async () => {
    render(<VisualCard visual={page('v1', 'A queue')} threadId="thread-1" />)
    const guest = await vi.waitFor(() => { const element = document.querySelector('webview'); if (!element) throw new Error('no guest'); return element }) as HTMLElement & { send: ReturnType<typeof vi.fn> }
    guest.send = vi.fn(async () => undefined)
    act(() => { guest.dispatchEvent(new Event('dom-ready')) })
    await vi.waitFor(() => expect(guest.send).toHaveBeenCalledTimes(2))
    expect(guest.send).toHaveBeenCalledWith('sotto-visual:theme', expect.objectContaining({ mode: expect.stringMatching(/^(light|dark)$/u), reducedMotion: expect.any(Boolean) }))
    expect(guest.send).toHaveBeenCalledWith('sotto-visual:step', { step: 1, total: 2, highlight: [] })
    act(() => { guest.dispatchEvent(Object.assign(new Event('ipc-message'), { channel: 'sotto-visual:escape', args: [] })) })
    expect(screen.getByRole('region', { name: 'Visual: A queue' })).toHaveFocus()
  })

  it('shows main\'s reason in place of the page when it cannot be shown, with the steps still there', async () => {
    answer = () => ({ ok: false, reason: 'Sotto no longer has this page, so it is not shown.' })
    render(<VisualCard visual={page('v1', 'A queue')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: A queue' })
    expect(await within(card).findByText('Sotto no longer has this page, so it is not shown. Its steps are below.')).toBeInTheDocument()
    expect(card.querySelector('webview')).toBeNull()
    expect(within(card).getByText('One.')).toBeInTheDocument()
  })
})

describe('the walkthrough on an interactive page (#793)', () => {
  const stepped = (id: string): AgentVisual => ({ id, title: `Walk ${id}`, kind: 'interactive', source: '<p>Mine</p>', intro: 'It fills.',
    steps: [{ text: 'It grows.', highlight: ['queue', 'A->B'] }, { text: 'It drains.' }] })
  const stepMessages = (send: ReturnType<typeof vi.fn>): unknown[] => send.mock.calls.filter(call => call[0] === 'sotto-visual:step').map(call => call[1])

  it('shows the stepper and Read all, and sends each step with its names on Next, Back, Start over and Read all', async () => {
    render(<VisualCard visual={stepped('w1')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: Walk w1' })
    const guest = await vi.waitFor(() => { const element = card.querySelector('webview'); if (!element) throw new Error('no guest'); return element }) as HTMLElement & { send: ReturnType<typeof vi.fn> }
    guest.send = vi.fn(async () => undefined)
    act(() => { guest.dispatchEvent(new Event('dom-ready')) })
    await vi.waitFor(() => expect(stepMessages(guest.send)).toEqual([{ step: 1, total: 2, highlight: ['queue', 'A->B'] }]))
    expect(within(card).getByText('Step 1 of 2')).toBeInTheDocument()
    expect(within(card).getByText('It grows.')).toBeInTheDocument()

    act(() => { within(card).getByRole('button', { name: 'Next' }).click() })
    await vi.waitFor(() => expect(stepMessages(guest.send).at(-1)).toEqual({ step: 2, total: 2, highlight: [] }))
    act(() => { within(card).getByRole('button', { name: 'Back' }).click() })
    await vi.waitFor(() => expect(stepMessages(guest.send).at(-1)).toEqual({ step: 1, total: 2, highlight: ['queue', 'A->B'] }))
    act(() => { within(card).getByRole('button', { name: 'Next' }).click() })
    act(() => { within(card).getByRole('button', { name: 'Start over' }).click() })
    await vi.waitFor(() => expect(stepMessages(guest.send).at(-1)).toEqual({ step: 1, total: 2, highlight: ['queue', 'A->B'] }))

    act(() => { within(card).getByRole('button', { name: 'Read all' }).click() })
    await vi.waitFor(() => expect(stepMessages(guest.send).at(-1)).toEqual({ step: 0, total: 2, highlight: [] }))
    expect(within(card).getByRole('button', { name: 'Step through' })).toBeInTheDocument()
    expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['It grows.', 'It drains.'])
  })

  it('sends the current step again once the page has finished loading', async () => {
    render(<VisualCard visual={stepped('w2')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: Walk w2' })
    const guest = await vi.waitFor(() => { const element = card.querySelector('webview'); if (!element) throw new Error('no guest'); return element }) as HTMLElement & { send: ReturnType<typeof vi.fn> }
    guest.send = vi.fn(async () => undefined)
    act(() => { guest.dispatchEvent(new Event('dom-ready')) })
    act(() => { within(card).getByRole('button', { name: 'Next' }).click() })
    await vi.waitFor(() => expect(stepMessages(guest.send).at(-1)).toEqual({ step: 2, total: 2, highlight: [] }))
    guest.send.mockClear()
    act(() => { guest.dispatchEvent(new Event('did-finish-load')) })
    expect(stepMessages(guest.send)).toEqual([{ step: 2, total: 2, highlight: [] }])
  })

  it('keeps the place per visual when the card is drawn again', async () => {
    const first = render(<VisualCard visual={stepped('w3')} threadId="thread-1" />)
    act(() => { within(screen.getByRole('region', { name: 'Visual: Walk w3' })).getByRole('button', { name: 'Next' }).click() })
    first.unmount()
    render(<VisualCard visual={stepped('w3')} threadId="thread-1" />)
    expect(within(screen.getByRole('region', { name: 'Visual: Walk w3' })).getByText('Step 2 of 2')).toBeInTheDocument()
  })
})

describe('a card whose page cannot run', () => {
  const HERE = '11111111-1111-4111-8111-111111111111'
  const THERE = '22222222-2222-4222-8222-222222222222'
  const ON_ANOTHER_COMPUTER = 'This page belongs to a thread on another computer, so it is not shown here.'
  const routedState = (): AgentState => ({ configuration: defaultAgentConfiguration(), connection: 'connected', host: { ...EMPTY_AGENT_HOST, hostId: HERE },
    assignments: [], queue: [], activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, draftRequestId: null, composing: false, pendingRequest: '',
    globalLaneBusy: false, notice: '', error: null,
    credentials: { reasoning: false, secure: false }, reasoningAccounts: [], hostId: HERE, clientScoped: true,
    connections: [{ hostId: HERE, name: 'This computer', kind: 'local', connected: true }, { hostId: THERE, name: 'Forge', kind: 'remote', connected: true }] })

  it('keeps the transcript, and says a paired host\'s page is on another computer, through the window\'s real bridge', async () => {
    const state = routedState()
    const raw = { agents: { get: vi.fn(async () => state) },
      // Main's own answer for a paired host's thread.
      visuals: { open: vi.fn(async (request: VisualPageRequest) => request.threadId.startsWith(`host:${THERE}:`) ? { ok: false as const, reason: ON_ANOTHER_COMPUTER } : answer(request)) } }
    const bridge = hostClientBridge(raw)
    await bridge.agents.get()
    Object.assign(window, { sotto: bridge })
    render(<div><p>Earlier words in the thread.</p><VisualCard visual={page('v1', 'On Forge')} threadId={`host:${THERE}:t1`} /></div>)
    const card = screen.getByRole('region', { name: 'Visual: On Forge' })
    expect(await within(card).findByText(`${ON_ANOTHER_COMPUTER} Its steps are below.`)).toBeInTheDocument()
    expect(raw.visuals.open).toHaveBeenCalledWith(expect.objectContaining({ threadId: `host:${THERE}:t1` }))
    expect(screen.getByText('Earlier words in the thread.')).toBeInTheDocument()
  })

  it('keeps the window when the bridge refuses by throwing at once', async () => {
    Object.assign(window, { sotto: { visuals: { open: () => { throw new Error('This action belongs to another host.') } } } })
    render(<div><p>Earlier words in the thread.</p><VisualCard visual={page('v1', 'Thrown')} threadId="thread-1" /></div>)
    const card = screen.getByRole('region', { name: 'Visual: Thrown' })
    expect(await within(card).findByText('Sotto could not open the page. Try again to start it from the top. Its steps are below.')).toBeInTheDocument()
    expect(screen.getByText('Earlier words in the thread.')).toBeInTheDocument()
  })

  it('offers Try again for a refusal that may pass', async () => {
    answer = () => ({ ok: false, reason: 'Sotto could not seal this page from the network, so it is not shown.', retry: true })
    render(<VisualCard visual={page('v1', 'Unsealed')} threadId="thread-1" />)
    const card = screen.getByRole('region', { name: 'Visual: Unsealed' })
    expect(await within(card).findByText(/^Sotto could not seal this page from the network, so it is not shown\. Try again/u)).toBeInTheDocument()
    answer = request => ({ ok: true, url: `sotto-visual://page/${request.visualId.padEnd(43, 'x')}` })
    act(() => { within(card).getByRole('button', { name: 'Try again' }).click() })
    await vi.waitFor(() => expect(card.querySelector('webview')).not.toBeNull())
  })

  it('offers Try again, and frees its running page, when main refuses to attach the guest', async () => {
    const { container } = render(<>{['a', 'b', 'c', 'd'].map(id => <VisualCard key={id} visual={page(id)} threadId="thread-1" />)}</>)
    await vi.waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX))
    const first = screen.getByRole('region', { name: 'Visual: Page a' })
    act(() => { first.querySelector('webview')!.dispatchEvent(new Event('destroyed')) })
    expect(await within(first).findByText('The page could not be started. Try again to start it from the top. Its steps are below.')).toBeInTheDocument()
    // The fourth card takes the running page the first gave up.
    await vi.waitFor(() => expect(screen.getByRole('region', { name: 'Visual: Page d' }).querySelector('webview')).not.toBeNull())
  })

  it('does not count cards that hold no page among the running pages', async () => {
    answer = () => ({ ok: false, reason: 'Sotto no longer has this page, so it is not shown.' })
    render(<>{['a', 'b', 'c', 'd'].map(id => <VisualCard key={id} visual={page(id)} threadId="thread-1" />)}</>)
    await vi.waitFor(() => expect(screen.getAllByText('Sotto no longer has this page, so it is not shown. Its steps are below.')).toHaveLength(4))
    expect(screen.queryByText(/Three other pages are running/u)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Run this page' })).toBeNull()
  })
})

describe('where a page that is not shown points the reader', () => {
  it('names what the visual has besides the page', () => {
    expect(pageFallbackHint({ intro: 'It fills.', steps: [{ text: 'One.' }] })).toBe('Its steps are below.')
    expect(pageFallbackHint({ intro: 'It fills.' })).toBe('What it shows is described below.')
    expect(pageFallbackHint({})).toBe('Show source shows its HTML.')
  })
})

describe('which pages run', () => {
  it('watches a card against the transcript that scrolls it, not the window', async () => {
    render(<div data-testid="scroller" style={{ overflowY: 'auto' }}><div><VisualCard visual={page('v1')} threadId="thread-1" /></div></div>)
    expect(roots).toContain(screen.getByTestId('scroller'))
  })

  it('runs an expanded page even when three pages already run, counting it among the three', async () => {
    const { container } = render(<>{['a', 'b', 'c', 'd'].map(id => <VisualCard key={id} visual={page(id)} threadId="thread-1" />)}</>)
    await vi.waitFor(() => expect(container.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX))
    const fourth = screen.getByRole('region', { name: 'Visual: Page d' })
    expect(fourth.querySelector('webview')).toBeNull()
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', '') }
    act(() => { within(fourth).getByRole('button', { name: 'Expand Page d' }).click() })
    const viewer = await screen.findByRole('dialog', { name: 'Interactive page: Page d' })
    await vi.waitFor(() => expect(viewer.querySelector('webview')).not.toBeNull())
    expect(within(viewer).queryByText('The page starts when it is in view.')).toBeNull()
    expect(document.querySelectorAll('webview')).toHaveLength(LIVE_PAGES_MAX)
  })
})

describe('the theme a page is given', () => {
  it('is the diagram palette under the names agents are told, every colour six-digit hex', () => {
    const theme = visualThemeFrom({ dark: true, text: '#FFF', muted: '#a5aab3', line: '#a5aab3', node: '#333b45', nodeBorder: '#848e9b', group: '#324e66', note: '#2c3d4e', block: '#252e38', accent: '#70b9ee' }, true)
    expect(theme).toEqual({ mode: 'dark', reducedMotion: true, tokens: { '--sotto-text': '#ffffff', '--sotto-muted': '#a5aab3', '--sotto-line': '#a5aab3', '--sotto-background': '#252e38',
      '--sotto-surface': '#333b45', '--sotto-border': '#848e9b', '--sotto-group-fill': '#324e66', '--sotto-note-fill': '#2c3d4e', '--sotto-accent': '#70b9ee' } })
  })
})
