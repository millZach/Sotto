import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
