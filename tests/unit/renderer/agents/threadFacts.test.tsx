// @vitest-environment node
import { i18n } from '@lingui/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeNeedsYou, describeThreads, groupThreads, listThreads, providerKey, threadDescriber, type ThreadDescriber } from '../../../../src/renderer/src/agents/threadFacts'
import { threadsStateFixture as stateFixture } from '../../../fixtures/agentState'
import { E2E_THREADS_NOW as NOW } from '../../../../src/shared/e2e'
import type { AgentRequest, AgentState, AgentThread } from '../../../../src/shared/agents'

// `describe` resolves each row's model once, so this counts the rows a describer described rather than handed back.
const resolved = vi.hoisted(() => ({ ids: [] as (string | null | undefined)[] }))
vi.mock('../../../../src/shared/modelCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/shared/modelCatalog')>()
  const resolveModel: typeof actual.resolveModel = (models, modelId) => { resolved.ids.push(modelId); return actual.resolveModel(models, modelId) }
  return { ...actual, resolveModel }
})

describe('thread grouping and states from Sotto state', () => {
  it('groups explicit settled work separately from open idle and running threads', () => {
    const groups = groupThreads(describeThreads(stateFixture(), NOW), NOW)
    expect(groups.map(group => [group.label, group.rows.map(entry => entry.thread.title)])).toEqual([
      ['Unsettled', ['Visual gate flake', 'Footer links', 'Weekly note', 'Grok voice previews', 'Streaming WAV stall']],
      ['Settled', ['Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun']],
    ])
  })

  it('keys the badge from the provider field, not the model display name, and falls back to a neutral badge', () => {
    expect(providerKey('Claude')).toBe('claude')
    expect(providerKey('Claude Code')).toBe('claude')
    expect(providerKey('anthropic')).toBe('claude')
    expect(providerKey('Codex')).toBe('codex')
    expect(providerKey('OpenAI')).toBe('codex')
    expect(providerKey('Grok')).toBe('grok')
    expect(providerKey('xAI')).toBe('grok')
    expect(providerKey('Unknown provider')).toBe('other')
    expect(providerKey('')).toBe('other')
    const state = stateFixture()
    state.host.models = state.host.models.map(model => model.id === 'claude:sonnet' ? { ...model, provider: 'Acme', name: 'Claude-ish 9' } : model)
    const visual = describeThreads(state, NOW).find(entry => entry.thread.id === 'visual-gate')!
    expect(visual).toMatchObject({ provider: 'Acme', providerKey: 'other' })
  })

  it('lists attention rows regardless of the query and matches the whole row otherwise', () => {
    const rows = describeThreads(stateFixture(), NOW)
    const titles = (entries: readonly { readonly thread: { readonly title: string } }[]) => entries.map(entry => entry.thread.title)
    const sotto = listThreads(rows, 'sotto-site')
    expect(titles(sotto.matching)).toEqual(['Footer links'])
    expect(titles(sotto.listed)).toEqual(['Visual gate flake', 'Footer links'])
    // The model and the last message text count as part of the row.
    expect(titles(listThreads(rows, 'GPT-5.4').matching)).toEqual(['Footer links', 'Release notes 1.4', 'Streaming WAV stall'])
    expect(titles(listThreads(rows, 'Tidy the notes folder').matching)).toEqual(['Notes cleanup'])
    expect(titles(listThreads(rows, 'deploy').matching)).toEqual([])
    expect(titles(listThreads(rows, 'deploy').listed)).toEqual(['Visual gate flake'])
    expect(listThreads(rows, '  ').listed).toHaveLength(9)
  })

})

it('derives the state of a row from requests and the thread status, never from the provider', () => {
    const state = stateFixture()
    const rows = describeThreads(state, NOW)
    const byTitle = (title: string) => rows.find(entry => entry.thread.title === title)!
    expect(byTitle('Visual gate flake')).toMatchObject({ state: 'needs', stateLabel: 'Needs your approval', waitingFor: 'approval', provider: 'Claude', providerKey: 'claude', attention: true })
    expect(byTitle('Visual gate flake').request?.requestId).toBe('visual-gate-permission')
    expect(byTitle('Footer links')).toMatchObject({ state: 'working', stateLabel: 'Working', provider: 'Codex', providerKey: 'codex', attention: false })
    expect(byTitle('Streaming WAV stall')).toMatchObject({ state: 'needs', stateLabel: 'Needs attention' })
    expect(byTitle('Streaming WAV stall').sentence).toContain('playback test')
    expect(byTitle('Release notes 1.4')).toMatchObject({ state: 'done', stateLabel: 'Settled' })
    expect(byTitle('Notes cleanup')).toMatchObject({ state: 'done', providerKey: 'grok' })
    // The card under an open row is your side of the thread: the sentence already carries the provider's.
    expect(byTitle('Weekly note').lastMessage).toMatchObject({ who: 'You', text: expect.stringMatching(/^It is Friday\./u) })
    expect(byTitle('Footer links').lastMessage).toMatchObject({ who: 'You', at: Date.UTC(2026, 6, 12, 19, 38) })
    // A thread with no user message yet has no card.
    const weekly = state.host.threads.find(entry => entry.id === 'weekly-note')!
    weekly.messages = weekly.messages.slice(1)
    expect(describeThreads(state, NOW).find(entry => entry.thread.id === 'weekly-note')?.lastMessage).toBeUndefined()
  })

describe('the Needs you queue (ADR-0135)', () => {
  const edit = (state: AgentState, id: string, change: (thread: AgentThread) => AgentThread): AgentState =>
    ({ ...state, host: { ...state.host, threads: state.host.threads.map(thread => thread.id === id ? change(thread) : thread) } })
  const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString()
  const structured = (patch: Partial<NonNullable<AgentRequest['questions']>[number]> = {}, request: Partial<AgentRequest> = {}): AgentRequest => ({
    id: 'q1', kind: 'question', text: 'Ship it?', options: [],
    questions: [{ id: 'q1', question: 'Friday or Monday?', options: [{ id: 'fri', label: 'Friday' }, { id: 'mon', label: 'Monday' }], multiSelect: false, allowFreeText: false, ...patch }],
    ...request,
  })
  const queueOf = (state: AgentState) => describeNeedsYou(describeThreads(state, NOW), NOW)
  const actionFor = (request: AgentRequest): string => {
    const state = edit(stateFixture(), 'visual-gate', thread => ({ ...thread, requests: [request] }))
    return queueOf(state).entries.find(entry => entry.row.thread.id === 'visual-gate')!.action
  }

  it('orders blocking first then oldest, shows three and counts the rest by kind', () => {
    let state = stateFixture()
    state = edit(state, 'visual-gate', thread => ({ ...thread, requests: [{ ...thread.requests[0]!, since: ago(12) }] }))
    state = edit(state, 'weekly-note', thread => ({ ...thread, requests: [{ id: 'w1', kind: 'permission', text: 'Run it?', options: [], since: ago(30) }] }))
    state = edit(state, 'footer-links', thread => ({ ...thread, requests: [structured({}, { since: ago(47) })] }))
    state = edit(state, 'grok-previews', thread => ({ ...thread, status: 'error', failureSince: ago(180) }))
    state = edit(state, 'wav-stall', thread => ({ ...thread, failureSince: ago(9) }))
    const queue = queueOf(state)
    expect(queue.entries.map(entry => [entry.row.thread.id, entry.kind, entry.action, entry.wait])).toEqual([
      ['weekly-note', 'approval', 'answer', '30 min'],
      ['visual-gate', 'approval', 'answer', '12 min'],
      ['footer-links', 'question', 'answer', '47 min'],
      ['grok-previews', 'failed', 'dismiss', '3 h'],
      ['wav-stall', 'failed', 'dismiss', '9 min'],
    ])
    expect(queue.shown.map(entry => entry.row.thread.id)).toEqual(['weekly-note', 'visual-gate', 'footer-links'])
    expect(queue.overflow).toEqual({ approval: 0, question: 0, failed: 2, total: 2 })
    expect(queue.oldestBlockingWait).toBe('30 min')
  })

  it('surfaces settled requests and never finished, prototype or seen-failure threads', () => {
    let state = stateFixture()
    // Settled in the workspace, not closed by its provider: its agent is still held still on the user.
    state = edit(state, 'release-notes', thread => ({ ...thread, settledOverride: null, settledAt: null, workspaceSettledAt: ago(60), requests: [{ id: 'r1', kind: 'permission', text: 'Publish?', options: [], since: ago(5) }] }))
    state = edit(state, 'thread-routing', thread => ({ ...thread, status: 'error', failureSeen: true }))
    state = edit(state, 'grok-previews', thread => ({ ...thread, finishedUnread: true }))
    state = edit(state, 'weekly-note', thread => ({ ...thread, prototypeReady: { source: 'reply:m1', pages: [{ token: 'a'.repeat(32), kind: 'file', name: 'x.html', start: 'x.html' }] } }))
    const queue = queueOf(state)
    const ids = queue.entries.map(entry => entry.row.thread.id)
    expect(ids).toContain('release-notes')
    expect(queue.entries.find(entry => entry.row.thread.id === 'release-notes')!.row.settledBy).toBe('thread')
    expect(ids).not.toContain('thread-routing')
    expect(ids).not.toContain('grok-previews')
    expect(ids).not.toContain('weekly-note')
  })

  it('offers an inline answer only for asks that fit, and opening for the rest', () => {
    const permission: AgentRequest = { id: 'p1', kind: 'permission', text: 'Run a command\nnpm test', options: [] }
    expect(actionFor(permission)).toBe('answer')
    expect(actionFor(structured())).toBe('answer')
    expect(actionFor(structured({ required: false }))).toBe('answer')
    // Permissions that cannot be judged whole from the sidebar.
    expect(actionFor({ ...permission, permissionChoices: [1, 2, 3, 4].map(n => ({ id: `c${n}`, label: `Choice ${n}`, kind: 'allow-once' as const })) })).toBe('open')
    expect(actionFor({ ...permission, permissionChoices: [{ id: 'c1', label: 'Allow', kind: 'allow-once', description: 'Because…' }] })).toBe('open')
    expect(actionFor({ ...permission, permissionChoices: [] })).toBe('open')
    expect(actionFor({ ...permission, context: { plan: { steps: 'Do things' } } })).toBe('open')
    expect(actionFor({ ...permission, context: { command: 'x'.repeat(161) } })).toBe('open')
    expect(actionFor({ ...permission, context: { details: 'Long output' } })).toBe('open')
    expect(actionFor({ ...permission, delivery: 'uncertain' })).toBe('open')
    // Questions that need their form, their pages, or the composer.
    expect(actionFor(structured({ multiSelect: true }))).toBe('open')
    expect(actionFor(structured({ allowFreeText: true }))).toBe('open')
    expect(actionFor(structured({ unavailableReason: 'Use the provider app' }))).toBe('open')
    expect(actionFor(structured({}, { questions: [structured().questions![0]!, { ...structured().questions![0]!, id: 'q2' }] }))).toBe('open')
    expect(actionFor(structured({}, { pages: [{ token: 'a'.repeat(32), kind: 'file', name: 'x.html', start: 'x.html' }] }))).toBe('open')
    expect(actionFor(structured({}, { linkMissing: true }))).toBe('open')
    expect(actionFor({ id: 'l1', kind: 'question', text: 'Which?', options: [{ id: 'a', label: 'A' }] })).toBe('open')
    expect(actionFor({ id: 'l2', kind: 'question', text: 'Say more', options: [] })).toBe('open')
  })

  it('says no wait without a stamp and orders unstamped entries by last activity', () => {
    let state = stateFixture()
    state = edit(state, 'weekly-note', thread => ({ ...thread, requests: [{ id: 'w1', kind: 'permission', text: 'Run it?', options: [] }] }))
    const approvals = queueOf(state).entries.filter(entry => entry.kind === 'approval')
    // Weekly note last moved at 19:33, the visual gate at 19:41: the older activity leads, and neither claims a wait.
    expect(approvals.map(entry => [entry.row.thread.id, entry.wait])).toEqual([['weekly-note', ''], ['visual-gate', '']])
    expect(approvals.every(entry => Number.isNaN(entry.waitingSince))).toBe(true)
    expect(queueOf(state).oldestBlockingWait).toBe('')
  })

  it('never answers a delegated wait from the thread it is reached from', () => {
    const row = describeThreads(stateFixture(), NOW).find(entry => entry.thread.id === 'visual-gate')!
    const queue = describeNeedsYou([{ ...row, waitingIn: 'Child thread' }], NOW)
    expect(queue.entries).toHaveLength(1)
    expect(queue.entries[0]).toMatchObject({ action: 'open', request: undefined })
  })
})

describe("a page's describer, which describes again only what an update could have changed", () => {
  const editHost = (state: AgentState, patch: Partial<AgentState['host']>): AgentState => ({ ...state, host: { ...state.host, ...patch } })
  /** The rows one call described, as `describeThreads` would, and how many threads it described rather than handed back. */
  const run = (describeRows: ThreadDescriber, state: AgentState, now: number, options?: { readonly continued?: boolean }) => {
    const expected = describeThreads(state, now, options)
    resolved.ids = []
    const rows = describeRows(state, now, options)
    expect(rows).toEqual(expected)
    return { rows, described: resolved.ids.length }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    if (i18n.locale !== 'en') i18n.loadAndActivate({ locale: 'en', messages: {} })
  })

  it('describes only a changed thread and hands back every other row as it was', () => {
    const describeRows = threadDescriber()
    const state = stateFixture()
    const first = run(describeRows, state, NOW)
    expect(first.described).toBe(state.host.threads.length)
    const next = editHost(state, { threads: state.host.threads.map(thread => thread.id === 'weekly-note' ? { ...thread, title: 'Weekly note, edited' } : thread) })
    const after = run(describeRows, next, NOW)
    expect(after.described).toBe(1)
    expect(after.rows.filter((row, index) => row !== first.rows[index]).map(row => row.thread.id)).toEqual(['weekly-note'])
    expect(run(describeRows, { ...next }, NOW)).toEqual({ rows: after.rows, described: 0 })
    expect(describeRows({ ...next }, NOW)).toBe(after.rows)
  })

  it("describes a thread again when its project, its host's catalog, the host's name or its connection changes", () => {
    const describeRows = threadDescriber()
    let state = stateFixture()
    const all = state.host.threads.length
    run(describeRows, state, NOW)
    const described = (next: AgentState): number => { state = next; return run(describeRows, next, NOW).described }
    // A renamed project re-describes its own threads, which then name it.
    const workshop = state.host.threads.filter(thread => thread.projectId === 'workshop').length
    expect(workshop).toBeGreaterThan(0)
    expect(described(editHost(state, { projects: state.host.projects.map(project => project.id === 'workshop' ? { ...project, title: 'Workshop, renamed' } : project) }))).toBe(workshop)
    expect(describeRows(state, NOW).find(row => row.thread.projectId === 'workshop')!.project?.title).toBe('Workshop, renamed')
    // A new catalog re-describes every thread of the host: a model's provider and name can move.
    expect(described(editHost(state, { models: state.host.models.map(model => model.id === 'claude:sonnet' ? { ...model, provider: 'Acme', name: 'Claude-ish 9' } : model) }))).toBe(all)
    expect(describeRows(state, NOW).find(row => row.thread.id === 'visual-gate')).toMatchObject({ provider: 'Acme', providerKey: 'other' })
    // The host's name and its connection are read by every row.
    expect(described(editHost(state, { name: 'Renamed host' }))).toBe(all)
    expect(described(editHost(state, { connected: false }))).toBe(all)
    expect(describeRows(state, NOW).every(row => !row.connected)).toBe(true)
    expect(described({ ...state })).toBe(0)
  })

  it("describes every thread again when continuing is turned on or off, or the language, its messages or the window's language change", () => {
    const describeRows = threadDescriber()
    const state = stateFixture()
    const all = state.host.threads.length
    const described = (options?: { readonly continued?: boolean }): number => run(describeRows, state, NOW, options).described
    expect(described()).toBe(all)
    expect(described({ continued: true })).toBe(all)
    expect(described({ continued: true })).toBe(0)
    expect(described({ continued: false })).toBe(all)
    i18n.loadAndActivate({ locale: 'fr', messages: {} })
    expect(described()).toBe(all)
    i18n.load('fr', {})
    expect(described()).toBe(all)
    expect(described()).toBe(0)
    // Every row's clock is formatted in the window's language and time zone.
    vi.stubGlobal('navigator', { language: 'de-DE' })
    expect(described()).toBe(all)
    expect(described()).toBe(0)
  })

  it('describes a working thread again when the clock moves, and no other', () => {
    const describeRows = threadDescriber()
    const state = stateFixture()
    const first = run(describeRows, state, NOW).rows
    const working = first.filter(row => row.state === 'working')
    expect(working.length).toBeGreaterThan(0)
    const later = run(describeRows, state, NOW + 61_000)
    expect(later.described).toBe(working.length)
    expect(later.rows.filter(row => row.state === 'working').map(row => row.when)).not.toEqual(working.map(row => row.when))
    for (const [index, row] of later.rows.entries()) if (row.state !== 'working') expect(row).toBe(first[index])
    // A clock moved back counts too: a working row's time is the clock it was described with, not the latest one.
    expect(run(describeRows, state, NOW).described).toBe(working.length)
  })

  it('forgets a thread that left and describes it afresh when it is back', () => {
    const describeRows = threadDescriber()
    const state = stateFixture()
    run(describeRows, state, NOW)
    expect(run(describeRows, editHost(state, { threads: state.host.threads.filter(thread => thread.id !== 'weekly-note') }), NOW).described).toBe(0)
    expect(run(describeRows, state, NOW).described).toBe(1)
  })
})
