import { NOW, stateFixture } from '../../../fixtures/renderer/threadsViewHarness'
import { describe, expect, it } from 'vitest'
import { describeThreads, groupThreads, listThreads, providerKey } from '../../../../src/renderer/src/agents/threadFacts'

describe('thread grouping and states from Sotto state', () => {
  it('groups explicit settled work separately from open idle and running threads', () => {
    const groups = groupThreads(describeThreads(stateFixture(), NOW), NOW)
    expect(groups.map(group => [group.label, group.rows.map(entry => entry.thread.title)])).toEqual([
      ['Unsettled', ['Visual gate flake', 'Footer links', 'Weekly note', 'Grok voice previews', 'Streaming WAV stall']],
      ['Settled', ['Release notes 1.4', 'Thread routing', 'Notes cleanup', 'Benchmark rerun']],
    ])
  })

  it('derives the state of a row from the queue, the assignment and the thread status, never from the provider', () => {
    const state = stateFixture()
    const rows = describeThreads(state, NOW)
    const byTitle = (title: string) => rows.find(entry => entry.thread.title === title)!
    expect(byTitle('Visual gate flake')).toMatchObject({ state: 'needs', stateLabel: 'Needs your approval', waitingFor: 'approval', provider: 'Claude', providerKey: 'claude', management: 'managed', attention: true })
    expect(byTitle('Visual gate flake').request?.requestId).toBe('visual-gate-permission')
    expect(byTitle('Footer links')).toMatchObject({ state: 'working', stateLabel: 'Working', provider: 'Codex', providerKey: 'codex', attention: false })
    expect(byTitle('Streaming WAV stall')).toMatchObject({ state: 'stopped', stateLabel: 'Stopped', management: 'stopped' })
    expect(byTitle('Streaming WAV stall').sentence).toMatch(/^Stopped at the follow-up limit\./u)
    expect(byTitle('Release notes 1.4')).toMatchObject({ state: 'done', stateLabel: 'Settled' })
    expect(byTitle('Notes cleanup')).toMatchObject({ state: 'done', management: 'none', assignment: undefined, providerKey: 'grok' })
    // The card under an open row is your side of the thread: the sentence already carries the provider's.
    expect(byTitle('Weekly note').lastMessage).toMatchObject({ who: 'Sotto', text: expect.stringMatching(/^It is Friday\./u) })
    expect(byTitle('Footer links').lastMessage).toMatchObject({ who: 'You', at: Date.UTC(2026, 6, 12, 19, 38) })
    // A thread with no user message yet has no card.
    const weekly = state.host.threads.find(entry => entry.id === 'weekly-note')!
    weekly.messages = weekly.messages.slice(1)
    expect(describeThreads(state, NOW).find(entry => entry.thread.id === 'weekly-note')?.lastMessage).toBeUndefined()
  })

  it('keys the badge from the provider field, not the model display name, and falls back to a neutral badge', () => {
    expect(providerKey('Claude')).toBe('claude')
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

  it('ranks a manual takeover above a stale stop so the row never reads as stopped once you took over', () => {
    const state = stateFixture()
    const taken = state.assignments.find(entry => entry.threadId === 'wav-stall')!
    taken.mode = 'manual'
    const row = describeThreads(state, NOW).find(entry => entry.thread.id === 'wav-stall')!
    expect(row).toMatchObject({ state: 'done', stateLabel: 'Done', management: 'manual' })
    expect(row.sentence).not.toMatch(/stopped/iu)
    expect(row.facts.rest).toMatch(/^You took over in Codex; Sotto is watching, 5 of 5 follow-ups used\./u)
  })

  it('lists attention rows regardless of the query and matches the whole row otherwise', () => {
    const rows = describeThreads(stateFixture(), NOW)
    const titles = (entries: readonly { readonly thread: { readonly title: string } }[]) => entries.map(entry => entry.thread.title)
    const sotto = listThreads(rows, 'sotto-site')
    expect(titles(sotto.matching)).toEqual(['Footer links'])
    expect(titles(sotto.listed)).toEqual(['Visual gate flake', 'Footer links'])
    // The facts line and the last message text count as part of the row.
    expect(titles(listThreads(rows, 'typed prompt').matching)).toEqual(['Weekly note', 'Grok voice previews', 'Thread routing'])
    expect(titles(listThreads(rows, 'GPT-5.4').matching)).toEqual(['Footer links', 'Release notes 1.4', 'Streaming WAV stall'])
    expect(titles(listThreads(rows, 'Tidy the notes folder').matching)).toEqual(['Notes cleanup'])
    expect(titles(listThreads(rows, 'deploy').matching)).toEqual([])
    expect(titles(listThreads(rows, 'deploy').listed)).toEqual(['Visual gate flake'])
    expect(listThreads(rows, '  ').listed).toHaveLength(9)
  })

  it('treats a blocked queue item as needing you and a user pause as paused, and a manual assignment as yours', () => {
    const state = stateFixture()
    state.host.threads.find(thread => thread.id === 'release-notes')!.settledOverride = 'active'
    state.queue.push({ id: 'release-notes:release-notes-2:blocked', threadId: 'release-notes', kind: 'blocked', text: 'Scope changed. Decide whether to keep going.', createdAt: new Date(NOW).toISOString(), deferred: false })
    const paused = state.assignments.find(entry => entry.threadId === 'grok-previews')!
    paused.paused = true
    const manual = state.assignments.find(entry => entry.threadId === 'thread-routing')!
    manual.mode = 'manual'
    const rows = describeThreads(state, NOW)
    expect(rows.find(entry => entry.thread.id === 'release-notes')).toMatchObject({ state: 'needs', sentence: 'Scope changed. Decide whether to keep going.', request: undefined })
    expect(rows.find(entry => entry.thread.id === 'grok-previews')).toMatchObject({ state: 'done', stateLabel: 'Paused', management: 'paused' })
    expect(rows.find(entry => entry.thread.id === 'thread-routing')).toMatchObject({ management: 'manual' })
  })
})
