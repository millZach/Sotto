import { describe, expect, it } from 'vitest'
import { askScene, chamberPace, councilScene, flightsBetween, plainWords, sceneBusy, spoken, threadFacts, type ThreadFacts } from '../../../../../src/renderer/src/features/council/chamberScene'
import type { AgentActivity } from '../../../../../src/shared/agentActivity'
import { agentThread } from '../../../../fixtures/agentState'
import { councilFixture, row } from './chamberFixtures'

const quiet: ThreadFacts = { running: false, waiting: false, activity: null, words: null }
const facts = (byThread: Record<string, Partial<ThreadFacts>>) => (thread: string): ThreadFacts => ({ ...quiet, ...byThread[thread] })
const running = { status: 'running' as const, lastTurn: { id: 'turn', status: 'running' as const } }
function activity(patch: Partial<AgentActivity>): AgentActivity {
  return { id: 'activity', turnId: 'turn', sequence: 1, kind: 'tool', status: 'running', title: 'Read', ...patch }
}

describe('what a thread is doing', () => {
  it('names what a running thread reads, from its newest running activity', () => {
    const thread = agentThread({ ...running, activities: [activity({ id: 'old', kind: 'command', status: 'completed', command: 'npm test' }), activity({ kind: 'command', command: 'git log -5' })] })
    expect(threadFacts(thread)).toMatchObject({ running: true, activity: 'git log -5', words: null })
  })

  it('takes its newest words only when its newest message is its own, without the result block', () => {
    const asked = agentThread({ ...running, messages: [{ id: 'm1', role: 'user', text: '[Sotto Council] Answer.', createdAt: '2026-11-02T10:00:00.000Z' }] })
    expect(threadFacts(asked).words).toBeNull()
    const writing = agentThread({ ...running, messages: [{ id: 'm1', role: 'user', text: 'Answer.', createdAt: '2026-11-02T10:00:00.000Z' },
      { id: 'm2', role: 'assistant', text: '**Wait** until 0.2 ships.\n\n```council\nanswer: wait\n```', createdAt: '2026-11-02T10:00:01.000Z' }] })
    expect(threadFacts(writing).words).toBe('Wait until 0.2 ships.')
  })

  it('reads a thread whose history the window does not hold from its row’s excerpt', () => {
    const shell = agentThread({ ...running, summary: { messageCount: 2, activityCount: 0, lastUser: { id: 'u', text: 'Answer.', createdAt: '2026-11-02T10:00:00.000Z' },
      lastAssistant: { id: 'a', text: 'After 0.2.', createdAt: '2026-11-02T10:00:02.000Z' } } })
    expect(threadFacts(shell).words).toBe('After 0.2.')
  })

  it('says nothing of a thread at rest but whether it waits on the user', () => {
    const resting = agentThread({ activities: [activity({})], requests: [{ id: 'r', kind: 'question', title: 'Keep them?' } as never] })
    expect(threadFacts(resting)).toEqual({ ...quiet, waiting: true })
    expect(threadFacts(undefined)).toEqual(quiet)
  })

  it('reads only the end of a long message, so the work stays the same as it grows', () => {
    const long = `${'Earlier words. '.repeat(200_000)}\n## Answer\nThe last words.`
    const tail = spoken(long, 40)!
    expect(tail.startsWith('…') && tail.endsWith('Earlier words. The last words.') && tail.length <= 40 && !tail.includes('Answer')).toBe(true)
    expect(plainWords(`# Verdict\nWait until 0.2.${' More.'.repeat(200_000)}`, 'head').startsWith('Wait until 0.2. More.')).toBe(true)
  })

  it('keeps the tail of long words, starting on a whole word', () => {
    const words = spoken(`${'word '.repeat(80)}end`, 40)!
    expect(words.length).toBeLessThanOrEqual(40)
    expect(words.startsWith('…word')).toBe(true)
    expect(words.endsWith('end')).toBe(true)
  })
})

describe('each figure’s pose follows its own thread', () => {
  it('thinks with what it reads, writes with its own words, and raises a hand when it waits on the user', () => {
    const council = councilFixture({ stage: 'answers', rows: [row('A', 'answer', 'working'), row('B', 'answer', 'working'), row('C', 'answer', 'waiting')] })
    const scene = councilScene(council, facts({ 'thread-a': { running: true, activity: 'Read src/main/threadStore.ts' }, 'thread-b': { running: true, words: 'Now. 0.2 makes it bigger.' } }))
    const [a, b, c] = scene.panelists
    expect(a).toMatchObject({ act: 'think', speech: { kind: 'activity', text: 'Read src/main/threadStore.ts' } })
    expect(b).toMatchObject({ act: 'write', speech: { kind: 'words', text: 'Now. 0.2 makes it bigger.' } })
    expect(c).toMatchObject({ act: 'ask', speech: { kind: 'ask' } })
    expect(scene.chair).toMatchObject({ act: 'listen', speech: { kind: 'none' } })
  })

  it('holds the scrolls of the answers it reads, by letter, then stands to give its review; one finished listens', () => {
    const done = [row('A', 'answer', 'done'), row('B', 'answer', 'done'), row('C', 'answer', 'done')]
    const council = councilFixture({ stage: 'reviews', rows: [...done, row('A', 'review', 'working'), row('B', 'review', 'working'), row('C', 'review', 'done', { changed: true })] })
    const scene = councilScene(council, facts({ 'thread-b': { running: true, words: 'A is the careful plan.' } }))
    const [a, b, c] = scene.panelists
    expect(a).toMatchObject({ act: 'read', scrolls: ['B', 'C'], speech: { kind: 'answers', letters: ['B', 'C'] } })
    expect(b).toMatchObject({ act: 'speak', speech: { kind: 'words', text: 'A is the careful plan.' } })
    expect(c).toMatchObject({ act: 'done', changed: true })
    expect(scene.panelists.every(seat => seat.answered)).toBe(true)
  })

  it('has the chair read everything, write the verdict on its scroll, then hold it up through the fairness check', () => {
    const answers = [row('A', 'answer', 'done'), row('B', 'answer', 'done'), row('C', 'answer', 'done')]
    const reading = councilScene(councilFixture({ stage: 'verdict', rows: [...answers, row('chair', 'verdict', 'working')] }), facts({ 'thread-chair': { running: true } }))
    expect(reading.chair).toMatchObject({ act: 'read', speech: { kind: 'everything' } })
    expect(reading.verdict).toBeNull()
    const writing = councilScene(councilFixture({ stage: 'verdict', rows: [...answers, row('chair', 'verdict', 'working')] }), facts({ 'thread-chair': { running: true, words: 'Wait until 0.2 ships.' } }))
    expect(writing.chair.act).toBe('write')
    expect(writing.verdict).toEqual({ text: 'Wait until 0.2 ships.', finished: false })
    const verdict = { text: '## Recommendation\nWait until **0.2** ships.', counts: { answered: 3, partial: false, rankings: [], findings: [], supports: [], favourites: [], changed: ['B'] }, fairnessDone: false, objections: [] }
    const held = councilScene(councilFixture({ stage: 'fairness', verdict, rows: [...answers, row('chair', 'verdict', 'done'), row('A', 'fairness', 'working')] }), facts({}))
    expect(held.chair.act).toBe('present')
    expect(held.verdict).toEqual({ text: 'Wait until 0.2 ships.', finished: true })
    expect(held.panelists[0]).toMatchObject({ act: 'read', speech: { kind: 'verdict' } })
    expect(held.panelists[1]!.changed).toBe(true)
  })

  it('holds a finished Council’s last scene still: the chair holding up the verdict, the panelists listening', () => {
    const verdict = { text: 'Wait until 0.2 ships.', counts: { answered: 3, partial: false, rankings: [], findings: [], supports: [], favourites: [], changed: [] }, fairnessDone: true, objections: [] }
    const rows = [...['A', 'B', 'C'].flatMap(letter => [row(letter, 'answer', 'done'), row(letter, 'review', 'done'), row(letter, 'fairness', 'done')]), row('chair', 'verdict', 'done')]
    const finished = councilScene(councilFixture({ stage: 'done', verdict, rows }, { status: 'done' }), facts({}))
    expect(finished.finished).toBe(true)
    expect(finished.chair.act).toBe('present')
    expect(finished.verdict).toEqual({ text: 'Wait until 0.2 ships.', finished: true })
    expect(finished.panelists.map(seat => seat.act)).toEqual(['done', 'done', 'done'])
    expect(sceneBusy(finished)).toBe(false)
    // Holding up the verdict is a still pose: through the fairness check only a panelist still at work keeps the fast pace.
    const held = councilScene(councilFixture({ stage: 'fairness', verdict: { ...verdict, fairnessDone: false }, rows }), facts({}))
    expect(held.finished).toBe(false)
    expect(held.chair.act).toBe('present')
    expect(sceneBusy(held)).toBe(false)
    const checking = councilScene(councilFixture({ stage: 'fairness', verdict: { ...verdict, fairnessDone: false }, rows: [...rows, row('A', 'fairness', 'working')] }), facts({}))
    expect(sceneBusy(checking)).toBe(true)
  })

  it('raises a hand for a question its thread holds between stages, but not for a seat left out', () => {
    const council = councilFixture({ stage: 'reviews', leftOut: ['C'], rows: [row('A', 'answer', 'done'), row('B', 'answer', 'done'), row('C', 'answer', 'done')] })
    const scene = councilScene(council, facts({ 'thread-a': { waiting: true }, 'thread-c': { waiting: true }, 'thread-chair': { waiting: true } }))
    expect(scene.panelists.map(seat => seat.act)).toEqual(['ask', 'done', 'done'])
    expect(scene.chair).toMatchObject({ act: 'ask', speech: { kind: 'ask' } })
    // Before its first row, too.
    expect(councilScene(councilFixture({ stage: 'answers', rows: [] }), facts({ 'thread-b': { waiting: true } })).panelists[1]!.act).toBe('ask')
  })

  it('reads the conversation in parts first, and sits out once left out', () => {
    const council = councilFixture({ stage: 'framing', leftOut: ['C'], rows: [row('A', 'history', 'working'), row('chair', 'framing', 'working'), row('C', 'history', 'failed')] })
    const scene = councilScene(council, facts({ 'thread-chair': { running: true } }))
    expect(scene.panelists[0]).toMatchObject({ act: 'think', speech: { kind: 'conversation' } })
    expect(scene.panelists[1]).toMatchObject({ act: 'done', state: null })
    expect(scene.panelists[2]).toMatchObject({ act: 'done', state: 'failed' })
    expect(scene.chair).toMatchObject({ act: 'think', speech: { kind: 'framing' } })
    // The chair reads the conversation in parts as a panelist does, and is said to.
    const reading = councilScene(councilFixture({ stage: 'framing', rows: [row('chair', 'history', 'working')] }), facts({ 'thread-chair': { running: true } }))
    expect(reading.chair).toMatchObject({ act: 'think', speech: { kind: 'conversation' } })
  })

  it('seats the Ask form’s panel idle, with no thread to open', () => {
    const model = (id: string, name: string, providerId: 'claude' | 'codex' | 'muse') => ({ id, name, providerId, ready: true } as never)
    const seat = (id: string, name: string, provider: 'claude' | 'codex' | 'muse') => ({ modelId: id, model: model(id, name, provider), reasoningEffort: 'high', from: 'default' as const, ready: true, provider })
    const scene = askScene({ panelists: [seat('a', 'Opus 5.5', 'claude'), seat('b', 'GPT-6.1 Sol', 'codex'), undefined], chair: seat('c', 'Wonder Full', 'muse') })
    expect(scene.id).toBeNull()
    expect(scene.panelists.map(item => [item.key, item.model, item.act, item.thread])).toEqual([['A', 'Opus 5.5', 'idle', null], ['B', 'GPT-6.1 Sol', 'idle', null], ['C', '', 'idle', null]])
    expect(scene.chair).toMatchObject({ key: 'chair', chair: true, model: 'Wonder Full', provider: 'Muse' })
  })

  it('keeps each figure by whose it is: a seat’s thread in a Council, its model in the Ask view', () => {
    const model = (id: string) => ({ id, name: id, providerId: 'claude', ready: true } as never)
    const seat = (id: string) => ({ modelId: id, model: model(id), reasoningEffort: null, from: 'choice' as const, ready: true, provider: 'claude' as const })
    const before = askScene({ panelists: [seat('a'), seat('b'), seat('a'), seat('c')], chair: seat('d') })
    const after = askScene({ panelists: [seat('a'), seat('a'), seat('c')], chair: seat('d') })
    // Removing the second seat leaves every other figure as it was, the second copy of a model included.
    expect(after.panelists.map(item => item.figure)).toEqual([before.panelists[0]!.figure, before.panelists[2]!.figure, before.panelists[3]!.figure])
    expect(new Set(before.panelists.map(item => item.figure)).size).toBe(4)
    const live = councilScene(councilFixture({}), facts({}))
    expect([...live.panelists, live.chair].map(item => item.figure)).toEqual(['thread-a', 'thread-b', 'thread-c', 'thread-chair'])
  })
})

describe('scrolls fly between seats when the stage changes', () => {
  const answers = [row('A', 'answer', 'done'), row('B', 'answer', 'done'), row('C', 'answer', 'done')]

  it('sends each answer to every panelist who reads it as review starts, by letter', () => {
    const scene = councilScene(councilFixture({ stage: 'reviews', rows: answers }), facts({}))
    const flights = flightsBetween('answers', scene)
    expect(flights.map(flight => `${flight.from}>${flight.to}`).sort()).toEqual(['A>B', 'A>C', 'B>A', 'B>C', 'C>A', 'C>B'])
    expect(flights.every(flight => flight.label === flight.from && flight.delay >= 0)).toBe(true)
  })

  it('with five panelists sends each reader only the two answers it reviews', () => {
    const seats = ['A', 'B', 'C', 'D', 'E'].map((seat, k) => ({ seat, role: 'panelist' as const, modelId: `m${k}`, modelName: `M${k}`, effort: null, thread: `t${k}`, remote: false }))
    const council = councilFixture({ stage: 'reviews', rows: seats.map(seat => row(seat.seat, 'answer', 'done')) }, { seats: [...seats, { seat: 'chair', role: 'chair', modelId: 'c', modelName: 'C', effort: null, thread: 'tc', remote: false }] })
    const flights = flightsBetween('answers', councilScene(council, facts({})))
    expect(flights).toHaveLength(10)
    expect(flights.filter(flight => flight.to === 'A').map(flight => flight.from)).toEqual(['B', 'C'])
  })

  it('gathers every answer to the chair for the verdict, and sends nothing on a reframe or a repeat', () => {
    const scene = councilScene(councilFixture({ stage: 'verdict', rows: answers }), facts({}))
    expect(flightsBetween('reviews', scene).map(flight => `${flight.from}>${flight.to}`)).toEqual(['A>chair', 'B>chair', 'C>chair'])
    expect(flightsBetween('verdict', scene)).toEqual([])
    expect(flightsBetween(null, scene)).toEqual([])
    expect(flightsBetween('reviews', councilScene(councilFixture({ stage: 'answers', rows: answers }), facts({})))).toEqual([])
  })
})

describe('how often the chamber draws', () => {
  it('draws about 30 frames a second while a figure is busy or something is on its way, 8 while only the fire flickers', () => {
    expect(chamberPace(false, false, true, 'answers')).toBe(33)
    expect(chamberPace(false, true, false, 'verdict')).toBe(33)
    expect(chamberPace(false, false, false, null)).toBe(125)
  })

  it('keeps the fairness check at 8 frames a second even while nods settle or a panelist works', () => {
    for (const moving of [false, true]) for (const busy of [false, true]) {
      expect(chamberPace(false, moving, busy, 'fairness')).toBe(125)
    }
  })

  it('draws nothing with motion reduced, even if the snapped pose reported movement', () => {
    expect(chamberPace(true, false, true, 'answers')).toBeNull()
    expect(chamberPace(true, true, false, 'fairness')).toBeNull()
  })
})
