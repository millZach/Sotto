import React from 'react'
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentState, AgentThread } from '../../../../src/shared/agents'
import type { DelegatedView, DelegationCheckReply } from '../../../../src/shared/delegation'
import { E2E_THREADS_NOW } from '../../../../src/shared/e2e'
import { DelegationWorldProvider, delegationsByTurn, useDelegationWorld, type DelegationWorld } from '../../../../src/renderer/src/agents/DelegatedWork'
import { trayLines } from '../../../../src/renderer/src/agents/CheckReply'
import { delegatedKind, delegatedState, delegatedSummary } from '../../../../src/renderer/src/agents/delegationWords'
import { MessageList, type ActivityContext } from '../../../../src/renderer/src/agents/ThreadTranscript'
import { placeActivities } from '../../../../src/renderer/src/agents/threadActivityView'
import { useOptionalApp, type AppContextValue } from '../../../../src/renderer/src/state/AppContext'

vi.mock('../../../../src/renderer/src/state/AppContext', async importOriginal => ({ ...await importOriginal<typeof import('../../../../src/renderer/src/state/AppContext')>(), useOptionalApp: vi.fn() }))

/**
 * A check's reply on its row of delegated work (#1312, Zach's pick C on October 28, 2026, variant C of
 * docs/prototypes/check-reply-card-prototype.html): the row says Check, quotes the reply's first line as the thread's,
 * and reads the rest into a tray on a press. Only where the Owl list turns Work across machines on.
 */
function owl(checks: boolean): void {
  vi.mocked(useOptionalApp).mockReturnValue({ update: { currentVersion: '0.1.37-owl.20261012.1', phase: { phase: 'up-to-date' }, checkedAt: null,
    owlFeatures: { watcher: true, 'thread-delegation': true, 'cross-machine-work': checks } } } as unknown as AppContextValue)
}

const NOW = E2E_THREADS_NOW
const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
const FAILED = ['Failed: 2 of 1,214 tests.', '1,209 passed, 2 failed, 3 skipped, in 4 min 38 s.', '', 'Failing:', 'tests/unit/agents/checkQueue.test.ts:212  Stop on a waiting check'].join('\n')
const messages: AgentMessage[] = [
  { id: 'ask', role: 'user', text: 'Run the unit suite on forge, and the full suite with logs here.', createdAt: at(30) },
  { id: 'step', role: 'assistant', text: 'Handing the checks out.', createdAt: at(29) },
  { id: 'final', role: 'assistant', text: 'forge\'s unit suite failed two tests.', createdAt: at(10) },
]
const context: ActivityContext = { liveTurn: null, running: false, connected: true, provider: 'claude', onDisclosure: () => undefined }
const thread = (id: string, title: string, patch: Partial<AgentThread> = {}): AgentThread =>
  ({ id, title, projectId: 'workshop', modelId: 'claude:opus', providerId: 'claude', status: 'idle', messages: [], requests: [], ...patch })
const threads = [thread('fail', 'Unit suite after the Stop fix', { remoteHost: true }), thread('cut', 'Full suite with logs', { providerId: 'codex' }),
  thread('wait', 'Unit suite again on forge', { remoteHost: true, status: 'running' }), thread('build', 'Let Stop take a waiting check out of its queue', { providerId: 'codex' }),
  thread('lost', 'Playwright specs for the machine panel')]
function view(thread: string, patch: Partial<DelegatedView> = {}): DelegatedView {
  return { id: crypto.randomUUID(), thread, action: 'start', work: 'building', rootUserMessageId: 'ask', anchorMessageId: 'ask', briefMessageId: `${thread}-brief`,
    outcome: 'answered', outcomeAt: at(12), told: true, createdAt: at(20), wait: { seconds: 300, startedAt: at(20), wentOnAt: at(15) }, waiting: false, ...patch }
}
const failed = view('fail', { check: true, checkReply: { excerpt: 'Failed: 2 of 1,214 tests.', truncated: false } })
const cut = view('cut', { check: true, checkReply: { excerpt: 'Failed: 37 of 1,214 tests.', truncated: true } })
const waiting = view('wait', { check: true, outcome: 'working', outcomeAt: undefined, wait: { seconds: 60, startedAt: at(5), wentOnAt: at(4) } })
const building = view('build')
const lost = view('lost', { check: true, checkReply: { unavailable: true } })

function world(replies: Record<string, DelegationCheckReply>, open = vi.fn()) {
  const asked: string[] = []
  const shown: DelegationWorld = { thread: id => threads.find(item => item.id === id), hostName: item => item.remoteHost ? 'forge' : 'This computer', open, liveClock: false, now: NOW,
    checkReply: async id => { asked.push(id); return replies[id] ?? null } }
  return { world: shown, asked, open }
}
function mount(views: DelegatedView[], shown: DelegationWorld) {
  render(<DelegationWorldProvider world={shown}><MessageList messages={messages} provider="Claude Code" running={false} placement={placeActivities(messages, messages, [])}
    context={context} delegations={delegationsByTurn(views, messages)} /></DelegationWorldProvider>)
  const fold = screen.getByRole('button', { name: /^Worked for/u })
  return { fold, unfold: () => { if (fold.getAttribute('aria-expanded') !== 'true') fireEvent.click(fold) } }
}
const row = (name: string): HTMLElement => screen.getByRole('listitem', { name })

beforeEach(() => { vi.mocked(useOptionalApp).mockReset(); owl(true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('a check\'s row of delegated work', () => {
  it('says Check with a flask, quotes the first line of its reply as the thread\'s, and stays Answered', () => {
    const f = mount([building, failed, cut, waiting, lost], world({}).world)
    // Folded, the Worked for line counts checks as checks.
    expect(f.fold).toHaveTextContent('· 1 delegated thread · 4 checks')
    f.unfold()
    const check = row('Check: Unit suite after the Stop fix, Answered')
    expect(check.querySelector('.delegated-work__kind')).toHaveTextContent(/^Check$/u)
    expect(check.querySelector('.delegated-work__glyph')).toHaveClass('lucide-flask-conical')
    // The outcome stays Answered, in the outcome's own colour: nothing says Passed or Failed but the thread's quoted words.
    expect(check.querySelector('.delegated-work__state')).toHaveTextContent(/^Answered$/u)
    expect(check).toHaveAttribute('data-state', 'answered')
    const excerpt = check.querySelector('.check-excerpt')!
    expect(excerpt).toHaveTextContent('It replied Failed: 2 of 1,214 tests. Read its reply')
    expect(excerpt.querySelector('q')).toHaveTextContent(/^Failed: 2 of 1,214 tests\.$/u)
    expect(excerpt.querySelector('q')).toHaveAttribute('title', 'Failed: 2 of 1,214 tests.')
    // It is the row's second line: after its name and state, before its provider and machine.
    expect(excerpt.compareDocumentPosition(check.querySelector('.delegated-work__meta')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(check).getByRole('button', { name: 'Read the reply from Unit suite after the Stop fix, the check on forge' })).toHaveAttribute('aria-expanded', 'false')
    expect(check).toHaveTextContent('Answered in 8 min, after this thread went on. This thread has been told.')
    // A reply Sotto cut at 32 KiB says so on its row; one on this computer is the check on this computer.
    const long = row('Check: Full suite with logs, Answered')
    expect(long.querySelector('.check-excerpt')).toHaveTextContent('It replied Failed: 37 of 1,214 tests. · cut at 32 KiB Read its reply')
    expect(within(long).getByRole('button', { name: 'Read the reply from Full suite with logs, the check on this computer' })).toBeInTheDocument()
    // A kind of work that is no check keeps its own word and mark, and quotes nothing.
    const other = row('Building: Let Stop take a waiting check out of its queue, Answered')
    expect(other.querySelector('.delegated-work__glyph')).toHaveClass('lucide-git-fork')
    expect(other.querySelector('.check-excerpt, .check-unkept')).toBeNull()
  })

  it('keeps a waiting check\'s card as it is, with no queue line and no reply', () => {
    const f = mount([waiting], world({}).world)
    f.unfold()
    const check = row('Check: Unit suite again on forge, Working')
    expect(check.querySelector('.check-excerpt, .check-unkept')).toBeNull()
    expect(check).not.toHaveTextContent(/ahead|Waiting for/u)
    expect(check).toHaveTextContent('This thread waited 1 min, then went on. The answer comes back as a wake-up.')
  })

  it('says a reply that was not kept here in a sentence, with no tray to open', () => {
    const f = mount([lost], world({}).world)
    f.unfold()
    const check = row('Check: Playwright specs for the machine panel, Answered')
    expect(check.querySelector('.check-unkept')).toHaveTextContent("Its reply wasn't kept here. Open the check to read it in its thread.")
    expect(within(check).queryByRole('button', { name: /Read the reply/u })).toBeNull()
  })

  it('draws the card as before where Work across machines is off, as on stable, whatever the read carries', () => {
    owl(false)
    const f = mount([building, failed, lost], world({}).world)
    expect(f.fold).toHaveTextContent('· 3 delegated threads')
    f.unfold()
    const check = row('Building: Unit suite after the Stop fix, Answered')
    expect(check.querySelector('.delegated-work__glyph')).toHaveClass('lucide-git-fork')
    expect(document.querySelector('.check-excerpt, .check-unkept, [data-check]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Read the reply/u })).toBeNull()
  })

  it('words a check, its state and its count without reading anything from its reply', () => {
    expect(delegatedKind('code-review', 'codex', true)).toBe('check')
    expect(delegatedKind('building', 'codex')).toBe('work')
    // An answered check is Answered, never Returned as a review is.
    expect(delegatedState(failed, 'check', false)).toEqual({ id: 'answered', word: 'Answered' })
    const of = () => ({ providerId: 'claude' as const, requests: [] })
    expect(delegatedSummary([failed], of, true)).toBe('1 check')
    expect(delegatedSummary([building, failed, cut], of, true)).toBe('1 delegated thread · 2 checks')
    expect(delegatedSummary([building, failed, cut], of)).toBe('3 delegated threads')
  })
})

describe('the tray a check\'s reply opens in', () => {
  it('reads the reply on a press and shows it in the thread\'s words, then Escape returns focus to Read its reply', async () => {
    const f = world({ [failed.id]: { delegation: failed.id, text: FAILED, truncated: false } })
    mount([failed], f.world).unfold()
    expect(f.asked).toEqual([])
    const read = screen.getByRole('button', { name: 'Read the reply from Unit suite after the Stop fix, the check on forge' })
    read.focus()
    fireEvent.click(read)
    // The tray opens once main has given the reply, never empty while it reads.
    const tray = await screen.findByRole('dialog', { name: /^Unit suite after the Stop fix/u })
    expect(f.asked).toEqual([failed.id])
    expect(tray).toHaveFocus()
    expect(read).toHaveAttribute('aria-expanded', 'true')
    expect(read).toHaveAttribute('aria-controls', tray.id)
    expect(row('Check: Unit suite after the Stop fix, Answered')).toHaveAttribute('data-tray-open')
    expect(tray.querySelector('.check-tray__who')).toHaveTextContent(/^Unit suite after the Stop fixIts reply, in its own words, on forge · \d{1,2}:\d{2}\s?[ap]m$/u)
    expect(tray.querySelector('.check-pre')?.textContent).toBe(FAILED)
    expect(tray.querySelector('.check-tray__foot')).toHaveTextContent("That is all of its reply.Open the check")
    // Nothing in it is coloured or marked by what the reply says: no pass or fail of Sotto's own.
    expect(tray.querySelectorAll('svg')).toHaveLength(1)
    fireEvent.keyDown(tray, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(read).toHaveFocus()
    expect(read).toHaveAttribute('aria-expanded', 'false')
    // Escape on the control closes it too, before the Worked for fold it sits in; a second Escape folds the turn.
    fireEvent.click(read)
    await screen.findByRole('dialog')
    fireEvent.keyDown(read, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^Worked for/u })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(read, { key: 'Escape' })
    expect(screen.getByRole('button', { name: /^Worked for/u })).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes with Close or a second press, one tray at a time, and Open the check opens the check\'s thread', async () => {
    const f = world({ [failed.id]: { delegation: failed.id, text: FAILED, truncated: false }, [cut.id]: { delegation: cut.id, text: 'Failed: 37 of 1,214 tests.', truncated: true } })
    mount([failed, cut], f.world).unfold()
    const first = screen.getByRole('button', { name: /^Read the reply from Unit suite after the Stop fix/u })
    const second = screen.getByRole('button', { name: /^Read the reply from Full suite with logs/u })
    fireEvent.click(first)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close the reply' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(first).toHaveFocus()
    fireEvent.click(first)
    await screen.findByRole('dialog')
    fireEvent.click(first)
    expect(screen.queryByRole('dialog')).toBeNull()
    // Opening another row's closes the first: one tray, over the transcript's bottom.
    fireEvent.click(first)
    await screen.findByRole('dialog', { name: /^Unit suite after the Stop fix/u })
    fireEvent.click(second)
    const tray = await screen.findByRole('dialog', { name: /^Full suite with logs/u })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(tray).toHaveTextContent('Its reply, in its own words, on this computer')
    expect(tray.querySelector('.check-tray__foot')).toHaveTextContent(
      "Its reply was longer than 32 KiB, so this thread was given only the first 32 KiB. All of it is in the check's thread.Open the check")
    fireEvent.click(within(tray).getByRole('button', { name: 'Open Full suite with logs, the check on this computer, to read all of its reply' }))
    expect(f.open).toHaveBeenCalledWith('cut')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the reply\'s first sixty lines and says how many more are in its thread', async () => {
    const long = ['Failed: 3 of 9 tests.', ...Array.from({ length: 62 }, (_, index) => index === 30 ? '' : `line ${index}`)].join('\n')
    expect(trayLines(long)).toMatchObject({ lines: 60, more: true, left: 3 })
    expect(trayLines('a\r\nb')).toEqual({ shown: 'a\nb', lines: 2, more: false, left: 0 })
    const shown = world({ [failed.id]: { delegation: failed.id, text: long, truncated: false } })
    mount([failed], shown.world).unfold()
    fireEvent.click(screen.getByRole('button', { name: /^Read the reply from Unit suite after the Stop fix/u }))
    const tray = await screen.findByRole('dialog')
    const text = within(tray).getByRole('region', { name: 'The reply\'s first 60 lines' })
    expect(text).toHaveAttribute('tabindex', '0')
    expect(text.textContent!.split('\n')).toHaveLength(60)
    expect(tray.querySelector('.check-tray__foot')).toHaveTextContent('Its first 60 lines. 3 more lines are in its thread.Open the check')
  })

  it('turns the row to the not-kept line, with the focus on it and no tray, when main no longer holds the reply at the press (Sol on #1312)', async () => {
    // Main read the excerpt earlier; by the press, Keep local history is off or the reply is gone, so it answers nothing.
    const f = world({})
    mount([failed], f.world).unfold()
    const check = row('Check: Unit suite after the Stop fix, Answered')
    const read = within(check).getByRole('button', { name: /^Read the reply from/u })
    read.focus()
    fireEvent.click(read)
    await waitFor(() => expect(check.querySelector('.check-unkept')).toHaveTextContent("Its reply wasn't kept here. Open the check to read it in its thread."))
    expect(f.asked).toEqual([failed.id])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(check.querySelector('.check-excerpt')).toBeNull()
    expect(check).not.toHaveAttribute('data-tray-open')
    expect(check.querySelector('.check-unkept')).toHaveFocus()
    // A read that fails says the same, rather than open nothing or an empty tray.
    const failing = world({})
    cleanup()
    mount([cut], { ...failing.world, checkReply: async () => { throw new Error('No handler') } }).unfold()
    fireEvent.click(screen.getByRole('button', { name: /^Read the reply from Full suite with logs/u }))
    await waitFor(() => expect(row('Check: Full suite with logs, Answered').querySelector('.check-unkept')).toBeInTheDocument())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reads from the thread that delegated, with one reader however often the window\'s state moves, and none on stable', async () => {
    const checkReply = vi.fn(async ({ delegation }: { threadId: string; delegation: string }) => ({ delegation, text: FAILED, truncated: false }))
    vi.stubGlobal('sotto', { delegations: { checkReply } })
    const state = (title: string) => ({ host: { threads: threads.map(item => item.id === 'fail' ? { ...item, title } : item) }, connections: [] }) as unknown as AgentState
    const parent = thread('parent', 'Make Stop reach waiting checks')
    const hook = renderHook(({ shown }) => useDelegationWorld(shown, vi.fn(), NOW, { thread: parent, lastReadAt: undefined }), { initialProps: { shown: state('A') } })
    const first = hook.result.current.checkReply!
    // Another thread streaming publishes a new state: an open tray keeps its reader, so it reads its reply once.
    hook.rerender({ shown: state('B') })
    expect(hook.result.current.checkReply).toBe(first)
    await first(failed.id)
    expect(checkReply).toHaveBeenCalledWith({ threadId: 'parent', delegation: failed.id })
    owl(false)
    hook.rerender({ shown: state('C') })
    expect(hook.result.current.checkReply).toBeUndefined()
  })

  it('has nothing to open where main offers no read, as with Watcher off', () => {
    const { checkReply: _read, ...without } = world({}).world
    void _read
    mount([failed], without).unfold()
    const check = row('Check: Unit suite after the Stop fix, Answered')
    expect(check.querySelector('.check-excerpt')).toHaveTextContent(/^It replied Failed: 2 of 1,214 tests\.$/u)
    expect(within(check).queryByRole('button', { name: /Read the reply/u })).toBeNull()
  })
})
