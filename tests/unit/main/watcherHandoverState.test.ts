import { describe, expect, it } from 'vitest'
import { watcherHandoverState, type WatcherHandoverStateInput } from '../../../src/main/agents/watcherHandoverState'

const at = '2026-10-28T12:00:00.000Z'
const target = (threadId: string) => ({ hostId: '7f6c1d64-4d55-4b3c-9d32-2a8d2a2b3c11', threadId })
const empty: WatcherHandoverStateInput = { watching: [], mergeQueue: [], waitingOnUser: [], pending: [], carried: null, kept: { decisions: [], rules: [], issues: [] } }

describe('the state a new Watcher’s handover carries (#1735)', () => {
  it('says nothing when there is nothing to say', () => {
    expect(watcherHandoverState(empty)).toBe('')
    expect(watcherHandoverState({ ...empty, carried: { questions: [], moved: 0, unconfirmed: false, cannotStop: [] } })).toBe('')
  })

  it('says what only the replacement knows first, then what read_state works out, then what was kept', () => {
    const text = watcherHandoverState({
      watching: [{ target: target('footer'), title: 'Footer links', waitsOn: 'Its turn to finish.', host: 'forge',
        pullRequests: [{ number: 1735, url: 'https://github.com/millZach/Sotto/pull/1735', state: 'open', checks: 'passed' }] }],
      mergeQueue: [{ target: target('footer'), title: 'Footer links', pullRequest: { number: 1735, checks: 'passed' }, checksPassedAt: at }],
      waitingOnUser: [{ target: target('footer'), title: 'Footer links', waitsFor: 'permission' }],
      pending: [{ operationId: '4b8a3c86-1a0e-4b8e-9d3f-0d3a6b9d7e21', action: 'send', title: 'Footer links', state: 'queued' }],
      carried: { questions: ['Release from main?'], moved: 2, unconfirmed: true, cannotStop: [{ title: 'Nightly build', host: 'forge' }] },
      kept: { decisions: [{ id: 'd1', text: 'Whether to ship Friday', touchedAt: at }, { id: 'd2', text: 'Done one', touchedAt: at, closedAt: at }],
        rules: [{ id: 'r1', text: 'Never merge without GO MERGE', touchedAt: at }], issues: [{ id: 'i1', text: '#1735 New Watcher', touchedAt: at }] },
    })
    expect(text.startsWith('[How things stand as you take over, from Sotto’s own records. This is context, not a new request; read_state reads it again live.]')).toBe(true)
    const order = ['- Release from main?', '2 messages the user wrote', 'was never confirmed', '- “Nightly build” on forge',
      '- A send to “Footer links”, queued behind its turn (operation 4b8a3c86-1a0e-4b8e-9d3f-0d3a6b9d7e21)',
      '- “Footer links” on forge: Its turn to finish. Open pull requests: #1735, https://github.com/millZach/Sotto/pull/1735, checks passed.',
      'The merge queue', '- “Footer links” waits for a permission', '- d1: Whether to ship Friday', '- r1: Never merge without GO MERGE', '- i1: #1735 New Watcher']
    const places = order.map(part => text.indexOf(part))
    expect(places.every(place => place >= 0), JSON.stringify(places)).toBe(true)
    expect([...places].sort((left, right) => left - right)).toEqual(places)
    // A closed kept line is done, so it is not handed over.
    expect(text).not.toContain('Done one')
  })

  it('keeps each list short and each line on one line', () => {
    const many = Array.from({ length: 45 }, (_, index) => ({ operationId: `op-${index}`, action: 'start' as const, title: `Worker\n${index}`, state: 'uncertain' as const }))
    const text = watcherHandoverState({ ...empty, pending: many, carried: { questions: ['x'.repeat(900)], moved: 1, unconfirmed: false, cannotStop: [] } })
    expect(text).toContain('- And 5 more. read_state lists them all.')
    expect(text).toContain('“Worker 0”')
    expect(text).not.toContain('op-44')
    expect(text.split('\n').every(line => line.length <= 520)).toBe(true)
    expect(text).toContain('One message the user wrote to the last Watcher had not gone.')
  })
})
