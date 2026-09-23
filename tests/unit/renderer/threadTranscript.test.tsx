import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentMessage } from '../../../src/shared/agents'
import { MessageList, type ActivityContext } from '../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../src/renderer/src/agents/threadActivityView'

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
    fireEvent.keyDown(items[1], { key: 'Enter' })
    fireEvent.click(items[1])
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
    // The live turn keeps its layout: its answer, then the command it is running.
    expect(transcript.indexOf('assistant a2')).toBeLessThan(transcript.indexOf('npm run now'))
  })

  it('puts each turn’s work between its own message and its reply once the earlier messages are loaded', () => {
    render(<MessageList messages={history} provider="claude" running placement={placeActivities(history, history, activities)} context={live} />)
    const turns = screen.getAllByRole('region', { name: /Worked for/u })
    expect(turns.map(turn => turn.getAttribute('aria-label'))).toEqual(['Worked for 3m 34s', 'Worked for 29m 10s'])
    const transcript = document.body.textContent ?? ''
    const order = ['user u0', 'Worked for 3m 34s', 'assistant a0', 'user u1', 'Worked for 29m 10s', 'assistant a1', 'user u2', 'assistant a2', 'npm run now']
    expect(order.map(text => transcript.indexOf(text))).toEqual([...order.map(text => transcript.indexOf(text))].sort((a, b) => a - b))
    expect(order.every(text => transcript.includes(text))).toBe(true)
  })
})
