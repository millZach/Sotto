import React from 'react'
import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySurface } from '../../../src/renderer/src/features/memory/MemorySurface'
import { questions, boundaryLabels } from '../../../src/renderer/src/features/memory/questions'
import { useMemory } from '../../../src/renderer/src/features/memory/useMemory'
import type { MemoryBridge, MemoryItem, MemorySnapshot } from '../../../src/shared/memory'

const originalSotto = Object.getOwnPropertyDescriptor(window, 'sotto')
afterEach(() => {
  cleanup()
  if (originalSotto) Object.defineProperty(window, 'sotto', originalSotto)
  else Reflect.deleteProperty(window, 'sotto')
})
const at = '2026-09-11T12:00:00.000Z'
const empty = (): MemorySnapshot => ({ available: true, questionnaireCompletedAt: null, memories: [], policies: [] })
const item = (id: string, content: string, overrides: Partial<MemoryItem> = {}): MemoryItem => ({
  id, content, type: 'preference', scope: 'global', sourceClass: 'explicit', confidence: 1, evidenceCount: 1,
  importance: 0.8, createdAt: at, lastConfirmedAt: at, lastUsedAt: null, validFrom: at, validTo: null,
  supersededBy: null, provenance: [{ source: 'questionnaire', ref: `submission:${id}`, recordedAt: at }],
  tags: ['communication'], state: 'active', authority: 'preference', ...overrides,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function bridge(snapshot = empty()) {
  let listener: ((value: MemorySnapshot) => void) | undefined
  const stop = vi.fn()
  const memory = {
    get: vi.fn<MemoryBridge['get']>(async () => snapshot),
    command: vi.fn<MemoryBridge['command']>(async () => ({ ...snapshot, questionnaireCompletedAt: at })),
    onChanged: vi.fn<MemoryBridge['onChanged']>(callback => { listener = callback; return stop }),
  }
  Object.defineProperty(window, 'sotto', { configurable: true, value: { memory } })
  return { ...memory, memory, stop, emit(value: MemorySnapshot) { act(() => { listener?.(value) }) } }
}
function surface(navigation: 'home' | 'agents' | 'memory') {
  return <MemorySurface navigation={navigation}><p>{navigation === 'home' ? 'Dictate room' : 'Agents room'}</p></MemorySurface>
}
async function answerQuestions(user: ReturnType<typeof userEvent.setup>) {
  const answers = questions.map(question => ({ topic: question.topic, content: `My ${question.topic} preference.` }))
  for (const answer of answers) {
    await user.type(screen.getByRole('textbox'), answer.content)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
  }
  return answers
}

describe('working preferences and memory inspector', () => {
  it('leaves Dictate available, asks on first Agents entry, and resumes a dismissed draft through Memory', async () => {
    const f = bridge()
    const user = userEvent.setup()
    const view = render(surface('home'))
    expect(screen.getByText('Dictate room')).toBeVisible()
    await waitFor(() => expect(f.get).toHaveBeenCalledOnce())
    view.rerender(surface('agents'))
    expect(await screen.findByRole('region', { name: 'Working preferences' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await user.type(screen.getByRole('textbox'), 'Keep spoken replies short.')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.getByText('Agents room')).toBeVisible()
    expect(f.command).not.toHaveBeenCalled()
    view.rerender(surface('home'))
    view.rerender(surface('agents'))
    expect(screen.getByText('Agents room')).toBeVisible()
    view.rerender(surface('memory'))
    await user.click(screen.getByRole('button', { name: 'Set working preferences' }))
    expect(screen.getByRole('textbox')).toHaveAccessibleName(questions[1]!.question)
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('textbox')).toHaveValue('Keep spoken replies short.')
  })

  it('reviews seven answers and confirmation choices, then sends one atomic command and waits for its response', async () => {
    const f = bridge()
    const saved = deferred<MemorySnapshot>()
    f.command.mockReturnValueOnce(saved.promise)
    const user = userEvent.setup()
    render(surface('agents'))
    await screen.findByRole('textbox')
    const answers = await answerQuestions(user)
    expect(f.command).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: boundaryLabels.publish }))
    await user.click(screen.getByRole('checkbox', { name: boundaryLabels.spend }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    for (const answer of answers) expect(screen.getByText(answer.content)).toBeVisible()
    expect(screen.getByText(/they grant no new permissions/i)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(f.command).toHaveBeenCalledExactlyOnceWith({ type: 'complete-questionnaire', answers, boundaries: ['publish', 'spend'] })
    expect(screen.queryByText('Agents room')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled()
    await act(async () => { saved.resolve({ ...empty(), questionnaireCompletedAt: at }); await saved.promise })
    expect(screen.getByText('Agents room')).toBeVisible()
  })

  it('keeps a failed questionnaire on review with the answers intact and permits a retry', async () => {
    const f = bridge()
    f.command.mockRejectedValueOnce(new Error('The disk could not save your preferences.'))
    const user = userEvent.setup()
    render(surface('agents'))
    await screen.findByRole('textbox')
    const answers = await answerQuestions(user)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The disk could not save your preferences.')
    expect(screen.queryByText('Agents room')).not.toBeInTheDocument()
    for (const answer of answers) expect(screen.getByText(answer.content)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save preferences' }))
    expect(await screen.findByText('Agents room')).toBeVisible()
    expect(f.command).toHaveBeenCalledTimes(2)
  })

  it('shows loading, unavailable and failed reads without treating them as completed onboarding', async () => {
    const f = bridge()
    const initial = deferred<MemorySnapshot>()
    f.get.mockReturnValueOnce(initial.promise)
    const view = render(surface('agents'))
    expect(screen.getByRole('status')).toHaveTextContent('Reading your preferences')
    await act(async () => { initial.resolve({ ...empty(), available: false }); await initial.promise })
    expect(screen.getByText('Agents room')).toBeVisible()
    view.rerender(surface('memory'))
    expect(screen.getByRole('status')).toHaveTextContent('Memory is unavailable')
    expect(screen.queryByRole('button', { name: 'Set working preferences' })).not.toBeInTheDocument()
    f.emit(empty())
    expect(screen.getByRole('button', { name: 'Set working preferences' })).toBeVisible()
    view.unmount()
    f.get.mockRejectedValueOnce(new Error('Offline'))
    render(surface('memory'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read memory')
    expect(screen.getByRole('status')).toHaveTextContent('Memory has not loaded')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh memory' }))
    expect(await screen.findByRole('button', { name: 'Set working preferences' })).toBeVisible()
    expect(f.command).not.toHaveBeenCalled()
  })

  it('edits and supersedes current memories, exposes history and provenance, and confirms chain deletion while policies stay read-only', async () => {
    const policy = { id: 'policy-1', action: 'publish' as const, resource: '*', scope: 'global', effect: 'always-confirm' as const, source: 'questionnaire' as const, note: 'Always ask first.', grantedAt: at, revokedAt: null, expiresAt: null }
    const first = item('first', 'Keep replies short.')
    const initial = { ...empty(), questionnaireCompletedAt: at, memories: [first], policies: [policy] }
    const f = bridge(initial)
    const user = userEvent.setup()
    render(surface('memory'))
    const row = await screen.findByRole('article', { name: first.content })
    await user.click(within(row).getByText('Why Sotto remembers this'))
    expect(within(row).getByText(/submission:first/)).toBeVisible()
    expect(within(row).getByText('100%')).toBeVisible()
    await user.click(within(row).getByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Edit memory' }))
    await user.type(screen.getByRole('textbox', { name: 'Edit memory' }), 'Use diagrams.')
    const second = item('second', 'Use diagrams.')
    const edited = { ...initial, memories: [{ ...first, state: 'superseded' as const, supersededBy: second.id }, second] }
    f.command.mockResolvedValueOnce(edited)
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(f.command).toHaveBeenLastCalledWith({ type: 'edit', id: first.id, content: second.content })
    expect(screen.queryByRole('article', { name: first.content })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Show past versions' }))
    const historical = screen.getByRole('article', { name: first.content })
    expect(within(historical).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    await user.click(within(screen.getByRole('article', { name: second.content })).getByRole('button', { name: 'Supersede' }))
    expect(screen.getByRole('textbox', { name: 'Replacement memory' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Replacement memory' }), 'Prefer detailed replies.')
    const third = item('third', 'Prefer detailed replies.')
    f.command.mockResolvedValueOnce({ ...initial, memories: [edited.memories[0]!, { ...second, state: 'superseded', supersededBy: third.id }, third] })
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(f.command).toHaveBeenLastCalledWith({ type: 'supersede', id: second.id, content: third.content })
    await user.click(within(screen.getByRole('article', { name: first.content })).getByRole('button', { name: 'Delete' }))
    expect(f.command).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Delete this memory and all its past versions/)).toBeVisible()
    await user.click(within(screen.getByRole('article', { name: first.content })).getByRole('button', { name: 'Cancel' }))
    expect(f.command).toHaveBeenCalledTimes(2)
    await user.click(within(screen.getByRole('article', { name: first.content })).getByRole('button', { name: 'Delete' }))
    f.command.mockResolvedValueOnce({ ...initial, memories: [] })
    await user.click(screen.getByRole('button', { name: 'Delete memory' }))
    expect(f.command).toHaveBeenLastCalledWith({ type: 'delete', id: first.id })
    expect(await screen.findByText('Sotto has no saved memories yet.')).toBeVisible()
    const policies = screen.getByRole('region', { name: 'Policies' })
    expect(within(policies).getByText(/Always confirm:/)).toBeVisible()
    expect(within(policies).queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps unsaved text after a failed edit and refreshes the snapshot before retry', async () => {
    const memory = item('current', 'Use short replies.')
    const f = bridge({ ...empty(), questionnaireCompletedAt: at, memories: [memory] })
    f.command.mockRejectedValueOnce(new Error('Memory write failed.'))
    const user = userEvent.setup()
    render(surface('memory'))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'Keep this unsaved change.')
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Memory write failed.')
    expect(screen.getByRole('textbox')).toHaveValue('Keep this unsaved change.')
    expect(f.get).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale initial read after a newer change notification and unsubscribes on unmount', async () => {
    const f = bridge()
    const read = deferred<MemorySnapshot>()
    f.get.mockReturnValueOnce(read.promise)
    const { result, unmount } = renderHook(() => useMemory(f.memory))
    const completed = { ...empty(), questionnaireCompletedAt: at, memories: [item('saved', 'Saved preference')] }
    f.emit(completed)
    await act(async () => { read.resolve(empty()); await read.promise })
    expect(result.current.snapshot).toEqual(completed)
    unmount()
    expect(f.stop).toHaveBeenCalledOnce()
  })

  it('keeps an unsaved stale edit available when refresh reveals a replacement from another window', async () => {
    const first = item('first', 'Use short replies.')
    const snapshot = { ...empty(), questionnaireCompletedAt: at, memories: [first] }
    const f = bridge(snapshot)
    const user = userEvent.setup()
    render(surface('memory'))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'Do not lose my unsaved wording.')
    f.command.mockRejectedValueOnce(new Error('This memory has been superseded. Edit its current replacement.'))
    f.get.mockResolvedValueOnce({ ...snapshot, memories: [
      { ...first, state: 'superseded', supersededBy: 'replacement' }, item('replacement', 'Another window changed this.'),
    ] })
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('superseded')
    expect(screen.getByRole('textbox')).toHaveValue('Do not lose my unsaved wording.')
    expect(f.command).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Review current replacement' }))
    expect(f.command).toHaveBeenCalledOnce()
    expect(screen.getByRole('textbox')).toHaveValue('Do not lose my unsaved wording.')
    expect(screen.getByRole('article', { name: 'Another window changed this.' })).toContainElement(screen.getByRole('textbox'))
    f.command.mockResolvedValueOnce({ ...snapshot, memories: [item('final', 'Do not lose my unsaved wording.')] })
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(f.command).toHaveBeenLastCalledWith({ type: 'edit', id: 'replacement', content: 'Do not lose my unsaved wording.' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('retains wording for copying after another window deletes the memory and disables saving it', async () => {
    const first = item('first', 'Use short replies.')
    const snapshot = { ...empty(), questionnaireCompletedAt: at, memories: [first] }
    const f = bridge(snapshot)
    const user = userEvent.setup()
    render(surface('memory'))
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'Keep this wording.')
    f.emit({ ...snapshot, memories: [] })
    expect(screen.getByRole('textbox')).toHaveValue('Keep this wording.')
    expect(screen.getByText(/This memory was deleted/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save memory' })).toBeDisabled()
    expect(f.command).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Sotto has no saved memories yet.')).toBeVisible()
  })
})
