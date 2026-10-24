import { promptText, setPromptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCommand, AgentState } from '../../../src/shared/agents'
import type { NextPrompt } from '../../../src/shared/nextPrompt'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import { ghostRest, withNextText } from '../../../src/renderer/src/agents/ThreadComposer'
import { NextPromptStore, nextPromptStore } from '../../../src/renderer/src/agents/nextPrompts'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

const owl = vi.hoisted(() => ({ next: true }))
vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))
vi.mock('../../../src/renderer/src/state/owlFeature', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/renderer/src/state/owlFeature')>()
  return { ...actual, useOwlFeature: (id: string) => id === 'next-prompt' ? owl.next : actual.useOwlFeature(id as never) }
})

const THREAD = 'grok-previews'
const PROMPT: NextPrompt = {
  headline: 'The preview now plays through the chosen voice.',
  ghost: 'Open the pull request for this fix',
  suggestions: [
    { intent: 'continue', label: 'Light theme too', text: 'Do the same for the light theme' },
    { intent: 'verify', label: 'Run the checks', text: 'Run the preview checks again' },
    { intent: 'challenge', label: 'Why this voice', text: 'Why this voice and not the default?' },
    { intent: 'wrap', label: 'Commit it', text: 'Commit this with a plain message' },
  ],
  answers: [],
}

let anchor = ''
function mount(options: { running?: boolean; prompt?: NextPrompt; afterUserMessageId?: string } = {}) {
  const state: AgentState = threadsStateFixture()
  state.activeThreadId = THREAD
  if (options.running) state.host = { ...state.host, threads: state.host.threads.map(thread => thread.id === THREAD ? { ...thread, status: 'running' as const } : thread) }
  anchor = state.host.threads.find(thread => thread.id === THREAD)!.lastUserMessageId ?? ''
  nextPromptStore.apply({ threadId: THREAD, afterUserMessageId: options.afterUserMessageId ?? anchor, prompt: options.prompt ?? PROMPT })
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={E2E_THREADS_NOW} />)
  return { live, prompt: () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLElement }
}

const sends = (live: ReturnType<typeof liveAgentState>): Extract<AgentCommand, { type: 'manual-send' }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: 'manual-send' }> => request.type === 'manual-send')
const ghost = (): HTMLElement | null => document.querySelector('.prompt-editor__ghost')
const list = (): HTMLElement | null => screen.queryByRole('listbox', { name: 'Next prompts' })
const nextButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Next' })

beforeEach(() => { owl.next = true; vi.mocked(useAgents).mockReset() })
afterEach(() => { cleanup(); nextPromptStore.sent(THREAD, '\u0000') })

describe('the next prompt in an empty composer', () => {
  it('shows the next prompt as a ghost with a Tab keycap, describes it, and Tab takes it', () => {
    const { prompt } = mount()
    expect(ghost()).toHaveTextContent('Open the pull request for this fixTab')
    expect(ghost()).toHaveAttribute('aria-hidden', 'true')
    const described = prompt().getAttribute('aria-describedby')!.split(' ').map(id => document.getElementById(id)?.textContent).join(' ')
    expect(described).toContain('Suggested next prompt: Open the pull request for this fix. Press Tab to take it')
    prompt().focus()
    const tab = fireEvent.keyDown(prompt(), { key: 'Tab' })
    expect(tab).toBe(false)
    expect(promptText(prompt())).toBe('Open the pull request for this fix')
    expect(ghost()).toBeNull()
  })

  it('keeps the rest ghosted after a prefix in any case, and leaves Tab alone once the text leaves it', () => {
    const { prompt } = mount()
    setPromptText(prompt(), 'open the')
    expect(ghost()!.firstChild!.textContent).toBe(' pull request for this fix')
    fireEvent.keyDown(prompt(), { key: 'Tab' })
    expect(promptText(prompt())).toBe('Open the pull request for this fix')
    setPromptText(prompt(), 'Something else')
    expect(ghost()).toBeNull()
    expect(fireEvent.keyDown(prompt(), { key: 'Tab' })).toBe(true)
    expect(promptText(prompt())).toBe('Something else')
  })

  it('offers nothing while a turn runs, for a turn that is over, or while the Owl feature is off', () => {
    mount({ running: true })
    expect(ghost()).toBeNull(); expect(nextButton()).toBeNull()
    cleanup()
    mount({ afterUserMessageId: 'an-older-message' })
    expect(ghost()).toBeNull(); expect(nextButton()).toBeNull()
    cleanup()
    owl.next = false
    const { prompt } = mount()
    expect(ghost()).toBeNull(); expect(nextButton()).toBeNull()
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    expect(list()).toBeNull()
  })
})

describe('the Next list', () => {
  it('opens on Up in an empty prompt over the composer, headed by the headline, and moves with the arrows', () => {
    const { prompt } = mount()
    prompt().focus()
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    const opened = list()!
    expect(opened.closest('.composer-picker')!.parentElement).toHaveClass('thread-prompt')
    expect(screen.getByText('The preview now plays through the chosen voice.')).toBeInTheDocument()
    const rows = within(opened).getAllByRole('option')
    expect(rows.map(row => row.querySelector('.next-list__key')!.textContent)).toEqual(['Tab', '1', '2', '3', '4'])
    expect(prompt()).toHaveAttribute('aria-activedescendant', rows[0]!.id)
    expect(ghost()).toBeNull()
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    expect(prompt()).toHaveAttribute('aria-activedescendant', rows[2]!.id)
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(list()).toBeNull()
    expect(promptText(prompt())).toBe('Do the same for the light theme')
  })

  it('picks a suggestion by its digit, and Escape closes it with nothing written', () => {
    const { live, prompt } = mount()
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    expect(list()).toBeNull()
    expect(promptText(prompt())).toBe('')
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    fireEvent.keyDown(prompt(), { key: '3' })
    expect(promptText(prompt())).toBe('Why this voice and not the default?')
    expect(sends(live)).toEqual([])
  })

  it('opens from Next in the footer, and Escape hands focus back to it', () => {
    const { prompt } = mount()
    const button = nextButton()!
    expect(button).toHaveAttribute('aria-expanded', 'false')
    button.focus()
    fireEvent.click(button)
    expect(list()).not.toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(prompt()).toHaveFocus()
    fireEvent.keyDown(prompt(), { key: 'Escape' })
    expect(list()).toBeNull()
    expect(button).toHaveFocus()
  })

  it('writes a suggestion after what is already typed, on a line of its own', () => {
    const { prompt } = mount()
    setPromptText(prompt(), 'First this.')
    fireEvent.click(nextButton()!)
    fireEvent.click(within(list()!).getByText('Commit it'))
    expect(promptText(prompt())).toBe('First this.\nCommit this with a plain message')
  })

  it('sends an answer at once as the user\'s own message, and the suggestion goes with the send', async () => {
    const { live, prompt } = mount({ prompt: { ...PROMPT, answers: [{ label: 'The default voice', text: 'Use the default voice' }, { label: 'Ask each time', text: 'Ask me each time' }] } })
    fireEvent.keyDown(prompt(), { key: 'ArrowUp' })
    const rows = within(list()!).getAllByRole('option')
    expect(rows.map(row => row.querySelector('.next-list__key')!.textContent)).toEqual(['↵', '↵', 'Tab', '1', '2', '3', '4'])
    expect(screen.getByText('Enter sends this answer')).toBeInTheDocument()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    await act(async () => { await Promise.resolve() })
    expect(sends(live).map(send => send.text)).toEqual(['Use the default voice'])
    expect(nextPromptStore.get(THREAD)).toBeUndefined()
    expect(live.command.mock.calls.some(([request]) => request.type === 'answer')).toBe(false)
  })
})

describe('the window\'s record of next prompts', () => {
  it('drops a late delivery for a turn the user has already answered with a send', () => {
    const store = new NextPromptStore()
    store.apply({ threadId: 't', afterUserMessageId: 'u1', prompt: PROMPT })
    store.sent('t', 'u1')
    expect(store.get('t')).toBeUndefined()
    store.apply({ threadId: 't', afterUserMessageId: 'u1', prompt: PROMPT })
    expect(store.get('t')).toBeUndefined()
    store.apply({ threadId: 't', afterUserMessageId: 'u2', prompt: PROMPT })
    expect(store.get('t')?.afterUserMessageId).toBe('u2')
    store.apply({ threadId: 't', afterUserMessageId: 'u1', prompt: null })
    expect(store.get('t')).toBeDefined()
    store.apply({ threadId: 't', afterUserMessageId: 'u2', prompt: null })
    expect(store.get('t')).toBeUndefined()
  })

  it('completes only a prefix, and writes a choice in place of an empty draft or one it begins with', () => {
    expect(ghostRest('Open the PR', '')).toBe('Open the PR')
    expect(ghostRest('Open the PR', 'OPEN t')).toBe('he PR')
    expect(ghostRest('Open the PR', 'Open the PR')).toBeNull()
    expect(ghostRest('Open the PR', 'Close')).toBeNull()
    expect(ghostRest('', '')).toBeNull()
    expect(withNextText('', 'Run it')).toBe('Run it')
    expect(withNextText('run', 'Run it')).toBe('Run it')
    expect(withNextText('First this.  ', 'Run it')).toBe('First this.\nRun it')
  })
})
