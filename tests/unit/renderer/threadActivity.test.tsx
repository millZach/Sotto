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

vi.mock('../../../src/renderer/src/agents/AgentContext', () => ({ useAgents: vi.fn() }))

const NOW = E2E_THREADS_NOW
const THREAD = 'grok-previews'
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
let sequence = 0
const mountedEditors = new Set<PromptEditorElement['editor']>()
const activity = (patch: Partial<AgentActivity> & Pick<AgentActivity, 'id'>): AgentActivity =>
  ({ turnId: 'turn-1', sequence: sequence++, kind: 'command', status: 'completed', title: 'Command', afterMessageId: `${THREAD}-1`, ...patch })
const lifecycle = (patch: Partial<AgentActivity> = {}): AgentActivity => activity({ id: `lifecycle-${patch.turnId ?? 'turn-1'}`, kind: 'turn', title: 'Turn', ...patch })

function stateWith(patch: Partial<AgentThread>, connected = true): AgentState {
  const state = threadsStateFixture()

  state.activeThreadId = THREAD
  state.host.connected = connected
  const thread = state.host.threads.find(item => item.id === THREAD)!
  Object.assign(thread, { modelId: 'codex:gpt' }, patch)
  return state
}

function mount(state: AgentState) {
  const live = liveAgentState(state)
  vi.mocked(useAgents).mockImplementation(live.useLive)
  render(<ThreadsView now={NOW} />)
  for (const field of document.querySelectorAll<PromptEditorElement>('.prompt-editor')) mountedEditors.add(field.editor)
  return { live, transcript: screen.getByRole('log', { name: 'Thread transcript' }) }
}

beforeEach(() => { sequence = 0; vi.mocked(useAgents).mockReset() })
afterEach(() => {
  cleanup()
  // Tiptap defers destruction by a tick; release the DOM before Vitest removes document.
  for (const editor of mountedEditors) {
    if (!editor.isDestroyed) editor.destroy()
    expect(editor.isDestroyed).toBe(true)
  }
  mountedEditors.clear()
  vi.useRealTimers()
})

describe('settled activity in the transcript', () => {
  const settled = (): AgentActivity[] => [
    lifecycle({ status: 'completed', durationMs: 124_000, timingSource: 'provider' }),
    activity({ id: 'test', command: 'npm test -- --run', cwd: 'D:\\work', output: 'PASS 12 tests', durationMs: 4_200, timingSource: 'provider' }),
    activity({ id: 'edit', kind: 'file-change', title: 'File changes', changes: [{ path: 'src/voice.ts', kind: 'update', diff: '-old\n+new' }] }),
    activity({ id: 'lint', command: 'npm run lint', status: 'failed', exitCode: 1, output: 'src/voice.ts: 1 error' }),
  ]

  it('folds the turn’s work under one line above the final reply, which stays in focus', () => {
    const { transcript } = mount(stateWith({ activities: settled() }))
    const messages = transcript.querySelectorAll('.thread-message')
    expect(messages).toHaveLength(2)
    const work = within(transcript).getByRole('region', { name: 'Worked for 2m 04s · 3 steps · Ran 2 commands' })
    // DOM order: the user's message, the folded work, then the answer.
    expect(messages[0]!.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(work.compareDocumentPosition(messages[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const summary = within(work).getByRole('button', { name: 'Worked for 2m 04s · 3 steps · Ran 2 commands' })
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(within(transcript).queryByRole('button', { name: /npm run lint/ })).not.toBeInTheDocument()
    expect(messages[1]).toHaveTextContent('Done. The preview plays a two-second sample')

    fireEvent.click(summary)
    // Opened, the one group's rows stand straight under the line with no line of their own, and its failure folds with the
    // rest of its rows.
    const group = within(work).getByRole('region', { name: 'Ran 2 commands, changed 1 file, 1 line added, 1 line removed' })
    expect(within(group).queryByRole('button', { name: 'Ran 2 commands, changed 1 file, 1 line added, 1 line removed' })).not.toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Run \u2068lint\u2069, npm run lint, Exit 1' })).toBeVisible()
    fireEvent.click(summary)
    expect(within(work).queryByRole('button', { name: 'Run \u2068lint\u2069, npm run lint, Exit 1' })).not.toBeInTheDocument()
  })

  it('says an edit once: the press beside the line goes while the fold is open, and the count while the row is', () => {
    const { transcript } = mount(stateWith({ activities: settled() }))
    const changed = (): HTMLElement | null => within(transcript).queryByRole('button', { name: 'Edited voice.ts, 1 line added, 1 line removed' })
    const work = within(transcript).getByRole('button', { name: 'Worked for 2m 04s · 3 steps · Ran 2 commands' })
    expect(changed()).toBeInTheDocument()
    fireEvent.click(work)
    expect(changed()).not.toBeInTheDocument()
    const row = within(transcript).getByRole('button', { name: 'Edited src/voice.ts, 1 line added, 1 line removed, completed' })
    expect(row.querySelector('.thread-lines')).toHaveTextContent('+1 −1')
    fireEvent.click(row)
    expect(row.querySelector('.thread-lines')).not.toBeInTheDocument()
    expect(row).toHaveAccessibleName('Edited src/voice.ts, 1 line added, 1 line removed, completed')
    fireEvent.click(work)
    expect(changed()).toBeInTheDocument()
  })

  it('keeps the total beside the line when the fold holds several changed files', () => {
    const { transcript } = mount(stateWith({ activities: [...settled(), activity({ id: 'second', kind: 'file-change', title: 'Edit', changes: [{ path: 'src/other.ts', kind: 'edit', diff: '@@ -1 +1 @@\n-old\n+new\n' }] })] }))
    fireEvent.click(within(transcript).getByRole('button', { name: /^Worked for/u }))
    expect(within(transcript).getByRole('button', { name: 'Changed 2 files, 2 lines added, 2 lines removed' })).toBeInTheDocument()
  })

  it('says what the turn changed beside its line, with the lines it added and removed', () => {
    const { transcript } = mount(stateWith({ activities: settled() }))
    const changed = within(transcript).getByRole('button', { name: 'Edited voice.ts, 1 line added, 1 line removed' })
    expect(changed).toHaveAttribute('aria-expanded', 'false')
    expect(changed.querySelector('.thread-lines')).toHaveTextContent('+1 −1')
  })

  it('folds replies written on the way, and times a turn with no lifecycle record from its messages', () => {
    const { transcript } = mount(stateWith({
      messages: [
        { id: `${THREAD}-1`, role: 'user', text: 'Check the parser.', createdAt: iso(0) },
        { id: 'on-the-way', role: 'assistant', text: 'Looking at the parser first.', createdAt: iso(2_000) },
        { id: 'empty-call', role: 'assistant', text: '', createdAt: iso(40_000) },
        { id: 'answer', role: 'assistant', text: 'The parser is fine.', createdAt: iso(65_000) },
      ],
      activities: [activity({ id: 'read', afterMessageId: 'on-the-way', command: 'cat parser.ts' })],
    }))
    expect([...transcript.querySelectorAll('.thread-message')].map(message => message.textContent)).toEqual([
      expect.stringContaining('Check the parser.'), expect.stringContaining('The parser is fine.'),
    ])
    fireEvent.click(within(transcript).getByRole('button', { name: 'Worked for 1m 05s · 1 step · Ran 1 command' }))
    const work = within(transcript).getByRole('region', { name: 'Worked for 1m 05s · 1 step · Ran 1 command' })
    expect(work).toHaveTextContent('Looking at the parser first.')
    expect(within(work).getByRole('button', { name: 'Ran 1 command' })).toBeVisible()
  })

  it('opens by keyboard to the exact command, output and diff, with one copy path per block', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: settled() }))
    const work = within(transcript).getByRole('button', { name: 'Worked for 2m 04s · 3 steps · Ran 2 commands' })
    work.focus()
    await user.keyboard('{Enter}')
    expect(work).toHaveAttribute('aria-expanded', 'true')
    const row = within(transcript).getByRole('button', { name: 'Run the tests, npm test -- --run, completed in 4.2s' })
    row.focus()
    await user.keyboard(' ')
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const details = document.getElementById(row.getAttribute('aria-controls')!)!
    // What ran is said once, by the open row; its body leads with what came back, then where it ran, outside the thread's folder.
    expect(row).toHaveTextContent('npm test -- --run')
    expect(within(details).queryByLabelText('command code block')).toBeNull()
    expect(details).not.toHaveTextContent('npm test')
    expect(within(details).getByLabelText('output code block')).toHaveTextContent('PASS 12 tests')
    expect(details).toHaveTextContent('In D:\\work')
    // The duration is stated once, in the row; where it came from is its tooltip and the row's description, not more words in view.
    expect(details).not.toHaveTextContent('4.2s')
    expect(details).not.toHaveTextContent('Reported by Codex')
    expect(row.querySelector('[title="Reported by Codex"]')).toHaveTextContent(/^4\.2s$/u)
    expect(row.querySelector('.tt-visually-hidden')).toHaveTextContent('Reported by Codex')
    expect(row).toHaveAccessibleDescription('Reported by Codex')
    // Copy command sits at the end of the command's own line, the row's next control, and what came back keeps its own Copy.
    const copy = row.closest('li')!.querySelector(':scope > .thread-activity__copy-command button')!
    expect(copy).toHaveAccessibleName('Copy command')
    expect(row.querySelector('.thread-activity__copy-slot')).not.toBeNull()
    expect(within(details).getAllByRole('button', { name: /^Copy/ }).map(button => button.getAttribute('aria-label') || button.textContent)).toEqual(['Copy output code'])
    await user.tab()
    expect(copy).toHaveFocus()

    await user.click(within(transcript).getByRole('button', { name: 'Edited src/voice.ts, 1 line added, 1 line removed, completed' }))
    expect(within(transcript).getByRole('group', { name: 'Diff' })).toHaveTextContent(/Removed: old.*Added: new/u)
  })

  it('keeps the block for a script of several lines, which the row can only name by its first', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 9_000 }),
      activity({ id: 'script', command: 'cd app\nnpm ci', output: 'added 12 packages', durationMs: 900 }),
    ] }))
    const work = within(transcript).getByRole('button', { name: /^Worked for/u })
    if (work.getAttribute('aria-expanded') !== 'true') await user.click(work)
    const row = within(transcript).getByRole('button', { name: /^cd app npm ci/u })
    await user.click(row)
    const details = document.getElementById(row.getAttribute('aria-controls')!)!
    expect(within(details).getByLabelText('command code block')).toHaveTextContent('cd app npm ci')
    expect(within(transcript).queryByRole('button', { name: 'Copy command' })).toBeNull()
  })

  it('leads a described command’s row with what it was for, and shows a quick step’s time neither folded nor open', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ workingDirectory: 'D:\\Projects\\voice', activities: [
      lifecycle({ status: 'completed', durationMs: 9_000 }),
      activity({ id: 'read', command: 'cat src/policy.ts', cwd: 'd:/Projects/voice/', durationMs: 40, output: 'export class RequestPolicy {}',
        text: JSON.stringify({ command: 'cat src/policy.ts', description: 'Read the request policy' }) }),
      activity({ id: 'test', command: 'npm test', durationMs: 6_100, output: 'PASS' }),
      activity({ id: 'peek', command: 'cat src/request.ts', durationMs: 30, output: 'export {}' }),
    ] }))
    const work = within(transcript).getByRole('button', { name: /^Worked for/u })
    if (work.getAttribute('aria-expanded') !== 'true') await user.click(work)
    // Folded, the row says only what it was for, as Claude's summaries do; its name says the command too, and its time, and
    // the command is the row's tooltip.
    const row = within(transcript).getByRole('button', { name: 'Read the request policy, cat src/policy.ts, completed in 0.0s' })
    expect(row).toHaveTextContent(/^Read the request policy$/u)
    expect(row.querySelector('.thread-activity__command')).toBeNull()
    expect(row.closest('li')).toHaveAttribute('title', 'cat src/policy.ts')
    expect(row).not.toHaveAccessibleDescription()
    // A command with no description reads as what it did, in Sotto's words, and never as the bare command; the command is
    // still its tooltip and in its name.
    const own = within(transcript).getByRole('button', { name: 'Read \u2068src/request.ts\u2069, cat src/request.ts, completed in 0.0s' })
    expect(own).toHaveTextContent(/^Read \u2068src\/request\.ts\u2069$/u)
    expect(own.querySelector('.thread-activity__subject--mono')).toBeNull()
    expect(own.closest('li')).toHaveAttribute('title', 'cat src/request.ts')
    // Under a second the folded row shows no time; a slow step keeps its own.
    expect(row.querySelector('.thread-activity__meta')).toHaveTextContent(/^$/u)
    expect(within(transcript).getByRole('button', { name: 'Run the tests, npm test, completed in 6.1s' })).toHaveTextContent('6.1s')
    await user.click(row)
    // Open, the row says what it was for and the command whole. Under a second its time is still only in its name, and where
    // the time came from, the thread's own provider, is said only to assistive tech; the body says none of it again.
    expect(row).toHaveTextContent(/^Read the request policycat src\/policy\.ts/u)
    expect(row.closest('li')).not.toHaveAttribute('title')
    expect(row.querySelector('.thread-activity__meta > :not(.tt-visually-hidden)')).toBeNull()
    expect(row).toHaveAccessibleDescription('Reported by Codex')
    expect(row).toHaveAccessibleName('Read the request policy, cat src/policy.ts, completed in 0.0s')
    const details = document.getElementById(row.getAttribute('aria-controls')!)!
    expect(details).not.toHaveTextContent('Read the request policy')
    expect(within(details).getByLabelText('output code block')).toHaveTextContent('export class RequestPolicy')
    // It ran in the thread's own folder, however that folder is spelt, so the body does not name it.
    expect(details).not.toHaveTextContent(/\bIn\b/u)
    expect(within(details).queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(row.closest('li')!.querySelector(':scope > .thread-activity__copy-command')).toContainElement(within(transcript).getByRole('button', { name: 'Copy command' }))
  })

  it('holds a long output at twelve lines and says how many more there are, on a press that shows the rest', async () => {
    const user = userEvent.setup()
    const long = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 9_000 }),
      activity({ id: 'long', command: 'cat long.txt', durationMs: 40, output: `${long}\n` }),
      activity({ id: 'near', command: 'cat near.txt', durationMs: 40, output: Array.from({ length: 14 }, (_, index) => `near ${index + 1}`).join('\n') }),
    ] }))
    const work = within(transcript).getByRole('button', { name: /^Worked for/u })
    if (work.getAttribute('aria-expanded') !== 'true') await user.click(work)
    await user.click(within(transcript).getByRole('button', { name: /^Read ⁨long\.txt⁩, cat long\.txt/u }))
    const more = within(transcript).getByRole('button', { name: 'Show 28 more lines' })
    expect(more.closest('.thread-activity__output')).toHaveAttribute('data-held')
    await user.click(more)
    // The press shows the rest in place and takes focus into it; nothing is left to press.
    expect(within(transcript).queryByRole('button', { name: /more lines?$/u })).toBeNull()
    const output = within(transcript).getByLabelText('output code block')
    expect(output).toHaveFocus()
    expect(output).toHaveTextContent('line 40')
    expect(output.closest('.thread-activity__output')).not.toHaveAttribute('data-held')
    // Two lines more than the twelve are not worth a press: that output shows whole.
    await user.click(within(transcript).getByRole('button', { name: /^Read ⁨near\.txt⁩, cat near\.txt/u }))
    expect(within(transcript).queryByRole('button', { name: /more lines?$/u })).toBeNull()
  })

  it('folds what Escape is inside, one level at a time, with focus on the button that opened it', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: settled() }))
    const work = within(transcript).getByRole('button', { name: 'Worked for 2m 04s · 3 steps · Ran 2 commands' })
    await user.click(work)
    const row = within(transcript).getByRole('button', { name: 'Run the tests, npm test -- --run, completed in 4.2s' })
    await user.click(row)
    const copy = within(transcript).getByRole('button', { name: 'Copy command' })
    copy.focus()
    await user.keyboard('{Escape}')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(work).toHaveAttribute('aria-expanded', 'false')
    expect(work).toHaveFocus()
  })
})

describe('the running turn', () => {
  const running = (): AgentActivity[] => [
    lifecycle({ status: 'running', startedAt: iso(-65_000), timingSource: 'observed' }),
    activity({ id: 'install', command: 'npm ci', durationMs: 9_000 }),
    activity({ id: 'test', command: 'npm test', status: 'running', startedAt: iso(-8_000) }),
  ]

  it('folds the running turn’s steps under its working line, and opens them on a press', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { transcript } = mount(stateWith({ status: 'running', activities: running() }))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    // The line names the step it is on; assistive tech hears how far the turn has got instead.
    const words = liveRow.querySelector('.thread-activity-live__word')!
    expect(words.textContent).toBe('Running ⁨npm test⁩')
    // The light draws a lit copy of the words, so the copy follows them.
    expect(words).toHaveAttribute('data-word', words.textContent)
    // No clock beside them and no count.
    expect(liveRow.querySelector('[data-elapsed]')).toBeNull()
    expect(liveRow).not.toHaveTextContent('2 steps')
    const line = within(liveRow).getByRole('button', { name: 'Working, 2 steps so far' })
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(within(transcript).queryByRole('button', { name: 'Run the tests, npm test, Running' })).not.toBeInTheDocument()
    // The live line follows the last message of the turn.
    expect(transcript.querySelectorAll('.thread-message')[1]!.compareDocumentPosition(liveRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(line)
    expect(line).toHaveAttribute('aria-expanded', 'true')
    const steps = document.getElementById(line.getAttribute('aria-controls')!)!
    const test = within(steps).getByRole('button', { name: 'Run the tests, npm test, Running' })
    expect(test).toHaveTextContent('Running 8s')
    // The step running now is marked as the plan marks its item in progress, and no other row is.
    expect(steps.querySelectorAll('.thread-activity__row[data-now]')).toHaveLength(1)
    expect(test.closest('.thread-activity__row')).toHaveAttribute('data-now')
    expect(within(steps).getByRole('button', { name: 'Install packages, npm ci, completed in 9.0s' })).toBeVisible()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(test).toHaveTextContent('Running 9s')
    // A running step keeps its own clock; the line above it still has none.
    expect(liveRow.querySelector('.thread-activity-live__line [data-elapsed]')).toBeNull()
  })

  it('folds the steps back on Escape, inside them or on the line, with focus on the line', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ status: 'running', activities: running() }))
    const line = within(transcript).getByRole('button', { name: 'Working, 2 steps so far' })
    await user.click(line)
    const row = within(transcript).getByRole('button', { name: 'Install packages, npm ci, completed in 9.0s' })
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(row).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(line).toHaveFocus()
    expect(within(transcript).queryByRole('button', { name: 'Install packages, npm ci, completed in 9.0s' })).not.toBeInTheDocument()
  })

  it('starts every turn’s steps as the user last left any of them, after a restart too', () => {
    const { live, transcript } = mount(stateWith({ status: 'running', activities: running() }))
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 2 steps so far' }))
    const publish = (patch: Partial<AgentThread>): void => act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD ? { ...thread, ...patch } : thread) } })
    })
    publish({ status: 'idle', activities: running().map(item => item.kind === 'turn' ? { ...item, status: 'completed', completedAt: iso(0) } : { ...item, status: 'completed' }) })
    // Opened while it ran, the finished turn's fold and its group open too.
    const fold = within(transcript).getByRole('button', { name: /^Worked for/u })
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    expect(within(transcript).getByRole('button', { name: /^Install packages, npm ci, completed/u })).toBeVisible()
    // Folded by hand, the next turn starts folded.
    fireEvent.click(fold)
    expect(localStorage.getItem('sotto.threads.stepsOpen')).toBe('false')
    publish({ status: 'running', activities: [...live.state.host.threads.find(thread => thread.id === THREAD)!.activities!,
      lifecycle({ turnId: 'turn-2', status: 'running', startedAt: iso(0) }), activity({ id: 'next', turnId: 'turn-2', command: 'git status' })] })
    expect(within(transcript).getByRole('button', { name: 'Working, 1 step so far' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(transcript).queryByRole('button', { name: /^git status/u })).not.toBeInTheDocument()
    // What the user last chose outlives the window.
    cleanup()
    localStorage.setItem('sotto.threads.stepsOpen', 'true')
    const again = mount(stateWith({ status: 'running', activities: running() }))
    expect(within(again.transcript).getByRole('button', { name: 'Working, 2 steps so far' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('says only its words until the turn reports a step, then offers the steps', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { live, transcript } = mount(stateWith({ status: 'running', activities: [lifecycle({ status: 'running', startedAt: iso(-65_000) })] }))
    const liveRow = (): HTMLElement => within(transcript).getByTestId('thread-activity-live')
    expect(liveRow()).toHaveTextContent(/^Combing the desertWorking$/)
    expect(within(liveRow()).queryByRole('button')).not.toBeInTheDocument()
    act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD
        ? { ...thread, activities: [...thread.activities!, activity({ id: 'read', command: 'git diff', durationMs: 300 })] } : thread) } })
    })
    expect(within(liveRow()).getByRole('button', { name: 'Working, 1 step so far' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('stops the clocks and says when work was last seen while the provider is disconnected', () => {
    const { transcript } = mount(stateWith({ status: 'running', activities: running() }, false))
    const liveRow = within(transcript).getByTestId('thread-activity-live')
    expect(liveRow).toHaveTextContent('Last seen working')
    expect(liveRow.querySelector('.thread-activity-live__word')).toBeNull()
    expect(liveRow.querySelector('.thread-activity-live__line [data-elapsed]')).toBeNull()
    fireEvent.click(within(liveRow).getByRole('button', { name: 'Last seen working, 2 steps so far' }))
    expect(within(transcript).getByRole('button', { name: 'Run the tests, npm test, Last seen running' }).querySelector('[data-elapsed]')).toBeNull()
  })

  it('shows the newest rows of a long turn once opened, and folds it once the turn completes', () => {
    const many = [lifecycle({ status: 'running', startedAt: iso(-1_000) }), ...Array.from({ length: 9 }, (_, index) => activity({ id: `c${index}`, command: `step ${index}` }))]
    const { live, transcript } = mount(stateWith({ status: 'running', activities: many }))
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 9 steps so far' }))
    expect(within(transcript).getByRole('button', { name: /step 8\b/ })).toBeVisible()
    expect(within(transcript).queryByRole('button', { name: /step 2\b/ })).not.toBeInTheDocument()
    fireEvent.click(within(transcript).getByRole('button', { name: 'Show 3 earlier' }))
    expect(within(transcript).getByRole('button', { name: /step 0\b/ })).toBeVisible()
    act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD
        ? { ...thread, status: 'idle', activities: many.map(item => item.id === 'lifecycle-turn-1' ? { ...item, status: 'completed', completedAt: iso(0) } : item) } : thread) } })
    })
    expect(within(transcript).queryByTestId('thread-activity-live')).not.toBeInTheDocument()
    // The steps were left open, so the finished turn's fold starts open.
    expect(within(transcript).getByRole('button', { name: 'Worked for 1.0s · 9 steps · Ran 9 commands' })).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('thinking as it streams', () => {
  it('shows a running Thinking row on the reasoning row, named for what it is, with its words as they grow', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { live, transcript } = mount(stateWith({ status: 'running', activities: [
      lifecycle({ status: 'running', startedAt: iso(-3_000) }),
      activity({ id: 'think', kind: 'reasoning', title: 'Thinking', status: 'running', startedAt: iso(-2_000), text: 'Reading the parser first' }),
    ] }))
    fireEvent.click(within(transcript).getByRole('button', { name: 'Working, 1 step so far' }))
    const row = within(transcript).getByRole('button', { name: 'Thinking, Reading the parser first, Running' })
    expect(row.closest('.thread-activity__row')).toHaveAttribute('data-kind', 'reasoning')
    expect(row).toHaveTextContent('Running 2s')
    act(() => {
      live.publish({ host: { ...live.state.host, threads: live.state.host.threads.map(thread => thread.id === THREAD
        ? { ...thread, activities: thread.activities!.map(item => item.id === 'think' ? { ...item, text: 'Reading the parser first\n\n**Then** the tests' } : item) } : thread) } })
    })
    fireEvent.click(within(transcript).getByRole('button', { name: 'Thinking, Reading the parser first, Running' }))
    expect(within(transcript).getByText('Then').tagName).toBe('STRONG')
  })

  it('shows thinking with no words as the row alone, and counts thoughts apart from reasoning summaries', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: [
      lifecycle({ status: 'completed', durationMs: 4_000, timingSource: 'provider' }),
      activity({ id: 'quiet', kind: 'reasoning', title: 'Thinking', durationMs: 1_200 }),
      activity({ id: 'said', kind: 'reasoning', title: 'Thinking', text: 'Check the build' }),
      activity({ id: 'why', kind: 'reasoning', title: 'Reasoning summary', text: 'Summary' }),
    ] }))
    await user.click(within(transcript).getByRole('button', { name: /^Worked/ }))
    // The group is all the fold holds, so its rows stand under the line, and it keeps its counts as its name.
    expect(within(transcript).getByRole('region', { name: '1 reasoning summary, thought 2 times' })).toBeVisible()
    const quiet = within(transcript).getByRole('group', { name: 'Thinking, completed in 1.2s' })
    expect(quiet.closest('.thread-activity__row')).toHaveAttribute('data-kind', 'reasoning')
  })
})

describe('honest detail', () => {
  it('shows subagent lifecycle without identities or controls, and only the provider’s reasoning summary', async () => {
    const user = userEvent.setup()
    const { transcript } = mount(stateWith({ activities: [
      activity({ id: 'agents', kind: 'subagent', title: 'spawnAgent', text: 'Check the WAV parser', status: 'completed',
        agents: [{ id: 'codex-agent-7f3e', status: 'running', message: 'Reading parser' }, { id: 'codex-agent-99aa', status: 'errored' }] }),
      activity({ id: 'why', kind: 'reasoning', title: 'Reasoning summary', text: '**Checking the parser**\n\nThe WAV header comes first.' }),
      activity({ id: 'lost', command: 'git status', status: 'unknown', truncated: true, output: 'On branch' }),
    ] }))
    await user.click(within(transcript).getByRole('button', { name: /^Worked/ }))
    expect(within(transcript).getByRole('region', { name: 'Ran 1 command, 1 agent action, 1 reasoning summary' })).toBeVisible()
    await user.click(within(transcript).getByRole('button', { name: 'Spawn agent, 2 agents, completed' }))
    const agents = within(transcript).getByRole('list', { name: 'Agents' })
    expect(agents).toHaveTextContent('Agent 1RunningReading parserAgent 2Failed')
    expect(transcript).not.toHaveTextContent('codex-agent-7f3e')
    expect(within(agents).queryAllByRole('button')).toHaveLength(0)
    expect(within(agents).queryAllByRole('link')).toHaveLength(0)

    // The row reads as the summary's heading, with no "Reasoning summary" run into it; assistive tech still hears what it is.
    // Open, the body says the rest and not the heading again.
    const why = within(transcript).getByRole('button', { name: 'Reasoning summary, Checking the parser, completed' })
    expect(why).toHaveTextContent(/^Checking the parser$/u)
    await user.click(why)
    const said = document.getElementById(why.getAttribute('aria-controls')!)!
    expect(said).toHaveTextContent(/^The WAV header comes first\.$/u)

    const unknown = within(transcript).getByRole('button', { name: 'Check git status, git status, Outcome unknown' })
    await user.click(unknown)
    expect(document.getElementById(unknown.getAttribute('aria-controls')!)).toHaveTextContent('Some details were not kept.')
    expect(unknown).toHaveAccessibleDescription('Time not recorded')
  })

  it('restores activity with earlier history only when that page is shown', () => {
    const messages = Array.from({ length: 90 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, text: `History ${index}`, createdAt: iso(index) }))
    const { transcript } = mount(stateWith({ messages, activities: [
      activity({ id: 'old', afterMessageId: 'm2', command: 'old command' }),
      activity({ id: 'new', turnId: 'turn-2', afterMessageId: 'm88', command: 'new command' }),
    ] }))
    // Each turn with work folds it under its own line.
    expect(transcript.querySelectorAll('.thread-work')).toHaveLength(1)
    fireEvent.click(within(transcript).getByRole('button', { name: 'Show earlier messages (10)' }))
    expect(transcript.querySelectorAll('.thread-work')).toHaveLength(2)
  })
})
