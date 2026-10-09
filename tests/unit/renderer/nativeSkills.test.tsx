import { setPromptText, setPromptSelection, promptText } from './helpers/promptEditor'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillCatalog } from '../../../src/shared/agentSkills'
import type { AgentCapabilities, AgentCommand, AgentState } from '../../../src/shared/agents'
import { E2E_THREADS_NOW } from '../../../src/shared/e2e'
import { useAgents } from '../../../src/renderer/src/agents/AgentContext'
import type { PromptEditorElement } from '../../../src/renderer/src/agents/promptSelection'
import { ThreadsView } from '../../../src/renderer/src/agents/ThreadsView'
import {
  detectSkillTrigger, hasSkillMention, insertSkill, pickableSkills, retainSkillReferences, skillLimitReached, skillSigils, skillToken,
} from '../../../src/renderer/src/agents/composerSkills'
import { liveAgentState, threadsStateFixture } from '../../fixtures/renderer/liveAgentState'

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const BASE: AgentCapabilities = { projects: true, threads: true, submit: true, observe: true, questions: true, permissions: true, interrupt: true, messageOrigin: true, reconcile: true, skills: true }

// The shape src/main/agents/claudeSkills.ts builds from the CLI's initialize commands.
const path = (name: string): string => `claude-command:C%3A%2Fworkshop:${name}`
const CLAUDE: AgentSkillCatalog = {
  threadId: THREAD, providerId: 'claude', cwd: 'C:/workshop', status: 'ready', errors: [], maxSkillsPerMessage: 1,
  invocationNotice: 'Claude expands one slash invocation per message.',
  skills: [
    { name: 'review', description: 'Review the diff (project)', path: path('review'), scope: 'repo', enabled: true, userInvocable: true, invocation: '/review' },
    { name: 'release-notes', description: 'Draft release notes (user)', path: path('release-notes'), scope: 'user', enabled: true, userInvocable: true, invocation: '/release-notes' },
    { name: 'off', description: 'Disabled in settings', path: path('off'), scope: 'user', enabled: false, invocation: '/off' },
    { name: 'model-only', description: 'Only the model can call this', path: path('model-only'), scope: 'user', userInvocable: false, invocation: '/model-only' },
  ],
}

function mount(catalog: AgentSkillCatalog) {
  const state: AgentState = threadsStateFixture()
  state.assignments = []
  state.activeThreadId = THREAD
  state.host.capabilities = BASE
  const live = liveAgentState(state, { catalog: () => catalog })
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView onOpenAgents={vi.fn()} now={NOW} />)
  return { live, prompt: () => screen.getByRole('textbox', { name: 'Prompt' }) as HTMLElement }
}

const requests = <T extends AgentCommand['type']>(live: ReturnType<typeof liveAgentState>, type: T): Extract<AgentCommand, { type: T }>[] =>
  live.command.mock.calls.map(([request]) => request).filter((request): request is Extract<AgentCommand, { type: T }> => request.type === type)

function type(prompt: HTMLElement, value: string): void {
  setPromptText(prompt, value)
  setPromptSelection(prompt, value.length, value.length)
  fireEvent.select(prompt)
}

beforeEach(() => { vi.mocked(useAgents).mockReset() })
afterEach(cleanup)

describe('native skill tokens', () => {
  it('writes the catalog invocation where the provider reads it, and $name for Codex', () => {
    const review = CLAUDE.skills[0]!
    expect(skillToken(review)).toBe('/review')
    expect(skillToken({ name: 'deploy' })).toBe('$deploy')
    expect(skillToken({ name: 'x', invocation: 'not a token' })).toBe('$x')
    const trigger = detectSkillTrigger('/re', 3)!
    expect(insertSkill('/re', trigger, review, [], skillSigils('claude'))).toMatchObject({ text: '/review ', skills: [{ name: 'review', path: path('review') }] })
    expect(insertSkill('/re', trigger, review, [], skillSigils('codex')).text).toBe('$review ')
    expect(pickableSkills(CLAUDE.skills).map(skill => skill.name)).toEqual(['review', 'release-notes'])
  })

  it('keeps a /name selection only for providers that read slash mentions', () => {
    const refs = [{ name: 'review', path: path('review') }]
    expect(retainSkillReferences('/review the branch', refs, skillSigils('grok'))).toEqual(refs)
    expect(retainSkillReferences('/review the branch', refs, skillSigils('codex'))).toEqual([])
    expect(hasSkillMention('see /reviewer', 'review', ['/'])).toBe(false)
    expect(skillLimitReached(refs, { name: 'release-notes', path: path('release-notes') }, 1)).toBe(true)
    expect(skillLimitReached(refs, refs[0]!, 1)).toBe(false)
    expect(skillLimitReached(refs, { name: 'other', path: 'p' }, undefined)).toBe(false)
  })
})

describe('provider skill picker', () => {
  it('undo restores repeated pills with one skill reference', () => {
    const { live, prompt } = mount(CLAUDE)
    const reference = { name: 'review', path: path('review') }
    act(() => { live.threadDrafts.edit(THREAD, { text: '/review /review ', skills: [reference] }) })
    const field = prompt() as PromptEditorElement
    act(() => { field.editor.commands.selectAll(); field.editor.commands.deleteSelection() })
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([])
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true })
    expect(promptText(field)).toBe('/review /review ')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([reference])
  })
  it('undoes and redoes a picker insertion as one edit', async () => {
    const { live, prompt } = mount(CLAUDE)
    type(prompt(), '/rev')
    await screen.findByRole('listbox', { name: 'Skills' })
    fireEvent.keyDown(prompt(), { key: 'Tab' })
    expect(promptText(prompt())).toBe('/review ')
    fireEvent.keyDown(prompt(), { key: 'z', ctrlKey: true })
    expect(promptText(prompt())).toBe('/rev')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([])
    fireEvent.keyDown(prompt(), { key: 'y', ctrlKey: true })
    expect(promptText(prompt())).toBe('/review ')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([{ name: 'review', path: path('review') }])
  })
  it('Backspace removes a chosen pill and its reference, and undo restores both', async () => {
    const { live, prompt } = mount(CLAUDE)
    type(prompt(), '/')
    await screen.findByRole('listbox', { name: 'Skills' })
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    setPromptSelection(prompt(), '/review'.length)
    fireEvent.keyDown(prompt(), { key: 'Backspace' })
    expect(promptText(prompt())).toBe(' ')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([])
    expect(prompt().querySelector('[data-skill-token]')).toBeNull()
    fireEvent.keyDown(prompt(), { key: 'z', ctrlKey: true })
    expect(promptText(prompt())).toBe('/review ')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([{ name: 'review', path: path('review') }])
  })
  it('lists only invocable Claude skills by their slash token and holds the one-per-message limit', async () => {
    const { live, prompt } = mount(CLAUDE)
    type(prompt(), '/')
    const list = await screen.findByRole('listbox', { name: 'Skills' })
    expect(within(list).getAllByRole('option').map(option => option.querySelector('.composer-picker__name')!.textContent)).toEqual(['review', 'release-notes'])
    expect(screen.getByText('Claude expands one slash invocation per message.')).toBeInTheDocument()
    fireEvent.keyDown(prompt(), { key: 'ArrowDown' })
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(promptText(prompt())).toBe('/review ')
    expect(prompt().querySelector('[data-skill-token]')).toHaveAttribute('data-skill-token', '/review')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([{ name: 'review', path: path('review') }])

    type(prompt(), '/review then $rel')
    const again = await screen.findByRole('listbox', { name: 'Skills' })
    const option = within(again).getByRole('option')
    expect(option).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Claude takes one skill per message. Remove /review to choose another.')).toHaveAttribute('role', 'status')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    fireEvent.click(option)
    expect(promptText(prompt())).toBe('/review then $rel')
    expect(requests(live, 'manual-send')).toHaveLength(0)

    // Removing the first mention frees the one slot.
    type(prompt(), 'then $rel')
    expect(live.threadDrafts.draft(THREAD).skills).toEqual([])
    const freed = await screen.findByRole('listbox', { name: 'Skills' })
    expect(within(freed).getByRole('option')).not.toHaveAttribute('aria-disabled')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(promptText(prompt())).toBe('then /release-notes ')
  })

  it('says a provider cannot list skills and still sends what was typed', async () => {
    const { live, prompt } = mount({ ...CLAUDE, providerId: 'grok', status: 'unsupported', skills: [], maxSkillsPerMessage: undefined, invocationNotice: undefined, error: 'Grok 1.0.4 cannot list skills. Update Grok to choose skills here.' })
    type(prompt(), '/compact')
    expect(await screen.findByText('Grok 1.0.4 cannot list skills. Update Grok to choose skills here.')).toHaveAttribute('role', 'status')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Enter sends what you typed.')).toBeInTheDocument()
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(requests(live, 'manual-send')).toEqual([{ type: 'manual-send', threadId: THREAD, draftId: expect.any(String), text: '/compact' }])
    act(() => undefined)
  })
})
