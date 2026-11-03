// @vitest-environment node
/**
 * The arithmetic of the detail stream: what a delta may say, what it refuses to say, and what a window
 * holds after applying one.
 */
import { describe, expect, it } from 'vitest'
import { applyAgentThreadDetailDelta, diffAgentThreadDetail, foldAgentThreadDetailUpdates, mergeAgentThreadDetailUpdates, withAppendsWhole } from '../../../src/shared/agentThreadDetail'
import type { AgentActivity } from '../../../src/shared/agentActivity'
import type { AgentActivityDelta, AgentMessage, AgentThreadDetail, AgentThreadDetailDelta, AgentThreadDetailUpdate } from '../../../src/shared/agents'

const message = (id: string, text: string): AgentMessage =>
  ({ id, role: 'assistant', text, createdAt: '2026-01-01T00:00:00.000Z' })
const record = (id: string, patch: Partial<AgentActivity> = {}): AgentActivity =>
  ({ id, turnId: 'turn', sequence: 1, kind: 'command', status: 'running', title: 'npm test', ...patch })
const base = (messages: AgentMessage[], activities?: AgentActivity[]): AgentThreadDetail =>
  ({ threadId: 'workshop', revision: 4, messages, ...(activities === undefined ? {} : { activities }) })

describe('diffing the detail of one thread', () => {
  it('says a streaming message grew by a suffix', () => {
    const held = base([message('a', 'Pick'), message('b', 'Indigo')])
    const delta = diffAgentThreadDetail(held, { messages: [message('a', 'Pick'), message('b', 'Indigo it is.')] }, 5)
    expect(delta).toMatchObject({ baseRevision: 4, revision: 5, messageDeltas: [{ id: 'b', appendText: ' it is.' }] })
  })

  it('sends the whole message when the text was rewritten rather than extended', () => {
    const held = base([message('a', 'Indigo')])
    const delta = diffAgentThreadDetail(held, { messages: [message('a', 'Copper')] }, 5)!
    expect(delta.messageDeltas).toEqual([{ message: message('a', 'Copper') }])
  })

  it('refuses a history whose messages were removed or reordered', () => {
    const held = base([message('a', 'One'), message('b', 'Two')])
    expect(diffAgentThreadDetail(held, { messages: [message('a', 'One')] }, 5)).toBeNull()
    expect(diffAgentThreadDetail(held, { messages: [message('b', 'Two'), message('a', 'One')] }, 5)).toBeNull()
  })

  it('refuses a thread whose activity has appeared or gone away entirely', () => {
    expect(diffAgentThreadDetail(base([]), { messages: [], activities: [record('one')] }, 5)).toBeNull()
    expect(diffAgentThreadDetail(base([], []), { messages: [] }, 5)).toBeNull()
  })

  it('carries an activity record as it now stands, and the id of one that has gone', () => {
    const held = base([], [record('one'), record('two')])
    const delta = diffAgentThreadDetail(held, { messages: [], activities: [record('two', { status: 'completed' })] }, 5)!
    expect(delta.activityDeltas).toEqual([{ id: 'one', removed: true }, { record: record('two', { status: 'completed' }) }])
  })

  it('carries task classification changes without changing the historical identity or status', () => {
    const old = record('agent', { kind: 'subagent', status: 'completed' })
    const held = base([], [old])
    const next = { ...old, taskUpdatesExcluded: true }
    const delta = diffAgentThreadDetail(held, { messages: [], activities: [next] }, 5)!
    expect(delta.activityDeltas).toEqual([{ record: next }])
    expect(applyAgentThreadDetailDelta(held, delta)?.activities).toEqual([next])
  })

  it('carries a turn on the user’s own server that is tried again or let down while its status stays the same (ADR-0124)', () => {
    const server = { name: 'Sparks', model: 'DeepSeek V4.1 Flash', host: 'spark-head:8888' }
    const old = record('turn', { kind: 'turn', title: 'Working', ownServer: server })
    for (const ownServer of [{ ...server, attempt: 1, attempts: 10 }, { ...server, attempt: 3, attempts: 10 }]) {
      const next = { ...old, ownServer }
      const delta = diffAgentThreadDetail(base([], [old]), { messages: [], activities: [next] }, 5)!
      expect(delta.activityDeltas).toEqual([{ record: next }])
    }
    const failed = { ...old, status: 'failed' as const, ownServer: { ...server, failure: 'unreachable' as const } }
    expect(diffAgentThreadDetail(base([], [{ ...failed, ownServer: { ...server, failure: 'timeout' } }]), { messages: [], activities: [failed] }, 5)!.activityDeltas).toEqual([{ record: failed }])
  })

  it('copies what it carries, so the snapshot it builds never references the live thread', () => {
    const live = message('a', 'Indigo it is.')
    const delta = diffAgentThreadDetail(base([]), { messages: [live] }, 5)!
    expect(delta.messageDeltas[0]).toEqual({ message: live })
    expect((delta.messageDeltas[0] as { message: AgentMessage }).message).not.toBe(live)
  })
})

describe('applying a delta', () => {
  it('replaces only the message that changed', () => {
    const held = base([message('a', 'Pick'), message('b', 'Indigo')])
    const applied = applyAgentThreadDetailDelta(held, { threadId: 'workshop', baseRevision: 4, revision: 5,
      messageDeltas: [{ id: 'b', appendText: ' it is.' }], activityDeltas: [] })!
    expect(applied.messages[0]).toBe(held.messages[0])
    expect(applied.messages[1]).not.toBe(held.messages[1])
    expect(applied.messages[1]!.text).toBe('Indigo it is.')
    expect(applied.revision).toBe(5)
  })

  it('keeps an updated record in its place and puts a new one at the end', () => {
    const held = base([], [record('one'), record('two')])
    const applied = applyAgentThreadDetailDelta(held, { threadId: 'workshop', baseRevision: 4, revision: 5,
      messageDeltas: [], activityDeltas: [{ record: record('one', { status: 'completed' }) }, { record: record('three') }] })!
    expect(applied.activities!.map(item => item.id)).toEqual(['one', 'two', 'three'])
    expect(applied.activities![1]).toBe(held.activities![1])
  })

  it('refuses a delta measured from another revision or another thread', () => {
    const held = base([message('a', 'Pick')])
    const delta = { threadId: 'workshop', baseRevision: 3, revision: 5, messageDeltas: [], activityDeltas: [] }
    expect(applyAgentThreadDetailDelta(held, delta)).toBeNull()
    expect(applyAgentThreadDetailDelta(held, { ...delta, baseRevision: 4, threadId: 'docs' })).toBeNull()
  })
})

describe('merging two updates for one thread', () => {
  it('makes two appends to one message into one', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [{ id: 'a', appendText: ' one' }], activityDeltas: [] }
    const merged = mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, messageDeltas: [{ id: 'a', appendText: ' two' }] })
    expect(merged).toMatchObject({ baseRevision: 1, revision: 3, messageDeltas: [{ id: 'a', appendText: ' one two' }] })
  })

  it('keeps only the newest state of a record updated twice', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ record: record('one', { output: 'a' }) }] }
    const merged = mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, activityDeltas: [{ record: record('one', { output: 'ab' }) }] })
    expect(merged).toMatchObject({ activityDeltas: [{ record: { output: 'ab' } }] })
  })

  it('will not merge a delta that does not follow the one waiting, or one carrying a removal', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [] }
    expect(mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 7, revision: 8 })).toBeNull()
    expect(mergeAgentThreadDetailUpdates(first, { ...first, baseRevision: 2, revision: 3, activityDeltas: [{ id: 'one', removed: true }] })).toBeNull()
  })
})

describe('folding updates a host holds for a client that reads slowly (#1089)', () => {
  /** A seeded sequence, so a failure names the same deltas every run. */
  const random = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 }

  it('folds any run of deltas, removals among them, into one that applies to the same history', () => {
    for (const seed of [1, 7, 42, 1089]) {
      const next = random(seed)
      const start = base([message('reply', 'Hi')], Array.from({ length: 5 }, (_, index) => record('r' + index)))
      let stepped: AgentThreadDetail = start
      let folded: AgentThreadDetailUpdate | null = null
      for (let revision = 5; revision < 205; revision++) {
        const present = stepped.activities!.map(item => item.id)
        const activityDeltas: AgentActivityDelta[] = []
        // Remove a record or two, often the oldest as a long thread's window does, and add or update others, some of them
        // records removed earlier.
        // As a diff does, a delta names each record once.
        const named = new Set<string>()
        const name = (id: string): boolean => !named.has(id) && named.add(id) !== undefined
        if (present.length > 0 && next() < 0.6 && name(present[0]!)) activityDeltas.push({ id: present[0]!, removed: true })
        const other = present[Math.floor(next() * present.length)]
        if (other !== undefined && next() < 0.3 && name(other)) activityDeltas.push({ id: other, removed: true })
        for (let count = Math.floor(next() * 3); count > 0; count--) {
          const id = 'r' + Math.floor(next() * 12)
          if (name(id)) activityDeltas.push({ record: record(id, { title: 'at ' + revision }) })
        }
        const delta: AgentThreadDetailDelta = { threadId: 'workshop', baseRevision: revision - 1, revision, activityDeltas,
          messageDeltas: next() < 0.5 ? [{ id: 'reply', appendText: ' ' + revision }] : [] }
        stepped = applyAgentThreadDetailDelta(stepped, delta)!
        folded = folded === null ? delta : foldAgentThreadDetailUpdates(folded, delta)
        expect(folded).not.toBeNull()
      }
      expect(applyAgentThreadDetailDelta(start, folded as AgentThreadDetailDelta)).toEqual(stepped)
      // A record has at most a removal and then an upsert in the fold, however many deltas named it.
      const entries = new Map<string, number>()
      for (const item of (folded as AgentThreadDetailDelta).activityDeltas) { const id = 'record' in item ? item.record.id : item.id; entries.set(id, (entries.get(id) ?? 0) + 1) }
      expect(Math.max(...entries.values())).toBeLessThanOrEqual(2)
    }
  })

  it('takes a delta into a whole it follows, and folds nothing that does not follow', () => {
    const whole = base([message('a', 'Pick')], [record('one')])
    const delta: AgentThreadDetailDelta = { threadId: 'workshop', baseRevision: 4, revision: 5, messageDeltas: [{ id: 'a', appendText: ' one' }], activityDeltas: [{ id: 'one', removed: true }] }
    expect(foldAgentThreadDetailUpdates(whole, delta)).toEqual({ threadId: 'workshop', revision: 5, messages: [message('a', 'Pick one')], activities: [] })
    expect(foldAgentThreadDetailUpdates(delta, { ...delta, baseRevision: 9, revision: 10 })).toBeNull()
  })
})

// A record that changed at the end of a long thread, as a tool's output grows, was diffed and applied by reading every
// record of the thread into maps (#1248): the work grew with the thread's length, not with what changed.
describe('a change at the end of a long thread', () => {
  /** Records whose IDs count each read, a measure of the records the diff and the apply look at. */
  const counted = (count: number, reads: { ids: number }): AgentActivity[] => Array.from({ length: count }, (_, position) => {
    const record = { turnId: 't', sequence: position, kind: 'command', status: 'completed', title: `Command ${position}`, output: `${position}` } as AgentActivity
    Object.defineProperty(record, 'id', { enumerable: true, get: () => { reads.ids++; return `a${position}` } })
    return Object.freeze(record)
  })
  const readsFor = (count: number): { ids: number; whole: number; delta: AgentThreadDetailDelta } => {
    const reads = { ids: 0 }
    const activities = counted(count, reads)
    Object.freeze(activities)
    const base: AgentThreadDetail = { threadId: 'thread', revision: 1, messages: [message('m', 'Hi')], activities }
    const last = activities.at(-1)!
    const grown = Object.freeze({ ...last, id: last.id, output: `${last.output} and more` })
    const next = [...activities.slice(0, -1), grown]
    Object.freeze(next)
    reads.ids = 0
    const delta = diffAgentThreadDetail(base, { messages: base.messages, activities: next }, 2)!
    applyAgentThreadDetailDelta(base, delta)
    const ids = reads.ids
    // What a socket client is sent instead: the grown record whole, found in the history the delta leads to.
    reads.ids = 0
    withAppendsWhole(delta, next)
    return { ids, whole: reads.ids, delta }
  }

  it('reads the same few records with 200 records as with 2,000', () => {
    const short = readsFor(200), long = readsFor(2_000)
    expect(long.delta.activityDeltas).toEqual([{ id: 'a1999', appendOutput: ' and more' }])
    expect(long.ids).toBe(short.ids)
    expect(long.ids).toBeLessThan(20)
    expect(long.whole).toBe(short.whole)
    expect(long.whole).toBeLessThan(5)
  })
})

// A running command's record was sent whole for every chunk of output it grew by, so a 24 KB log crossed to the window as
// about 750 KB (October 30). The window is sent what the output or text grew by; every other reader the record whole.
describe('a record whose output or text only grew', () => {
  const grows = (before: Partial<AgentActivity>, after: Partial<AgentActivity>) =>
    diffAgentThreadDetail(base([], [record('build', before)]), { messages: [], activities: [record('build', after)] }, 5)!

  it('is sent as what its output, its text or both grew by', () => {
    expect(grows({ output: 'npm test\n' }, { output: 'npm test\n12 passed\n' }).activityDeltas).toEqual([{ id: 'build', appendOutput: '12 passed\n' }])
    expect(grows({ text: 'Reading' }, { text: 'Reading the log' }).activityDeltas).toEqual([{ id: 'build', appendText: ' the log' }])
    expect(grows({ output: 'a', text: 'b' }, { output: 'ab', text: 'bc' }).activityDeltas).toEqual([{ id: 'build', appendOutput: 'b', appendText: 'c' }])
  })

  it('is sent whole when anything else changed with it, or the output was rewritten, cut or begun', () => {
    const wholeRecord = (before: Partial<AgentActivity>, after: Partial<AgentActivity>) =>
      expect(grows(before, after).activityDeltas).toEqual([{ record: record('build', after) }])
    wholeRecord({ output: 'a' }, { output: 'ab', status: 'completed' })
    wholeRecord({ output: 'abc' }, { output: 'xbcd' })
    wholeRecord({ output: 'abc' }, { output: 'ab' })
    wholeRecord({}, { output: 'a' })
    wholeRecord({ output: 'a' }, { output: 'ab', text: 'rewritten' })
    // The signature tells these apart only by length; an append would leave the window with the old value at the new revision.
    wholeRecord({ kind: 'plan', text: 'Next', steps: [{ text: 'Test A', status: 'pending' }] }, { kind: 'plan', text: 'Next step', steps: [{ text: 'Test B', status: 'pending' }] })
    wholeRecord({ output: 'a', title: 'npm test' }, { output: 'ab', title: 'npm lint' })
    wholeRecord({ output: 'a', changes: [{ path: 'a.ts', kind: 'edit' }] }, { output: 'ab', changes: [{ path: 'b.ts', kind: 'edit' }] })
    wholeRecord({ output: 'a', command: 'npm test' }, { output: 'ab', command: 'npm lint' })
    // A nested part rebuilt with the same values is no change.
    const steps = (): AgentActivity['steps'] => [{ text: 'Test A', status: 'pending' }]
    expect(grows({ kind: 'plan', text: 'Next', steps: steps() }, { kind: 'plan', text: 'Next step', steps: steps() }).activityDeltas).toEqual([{ id: 'build', appendText: ' step' }])
  })

  it('leaves the window holding the record it would have been sent whole, and every other record as it was', () => {
    const held = base([], [record('one'), record('build', { output: 'a' })])
    const delta = diffAgentThreadDetail(held, { messages: [], activities: [record('one'), record('build', { output: 'abc' })] }, 5)!
    const applied = applyAgentThreadDetailDelta(held, delta)!
    expect(applied.activities).toEqual([record('one'), record('build', { output: 'abc' })])
    expect(applied.activities![0]).toBe(held.activities![0])
    expect(held.activities![1]!.output).toBe('a')
    // Many records at once take the other path through the apply; it gives the same answer.
    const many = base([], Array.from({ length: 12 }, (_, index) => record(`r${index}`, { output: 'x' })))
    const grown = many.activities!.map(item => ({ ...item, output: 'xy' }))
    const manyDelta = diffAgentThreadDetail(many, { messages: [], activities: grown }, 5)!
    expect(manyDelta.activityDeltas).toHaveLength(12)
    expect(applyAgentThreadDetailDelta(many, manyDelta)!.activities).toEqual(grown)
  })

  it('cannot be applied to a detail that does not hold the record', () => {
    const delta: AgentThreadDetailDelta = { threadId: 'workshop', baseRevision: 4, revision: 5, messageDeltas: [], activityDeltas: [{ id: 'build', appendOutput: 'b' }] }
    expect(applyAgentThreadDetailDelta(base([], [record('one')]), delta)).toBeNull()
  })

  it('joins appends that wait together, and an append to the whole record waiting ahead of it', () => {
    const first = { threadId: 'workshop', baseRevision: 1, revision: 2, messageDeltas: [], activityDeltas: [{ id: 'build', appendOutput: 'b' }] as AgentActivityDelta[] }
    const second = { ...first, baseRevision: 2, revision: 3, activityDeltas: [{ id: 'build', appendOutput: 'c', appendText: 'Note' }] }
    expect(mergeAgentThreadDetailUpdates(first, second)).toMatchObject({ revision: 3, activityDeltas: [{ id: 'build', appendOutput: 'bc', appendText: 'Note' }] })
    const whole = { ...first, activityDeltas: [{ record: record('build', { output: 'ab' }) }] }
    expect(mergeAgentThreadDetailUpdates(whole, second)).toMatchObject({ activityDeltas: [{ record: { id: 'build', output: 'abc', text: 'Note' } }] })
    expect(foldAgentThreadDetailUpdates(first, second)).toMatchObject({ activityDeltas: [{ id: 'build', appendOutput: 'bc', appendText: 'Note' }] })
    // A whole record after an append replaces it.
    expect(mergeAgentThreadDetailUpdates(first, { ...second, activityDeltas: [{ record: record('build', { status: 'completed' }) }] }))
      .toMatchObject({ activityDeltas: [{ record: { status: 'completed' } }] })
  })

  it('folds any run of appends, removals and whole records into one that applies to the same history', () => {
    let seed = 7
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    let appends = 0
    for (let run = 0; run < 100; run++) {
      const start = base([], [record('r0', { output: '' }), record('r1', { output: 'x' })])
      let stepped = start
      let folded: AgentThreadDetailUpdate | null = null
      for (let revision = 5; revision < 13; revision++) {
        const activities = stepped.activities!.flatMap(item => next() < 0.15 ? [] : [next() < 0.6 && item.output !== undefined
          ? { ...item, output: item.output + String.fromCharCode(97 + Math.floor(next() * 26)) } : next() < 0.2 ? { ...item, title: 'at ' + revision } : item])
        for (let count = Math.floor(next() * 2); count > 0; count--) {
          const id = 'r' + Math.floor(next() * 6)
          if (!activities.some(item => item.id === id)) activities.push(record(id, { output: '' }))
        }
        const delta = diffAgentThreadDetail({ ...stepped, revision: revision - 1 }, { messages: [], activities }, revision)
        if (delta === null) break
        appends += delta.activityDeltas.filter(item => !('record' in item) && !('removed' in item)).length
        stepped = applyAgentThreadDetailDelta({ ...stepped, revision: revision - 1 }, delta)!
        folded = folded === null ? delta : foldAgentThreadDetailUpdates(folded, delta)
        expect(folded).not.toBeNull()
      }
      if (folded !== null) expect(applyAgentThreadDetailDelta({ ...start, revision: (folded as AgentThreadDetailDelta).baseRevision }, folded as AgentThreadDetailDelta)!.activities).toEqual(stepped.activities)
    }
    expect(appends).toBeGreaterThan(100)
  })

  it('is sent to any reader other than the window as the record whole, read from the history the delta takes it to', () => {
    const held = base([], [record('one'), record('build', { output: 'a' })])
    const now = [record('one'), record('build', { output: 'abc' })]
    const delta = diffAgentThreadDetail(held, { messages: [], activities: now }, 5)!
    const expanded = withAppendsWhole(delta, now)!
    expect(expanded.activityDeltas).toEqual([{ record: record('build', { output: 'abc' }) }])
    expect((expanded.activityDeltas[0] as { record: AgentActivity }).record).not.toBe(now[1])
    expect(applyAgentThreadDetailDelta(held, expanded)).toEqual(applyAgentThreadDetailDelta(held, delta))
    // A delta with no append in it is handed on as it is.
    const plain: AgentThreadDetailDelta = { ...delta, activityDeltas: [{ id: 'one', removed: true }] }
    expect(withAppendsWhole(plain, now)).toBe(plain)
    // A history without the record cannot say it whole; the reader misses the update and reads the thread whole after it.
    expect(withAppendsWhole(delta, [record('one')])).toBeNull()
  })
})
