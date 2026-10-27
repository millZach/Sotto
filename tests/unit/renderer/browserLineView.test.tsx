import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentState, AgentThread } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

// The browser line (ADR-0154) is an Owl feature (ADR-0072); each test says whether this build has it.
const gate = vi.hoisted(() => ({ on: true }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>(),
  useOwlFeature: (id: string) => id === 'quiet-browser' && gate.on,
}))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
// How often the transcript's parts work through their records: a group folding its rows, a live line finding its lines.
const reads = vi.hoisted(() => ({ folds: [] as string[], live: 0 }))
vi.mock('../../../src/renderer/src/agents/browserLine', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/agents/browserLine')>()
  return {
    ...actual,
    foldBrowserRuns: (...args: Parameters<typeof actual.foldBrowserRuns>) => { reads.folds.push(args[0][0]?.record.turnId ?? ''); return actual.foldBrowserRuns(...args) },
    linesStartingIn: (...args: Parameters<typeof actual.linesStartingIn>) => { reads.live++; return actual.linesStartingIn(...args) },
  }
})

const NOW = E2E_THREADS_NOW
// The calls follow the agent's reply, the newest message of the fixture thread.
const THREAD = 'grok-previews'
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
let sequence = 0
const mountedEditors = new Set<PromptEditorElement['editor']>()
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'tool', status: 'completed', title: 'Tool', afterMessageId: `${THREAD}-2`, ...patch })
const browser = (id: string, tool: string, input: unknown, patch: Partial<AgentActivity> = {}): AgentActivity =>
  activity({ id, title: `mcp__sotto_browser__${tool}`, text: JSON.stringify(input), ...patch })
const lifecycle = (status: AgentActivity['status']): AgentActivity =>
  activity({ id: 'lifecycle', kind: 'turn', title: 'Turn', status, startedAt: iso(-65_000), ...status === 'running' ? {} : { completedAt: iso(0) } })

/** An agent checking sign-in: it starts the server, then opens the page, clicks, fails a scroll and clicks again. */
const run = (): AgentActivity[] => [
  activity({ id: 'dev', kind: 'command', title: 'Command', command: 'npm run dev', durationMs: 2_000 }),
  browser('open', 'browser_open', { url: 'http://localhost:5173/', description: 'Check sign-in' }),
  browser('look', 'browser_action', { action: { type: 'inspect' } }),
  browser('scroll', 'browser_action', { action: { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: 400 } }, { status: 'failed', error: 'The browser action did not finish.' }),
  browser('click', 'browser_action', { action: { type: 'click', x: 40, y: 80 } }),
]

function stateWith(patch: Partial<AgentThread>): AgentState {
  const state = threadsStateFixture()
  state.activeThreadId = THREAD
  state.host.connected = true
  Object.assign(state.host.threads.find(item => item.id === THREAD)!, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  for (const field of document.querySelectorAll<PromptEditorElement>('.prompt-editor')) mountedEditors.add(field.editor)
  const publish = (patch: Partial<AgentThread>): void => act(() => {
    live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD ? { ...thread, ...patch } : thread) } })
  })
  const messages = (): AgentThread['messages'] => live.state.host.threads.find(thread => thread.id === THREAD)!.messages
  return { publish, messages, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; gate.on = true; reads.folds.length = 0; reads.live = 0; localStorage.clear(); vi.mocked(useAgents).mockReset() })
afterEach(() => {
  cleanup()
  for (const editor of mountedEditors) if (!editor.isDestroyed) editor.destroy()
  mountedEditors.clear()
})

describe('on Owl, a running turn\'s calls to Sotto\'s browser', () => {
  it('show as one line in the transcript that updates in place, and stay out of the working line\'s steps', () => {
    // A provider keeps each record's place in the order as later ones arrive.
    const reported = [lifecycle('running'), ...run()]
    const { transcript, publish } = mount(stateWith({ status: 'running', activities: reported }))
    const line = within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · clicked in the page' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(transcript.querySelectorAll('.thread-browser')).toHaveLength(1)
    // The dot holds still and says the run is going.
    expect(line.querySelector('.thread-browser__dot')).not.toBeNull()
    // The working line holds the rest of the turn: the one command.
    const working = within(transcript).getByRole('button', { name: 'Working, 1 step so far' })
    fireEvent.click(working)
    const steps = document.getElementById(working.getAttribute('aria-controls')!)!
    expect(within(steps).getByRole('button', { name: 'npm run dev, completed in 2.0s' })).toBeVisible()
    expect(steps.querySelector('.thread-browser')).toBeNull()
    expect(within(steps).queryByText(/sotto browser/iu)).not.toBeInTheDocument()

    // The next call changes the same line's words.
    publish({ activities: [...reported, browser('shot', 'browser_action', { action: { type: 'screenshot' } }, { status: 'running' })] })
    expect(within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · took a picture of the page' })).toBe(line)

    // Once the turn moves on to other work, the line says where it browsed and how many steps it took.
    publish({ activities: [...reported, activity({ id: 'test', kind: 'command', title: 'Command', command: 'npm test', status: 'running', startedAt: iso(-1_000) })] })
    const browsed = within(transcript).getByRole('button', { name: 'Show browser steps: Browsed localhost:5173 · 4 steps, 1 did not finish' })
    expect(browsed.querySelector('.thread-browser__dot')).toBeNull()
  })

  it('open on a press to the steps in plain words, a failed one marked, and fold on Escape with focus on the line', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run()] }))
    const line = within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · clicked in the page' })
    await user.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    expect(line).toHaveAccessibleName('Hide browser steps: Browsing localhost:5173 · clicked in the page')
    const list = document.getElementById(line.getAttribute('aria-controls')!)!
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Opened localhost:5173', 'Looked at the page', 'Could not scroll the page', 'Clicked in the page',
    ])
    expect(within(list).getByText('Could not scroll the page').closest('li')).toHaveAttribute('data-failed')
    expect(within(list).getByText('Clicked in the page').closest('li')).not.toHaveAttribute('data-failed')
    await user.keyboard('{Escape}')
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveFocus()
    expect(document.getElementById(list.id)).toBeNull()
  })

  it('keep the site left to right in its own element, in the line and in its steps (ADR-0123)', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run()] }))
    const line = within(transcript).getByRole('button', { name: /^Show browser steps: Browsing localhost:5173/u })
    const place = line.querySelector('.thread-browser__place')
    expect(place).toHaveAttribute('dir', 'ltr')
    expect(place).toHaveTextContent('localhost:5173')
    fireEvent.click(line)
    const opened = within(document.getElementById(line.getAttribute('aria-controls')!)!).getByText('localhost:5173')
    expect(opened).toHaveAttribute('dir', 'ltr')
    expect(opened.closest('li')).toHaveTextContent('Opened localhost:5173')
  })

  it('say the agent has moved on once it writes a reply after its last call', () => {
    const reported = [lifecycle('running'), ...run()]
    const { transcript, publish, messages } = mount(stateWith({ status: 'running', activities: reported }))
    within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · clicked in the page' })
    publish({ messages: [...messages(), { id: 'after-browsing', role: 'assistant', text: 'Sign-in works.', createdAt: iso(1_000) }] })
    const browsed = within(transcript).getByRole('button', { name: 'Show browser steps: Browsed localhost:5173 · 4 steps, 1 did not finish' })
    expect(browsed.querySelector('.thread-browser__dot')).toBeNull()
  })

  it('stay one line for the turn where its first call happened, as more calls come after a reply and an edit', () => {
    const reported = [lifecycle('running'), ...run()]
    const { transcript, publish, messages } = mount(stateWith({ status: 'running', activities: reported }))
    const line = within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · clicked in the page' })
    publish({
      messages: [...messages(), { id: 'reply', role: 'assistant', text: 'Enter does not send the form. Fixing it.', createdAt: iso(1_000) }],
      activities: [...reported,
        activity({ id: 'fix', kind: 'file-change', title: 'File changes', afterMessageId: 'reply', changes: [{ path: 'src/SignInForm.tsx', kind: 'update' }] }),
        browser('again', 'browser_action', { action: { type: 'key', key: 'Enter' } }, { afterMessageId: 'reply' })],
    })
    expect(transcript.querySelectorAll('.thread-browser')).toHaveLength(1)
    expect(within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · pressed Enter' })).toBe(line)
    // It stays where the first call happened: before the reply that came after it.
    const reply = transcript.querySelector('[data-message-id="reply"]')!
    expect(line.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(line)
    expect(within(document.getElementById(line.getAttribute('aria-controls')!)!).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      'Opened localhost:5173', 'Looked at the page', 'Could not scroll the page', 'Clicked in the page', 'Pressed Enter',
    ])
    // The edit between them is still the working line's to show.
    expect(within(transcript).getByRole('button', { name: 'Working, 2 steps so far' })).toBeVisible()
  })

  it('leave a call made under a subagent to the subagent\'s row, under the working line', () => {
    const agent = activity({ id: 'agent', kind: 'subagent', title: 'Task', status: 'running', text: JSON.stringify({ description: 'Check the sign-in page' }) })
    const nested = browser('nested', 'browser_action', { action: { type: 'click', x: 1, y: 1 } }, { parentId: 'agent' })
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run(), agent, nested] }))
    // The turn's own calls are the line; the subagent and its call are the working line's.
    within(transcript).getByRole('button', { name: /^Show browser steps: Browsing localhost:5173/u })
    const working = within(transcript).getByRole('button', { name: 'Working, 3 steps so far' })
    fireEvent.click(working)
    const steps = document.getElementById(working.getAttribute('aria-controls')!)!
    const subagent = within(steps).getByRole('button', { name: /^Check the sign-in page/u })
    fireEvent.click(subagent)
    expect(within(steps).getByRole('list', { name: 'Steps in Check the sign-in page' }).querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(1)
  })

  it('find a live line\'s calls again only when its records change, not for each word of a reply', () => {
    const reported = [lifecycle('running'), ...run()]
    const { publish, messages } = mount(stateWith({ status: 'running', activities: reported }))
    // The first words of a reply end the run once; the words after it change nothing the line reads.
    publish({ messages: [...messages(), { id: 'streaming', role: 'assistant', text: 'Sign', createdAt: iso(1_000) }] })
    const before = reads.live
    for (const text of ['Sign-in', 'Sign-in works', 'Sign-in works now.']) publish({ messages: [...messages().filter(message => message.id !== 'streaming'), { id: 'streaming', role: 'assistant', text, createdAt: iso(1_000) }] })
    expect(reads.live).toBe(before)
    publish({ activities: [...reported, browser('more', 'browser_action', { action: { type: 'inspect' } })] })
    expect(reads.live).toBeGreaterThan(before)
  })

  it('do not draw a finished turn\'s group again when the running turn\'s records change', () => {
    localStorage.setItem('sotto.threads.stepsOpen', 'true')
    // A finished turn that browsed, after the fixture's first exchange, then a running one after a second message.
    const earlier = [activity({ id: 'old-turn', turnId: 'turn-0', kind: 'turn', title: 'Turn', status: 'completed', startedAt: iso(-90_000), completedAt: iso(-80_000) }),
      ...run().map(item => ({ ...item, id: `old-${item.id}`, turnId: 'turn-0' }))]
    const ask = { id: 'ask-2', role: 'user' as const, text: 'Now check sign-out.', createdAt: iso(-1_000) }
    const live = (status: AgentActivity['status']): AgentActivity[] => [
      activity({ id: 'new-turn', kind: 'turn', title: 'Turn', status: 'running', startedAt: iso(-1_000), afterMessageId: 'ask-2' }),
      browser('new-open', 'browser_open', { url: 'http://localhost:5173/' }, { afterMessageId: 'ask-2', status }),
    ]
    const state = stateWith({ status: 'running', activities: [...earlier, ...live('running')] })
    const thread = state.host.threads.find(item => item.id === THREAD)!
    thread.messages = [...thread.messages, ask]
    const { transcript, publish } = mount(state)
    within(transcript).getByRole('button', { name: 'Show browser steps: Browsed localhost:5173 · 4 steps, 1 did not finish' })
    within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · opened localhost:5173' })
    expect(reads.folds).toContain('turn-0')
    reads.folds.length = 0
    // Only the running turn's call changes: the finished turn's group keeps what it drew.
    publish({ activities: [...earlier, ...live('completed')] })
    within(transcript).getByRole('button', { name: 'Show browser steps: Browsing localhost:5173 · opened localhost:5173' })
    expect(reads.folds).not.toContain('turn-0')
  })
})

describe('on stable', () => {
  it('keeps a row for every call, all under the working line', () => {
    gate.on = false
    const { transcript } = mount(stateWith({ status: 'running', activities: [lifecycle('running'), ...run()] }))
    expect(transcript.querySelector('.thread-browser')).toBeNull()
    const working = within(transcript).getByRole('button', { name: 'Working, 5 steps so far' })
    fireEvent.click(working)
    const steps = document.getElementById(working.getAttribute('aria-controls')!)!
    expect(steps.querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(4)
    expect(steps.querySelector('.thread-browser')).toBeNull()
  })

  it('keeps a finished turn\'s rows too', () => {
    gate.on = false
    localStorage.setItem('sotto.threads.stepsOpen', 'true')
    const { transcript } = mount(stateWith({ status: 'idle', activities: [lifecycle('completed'), ...run()] }))
    expect(transcript.querySelector('.thread-browser')).toBeNull()
    expect(transcript.querySelectorAll('.thread-activity__row[data-kind="tool"]')).toHaveLength(4)
  })
})
