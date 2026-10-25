import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'
import { clockLabel } from '../../../src/renderer/src/agents/threadFacts'

const context: ActivityContext = { liveTurn: 'turn-1', running: true, connected: true, provider: 'codex', onDisclosure: () => undefined }
const at = '2026-09-20T10:44:00.000Z'

const REPLY = [
  'A short answer.',
  '',
  '| a | b | c |',
  '| --- | --- | --- |',
  '| 1 | 2 | 3 |',
  '',
  '```ts',
  'const one = 1',
  '```',
].join('\n')

const messages: AgentMessage[] = [
  { id: 'm1', role: 'user', text: 'Show me the retry table.', createdAt: at },
  { id: 'm2', role: 'assistant', text: REPLY, createdAt: at },
  { id: 'm3', role: 'assistant', text: 'Still writing', createdAt: at },
]

function mount() {
  render(<MessageList messages={messages} provider="Codex" running placement={placeActivities(messages, messages, [])} context={context} />)
}

function stubClipboard(write: (text: string) => Promise<void> = async () => undefined) {
  const writeText = vi.fn(write)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete (window as { sotto?: unknown }).sotto
})

describe('message copy control', () => {
  it('marks finished user and reply messages, and never the one being written', () => {
    mount()
    const controls = screen.getAllByRole('button', { name: /Copy (reply|message) as Markdown/u })
    expect(controls).toHaveLength(2)
    expect(controls[0]).toHaveAccessibleName('Copy message as Markdown')
    expect(controls[1]).toHaveAccessibleName('Copy reply as Markdown')
    const writing = document.querySelectorAll('.thread-message')[2]!
    expect(writing.querySelectorAll('.thread-message__copy')).toHaveLength(0)
    // It sits in the bottom-left corner: after the message's words, not in its header, so Tab reaches it last.
    for (const control of controls) {
      const article = control.closest('article')!
      expect(article.querySelector('header')!.contains(control)).toBe(false)
      expect(article.querySelector('.rich-message')!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it('copies the source Markdown on press and confirms for a moment', async () => {
    vi.useFakeTimers()
    const writeText = stubClipboard()
    mount()
    const control = screen.getByRole('button', { name: 'Copy reply as Markdown' })
    fireEvent.click(control)
    await act(async () => undefined)
    expect(writeText).toHaveBeenCalledWith(REPLY)
    expect(control).toHaveAttribute('data-copied')
    expect(control).toHaveTextContent('Copied')
    await act(async () => { vi.advanceTimersByTime(1700) })
    expect(control).not.toHaveAttribute('data-copied')
    expect(control).not.toHaveTextContent('Copied')
  })

  it('opens a two-item menu on Shift+F10 and copies plain text with tabbed table cells', async () => {
    const writeText = stubClipboard()
    mount()
    const control = screen.getByRole('button', { name: 'Copy reply as Markdown' })
    fireEvent.keyDown(control, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Copy options' })
    const items = screen.getAllByRole('menuitem')
    expect(items.map(item => item.textContent)).toEqual(['Copy as Markdown', 'Copy as plain text'])
    expect(control).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(items[1]).toHaveFocus()
    fireEvent.keyDown(items[1]!, { key: 'Enter' })
    fireEvent.click(items[1]!)
    await act(async () => undefined)
    const text = writeText.mock.calls.at(-1)![0] as string
    expect(text).toContain('a\tb\tc')
    expect(text).not.toContain('```')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(control).toHaveFocus()
  })

  it('closes the menu on Escape and returns focus to the control', () => {
    stubClipboard()
    mount()
    const control = screen.getByRole('button', { name: 'Copy reply as Markdown' })
    fireEvent.keyDown(control, { key: 'F10', shiftKey: true })
    const menu = screen.getByRole('menu', { name: 'Copy options' })
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(control).toHaveFocus()
  })

  it('reads Copy failed when the clipboard refuses', async () => {
    stubClipboard(async () => { throw new Error('denied') })
    mount()
    const control = screen.getByRole('button', { name: 'Copy reply as Markdown' })
    fireEvent.click(control)
    await waitFor(() => expect(control).toHaveTextContent('Copy failed'))
    expect(control).not.toHaveAttribute('data-copied')
  })
})

describe('a pane holding the last turns of a long thread', () => {
  // The reported shape: the store keeps every message, the pane holds a window of the latest turns,
  // and the activity list still carries the work of the turns above that window.
  const clock = (minute: number): string => `2026-09-23T03:${String(minute).padStart(2, '0')}:00.000Z`
  const say = (id: string, role: AgentMessage['role'], minute: number): AgentMessage => ({ id, role, text: `${role} ${id}`, createdAt: clock(minute) })
  const history = [say('u0', 'user', 0), say('a0', 'assistant', 1), say('u1', 'user', 10), say('a1', 'assistant', 11),
    say('u2', 'user', 34), say('a2', 'assistant', 35)]
  const loaded = history.slice(4)
  const step = (id: string, turnId: string, afterMessageId: string, sequence: number, command: string, status: AgentActivity['status'] = 'completed'): AgentActivity =>
    ({ id, turnId, afterMessageId, sequence, kind: 'command', status, title: 'Bash', command })
  const lifecycle = (turnId: string, sequence: number, status: AgentActivity['status'], durationMs?: number): AgentActivity =>
    ({ id: `turn-${turnId}`, turnId, afterMessageId: turnId, sequence, kind: 'turn', status, title: 'Turn', ...(durationMs === undefined ? {} : { durationMs }) })
  const activities = [
    lifecycle('u0', 0, 'completed', 214_000), step('c0', 'u0', 'a0', 1, 'npm run earliest'),
    lifecycle('u1', 2, 'completed', 1_750_000), step('c1', 'u1', 'a1', 3, 'npm run earlier', 'failed'),
    lifecycle('u2', 4, 'running'), step('c2', 'u2', 'a2', 5, 'npm run now', 'running'),
  ]
  const live: ActivityContext = { liveTurn: 'u2', running: true, connected: true, provider: 'claude', onDisclosure: () => undefined }

  it('keeps the work of turns above the window from piling under the newest answer', () => {
    render(<MessageList messages={loaded} provider="claude" running placement={placeActivities(loaded, loaded, activities, false, true)} context={live} />)
    const transcript = document.body.textContent ?? ''
    expect(transcript).not.toContain('npm run earliest')
    expect(transcript).not.toContain('npm run earlier')
    expect(screen.queryByText(/Worked for/u)).not.toBeInTheDocument()
    // The live turn keeps its answer in view; the command it is running folds under the working line after the messages.
    expect(transcript).toContain('assistant a2')
    expect(transcript).not.toContain('npm run now')
  })

  it('puts each turn’s work between its own message and its reply once the earlier messages are loaded', () => {
    render(<MessageList messages={history} provider="claude" running placement={placeActivities(history, history, activities)} context={live} />)
    const turns = screen.getAllByRole('region', { name: /Worked for/u })
    turns.forEach((turn, index) => expect(turn).toHaveAccessibleName(['Worked for 3m 34s · 1 step', 'Worked for 29m 10s · 1 step'][index]))
    const transcript = document.body.textContent ?? ''
    const order = ['user u0', 'Worked for 3m 34s', 'assistant a0', 'user u1', 'Worked for 29m 10s', 'assistant a1', 'user u2', 'assistant a2']
    expect(order.map(text => transcript.indexOf(text))).toEqual([...order.map(text => transcript.indexOf(text))].sort((a, b) => a - b))
    expect(order.every(text => transcript.includes(text))).toBe(true)
  })
})

describe('questions a folded reply asked (#1019)', () => {
  const clock = (minute: number): string => `2026-10-14T10:${String(minute).padStart(2, '0')}:00.000Z`
  const asking = 'Three investigators are tracing it. **Should Overview follow ADR-0078, or show every computer?** I will keep going meanwhile.'
  const turn: AgentMessage[] = [
    { id: 'u', role: 'user', text: 'Fix the Usage tab.', createdAt: clock(8) },
    { id: 'a1', role: 'assistant', text: asking, createdAt: clock(12) },
    { id: 'a2', role: 'assistant', text: 'The Models investigator is done. Is it fine? Yes: the alias and the model differ.', createdAt: clock(17) },
    { id: 'a3', role: 'assistant', text: 'All three are back and the fixes are in. Want me to open the pull request?', createdAt: clock(24) },
  ]
  const activities: AgentActivity[] = [
    { id: 'turn-u', turnId: 'u', afterMessageId: 'u', sequence: 0, kind: 'turn', status: 'completed', title: 'Turn', durationMs: 960_000 },
    { id: 'c1', turnId: 'u', afterMessageId: 'a1', sequence: 1, kind: 'command', status: 'completed', title: 'Bash', command: 'npm test' },
  ]
  const finished: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
  const show = (messages: readonly AgentMessage[], running = false, context = finished) =>
    render(<MessageList messages={[...messages]} provider="Claude Code" running={running} placement={placeActivities([...messages], [...messages], activities)} context={context} />)

  it('quotes each question from a folded reply under the fold, and none from the final reply', () => {
    show(turn)
    const lifted = screen.getAllByRole('region', { name: /asked while working/u })
    expect(lifted).toHaveLength(2)
    expect(lifted[0]).toHaveTextContent(`Claude Code asked while working · ${clockLabel(Date.parse(clock(12)))}`)
    expect(lifted[0]).toHaveTextContent('Should Overview follow ADR-0078, or show every computer?')
    expect(lifted[1]).toHaveTextContent('Is it fine?')
    expect(screen.queryByText('Want me to open the pull request?')).not.toBeInTheDocument()
    const transcript = document.body.textContent ?? ''
    const order = ['Fix the Usage tab.', 'Worked for', 'Should Overview follow', 'All three are back']
    expect(order.map(text => transcript.indexOf(text))).toEqual([...order.map(text => transcript.indexOf(text))].sort((a, b) => a - b))
    // The reply that asked is still folded: only its question is on screen.
    expect(transcript).not.toContain('Three investigators are tracing it.')
  })

  it('opens the fold at the reply that asked, and hands it to the transcript', () => {
    const sought: HTMLElement[] = []
    show(turn, false, { ...finished, onSeek: message => sought.push(message) })
    fireEvent.click(screen.getAllByRole('button', { name: /^Show where it asked, at /u })[0]!)
    expect(screen.getByRole('button', { name: /Worked for/u })).toHaveAttribute('aria-expanded', 'true')
    expect(sought).toHaveLength(1)
    expect(sought[0]).toHaveAttribute('data-message-id', 'a1')
    expect(sought[0]).toHaveAttribute('data-sought')
    expect(sought[0]).toHaveAttribute('tabindex', '-1')
    expect(sought[0]).toHaveTextContent('Three investigators are tracing it.')
  })

  it('draws the code a question quotes as code', () => {
    show([turn[0]!, { ...turn[1]!, text: 'Done. Should I run `npm test` before pushing?' }, turn[3]!])
    const [lifted] = screen.getAllByRole('region', { name: /asked while working/u })
    expect(lifted!.querySelector('blockquote code')).toHaveTextContent('npm test')
    expect(lifted).toHaveTextContent('Should I run npm test before pushing?')
  })

  it('keeps the mark for its full time when Show where it asked is pressed again', () => {
    vi.useFakeTimers()
    show(turn, false, { ...finished, onSeek: () => undefined })
    const where = screen.getAllByRole('button', { name: /^Show where it asked, at /u })[0]!
    fireEvent.click(where)
    const asking = document.querySelector('.thread-message[data-message-id="a1"]')!
    act(() => { vi.advanceTimersByTime(1_000) })
    fireEvent.click(where)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(asking).toHaveAttribute('data-sought')
    act(() => { vi.advanceTimersByTime(700) })
    expect(asking).not.toHaveAttribute('data-sought')
  })

  it('lifts nothing while the turn runs, because nothing is folded', () => {
    show(turn, true, { ...finished, liveTurn: 'u', running: true })
    expect(screen.queryByRole('region', { name: /asked while working/u })).not.toBeInTheDocument()
    expect(document.body.textContent).toContain('Three investigators are tracing it.')
  })

  it('says how many more questions a reply asked than it quotes', () => {
    const many = Array.from({ length: 6 }, (_, index) => `Should I change part ${index + 1} too?`).join(' ')
    show([turn[0]!, { ...turn[1]!, text: many }, turn[3]!])
    const [lifted] = screen.getAllByRole('region', { name: /asked while working/u })
    expect(lifted!.querySelectorAll('blockquote > p')).toHaveLength(4)
    expect(lifted).toHaveTextContent('2 more questions in that reply.')
  })
})
