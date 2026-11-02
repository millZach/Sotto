// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CouncilAnswer, CouncilCrux, CouncilFraming, CouncilReview } from '../../../../src/shared/councilBlocks'
import { savedRecord, type CouncilRecord, type CouncilTurn } from '../../../../src/main/council/councilRecord'
import { advanceRound, criteriaOf, currentRound, fairnessDone, isLate, kindsOf, leaveOut, nextClockChange, reframable, reframe, replaceSeat, researchOf, retryTurn, rowActions, turnState, type StageClock } from '../../../../src/main/council/councilStages'

const START = Date.parse('2026-11-02T12:00:00.000Z')
let ids = 0
const clock = (now = START): StageClock => ({ now, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` })

function council(panelists = 3): CouncilRecord {
  const seat = (name: string, role: 'panelist' | 'chair') => ({ seat: name, role, modelId: `native:claude:model:${name}`, modelName: name, provider: 'claude' as const, effort: 'high',
    thread: `thread-${name}`, formerThreads: [], started: true, context: false })
  return {
    id: '00000000-0000-4000-8000-000000000000', createdAt: new Date(START).toISOString(), originThread: 'origin', originTitle: 'Synthetic origin', projectId: 'project',
    snapshot: { path: '/synthetic/snapshot', repositoryRoot: '/synthetic', commit: 'a'.repeat(40), branch: 'main', untracked: 0 },
    history: { messages: 2, words: 10, tools: 0, parts: 1 },
    seats: [...['A', 'B', 'C', 'D', 'E'].slice(0, panelists).map(name => seat(name, 'panelist')), seat('chair', 'chair')],
    rounds: [{ index: 0, askedAt: new Date(START).toISOString(), stage: 'framing', leftOut: [], objections: [], question: 'Synthetic question?' }],
    turns: [], deadlineMinutes: 10,
  }
}
const queued = (record: CouncilRecord, stage: CouncilTurn['stage']) => record.turns.filter(turn => turn.stage === stage && !turn.superseded && turn.delivery === 'queued')
const sent = (turn: CouncilTurn, at = START): void => { turn.delivery = 'accepted'; turn.sentAt = new Date(at).toISOString(); turn.outcome = 'working' }
const answer = (turn: CouncilTurn, block?: unknown): void => { sent(turn); turn.outcome = 'answered'; turn.replyMessageId = `reply-${turn.id}`; if (block === undefined) turn.result = 'none'; else { turn.result = 'valid'; turn.block = block } }
const answerBlock = (letter: string): CouncilAnswer => ({ answer: `Synthetic ${letter}`, findings: [{ id: `${letter}1`, kind: 'judgement', claim: 'x' }], challenges: [] })
const reviewBlock = (ranking: string[]): CouncilReview => ({ ranking, findings: [], added: [], scores: [], favourites: [], answer: 'same', evidence: [] })
const framing: CouncilFraming = { kinds: ['decision'], criteria: [{ id: 'C1', source: 'question', text: 'Keeps x' }], headings: ['Answer'], words: 300, angles: [], research: { needed: false, reason: '' } }

function throughAnswers(record: CouncilRecord): void {
  advanceRound(record, clock())
  answer(queued(record, 'framing')[0]!, framing)
  advanceRound(record, clock())
  for (const turn of queued(record, 'answer')) answer(turn, answerBlock(turn.seat))
  advanceRound(record, clock())
}

describe('the stages', () => {
  it('frames first, with the chair alone, and starts every answer as soon as framing is in', () => {
    const record = council()
    advanceRound(record, clock())
    expect(record.turns.map(turn => [turn.seat, turn.stage])).toEqual([['chair', 'framing']])
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    expect(currentRound(record)).toMatchObject({ stage: 'answers', framing })
    expect(queued(record, 'answer').map(turn => turn.seat)).toEqual(['A', 'B', 'C'])
  })

  it('goes on with the question alone when framing fails', () => {
    const record = council()
    advanceRound(record, clock())
    const framingTurn = queued(record, 'framing')[0]!
    sent(framingTurn); framingTurn.outcome = 'failed'
    advanceRound(record, clock())
    expect(currentRound(record)).toMatchObject({ stage: 'answers', framingFallback: true })
  })

  it('moves from answers to reviews with each answer read by the others, then to the verdict', () => {
    const record = council()
    throughAnswers(record)
    expect(currentRound(record).stage).toBe('reviews')
    expect(currentRound(record).reviewPlan).toEqual({ A: ['B', 'C'], B: ['C', 'A'], C: ['A', 'B'] })
    for (const turn of queued(record, 'review')) answer(turn, reviewBlock(currentRound(record).reviewPlan![turn.seat]!))
    advanceRound(record, clock())
    expect(currentRound(record).stage).toBe('verdict')
    expect(queued(record, 'verdict').map(turn => turn.seat)).toEqual(['chair'])
  })

  it('has each of five panelists review two others', () => {
    const record = council(5)
    throughAnswers(record)
    expect(Object.values(currentRound(record).reviewPlan!).every(read => read.length === 2)).toBe(true)
    expect(queued(record, 'review')).toHaveLength(5)
  })

  it('asks once more for an unreadable block, and counts it unavailable if the repair fails, never holding the stage', () => {
    const record = council()
    advanceRound(record, clock())
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    const [first, ...rest] = queued(record, 'answer')
    sent(first!); first!.outcome = 'answered'; first!.result = 'invalid'; first!.reason = 'the reply has no block'
    for (const turn of rest) answer(turn, answerBlock(turn.seat))
    advanceRound(record, clock())
    const repair = record.turns.find(turn => turn.repairOf === first!.id)!
    expect(repair).toMatchObject({ seat: 'A', stage: 'answer', delivery: 'queued' })
    advanceRound(record, clock())
    expect(record.turns.filter(turn => turn.repairOf === first!.id)).toHaveLength(1)
    sent(repair); repair.outcome = 'answered'; repair.result = 'unavailable'
    advanceRound(record, clock())
    expect(first!.result).toBe('unavailable')
    expect(currentRound(record).stage).toBe('reviews')
  })

  it('holds a stage on a failed thread until the user acts, and goes on without it when asked', () => {
    const record = council()
    advanceRound(record, clock())
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    const [failed, ...rest] = queued(record, 'answer')
    sent(failed!); failed!.outcome = 'failed'
    for (const turn of rest) answer(turn, answerBlock(turn.seat))
    advanceRound(record, clock())
    expect(currentRound(record).stage).toBe('answers')
    expect(rowActions(record, failed!, START, false)).toEqual(['retry', 'replace', 'skip'])
    expect(turnState(failed!, false)).toBe('failed')
    leaveOut(record, failed!)
    advanceRound(record, clock())
    expect(currentRound(record)).toMatchObject({ stage: 'reviews', leftOut: ['A'], reviewPlan: { B: ['C'], C: ['B'] } })
  })

  it('goes straight to the verdict when only one panelist answered', () => {
    const record = council(2)
    advanceRound(record, clock())
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    const [kept, dropped] = queued(record, 'answer')
    answer(kept!, answerBlock('A'))
    sent(dropped!); dropped!.outcome = 'stopped'
    leaveOut(record, dropped!)
    advanceRound(record, clock())
    expect(currentRound(record).stage).toBe('verdict')
  })

  it('retries with a new prompt, and gives the seat a new thread with Use another model', () => {
    const record = council()
    advanceRound(record, clock())
    const framingTurn = queued(record, 'framing')[0]!
    sent(framingTurn); framingTurn.outcome = 'unknown'
    expect(rowActions(record, framingTurn, START, false)).toEqual(['retry', 'replace', 'skip'])
    retryTurn(record, framingTurn, clock())
    expect(framingTurn.superseded).toBe(true)
    expect(queued(record, 'framing')).toHaveLength(1)
    const again = queued(record, 'framing')[0]!
    sent(again); again.outcome = 'failed'
    replaceSeat(record, again, { modelId: 'native:codex:model:gpt-6.1-sol', modelName: 'GPT-6.1 Sol', provider: 'codex', effort: 'high' }, 'thread-new', clock())
    expect(record.seats.find(seat => seat.seat === 'chair')).toMatchObject({ thread: 'thread-new', formerThreads: ['thread-chair'], started: false, context: false })
    expect(queued(record, 'framing')[0]).toMatchObject({ thread: 'thread-new' })
  })

  it('offers a failed chair only Retry and Use another model at the verdict, and a thread waiting on the user no Retry', () => {
    const record = council()
    throughAnswers(record)
    for (const turn of queued(record, 'review')) answer(turn, reviewBlock(currentRound(record).reviewPlan![turn.seat]!))
    advanceRound(record, clock())
    const verdict = queued(record, 'verdict')[0]!
    sent(verdict); verdict.outcome = 'failed'
    expect(rowActions(record, verdict, START, false)).toEqual(['retry', 'replace'])
    expect(rowActions(record, verdict, START, true)).toEqual(['replace'])
  })
})

describe('changing the framing in the record', () => {
  it('sets aside every answer and review and asks the panel to answer again, with the user\'s kind and research', () => {
    const record = council()
    throughAnswers(record)
    const review = queued(record, 'review')[0]!
    sent(review)
    expect(reframable(record)).toBe(true)
    expect(reframe(record, { research: false }, START)).toBeUndefined()
    expect(reframe(record, { kinds: ['fact'], research: true }, START)).toEqual(['thread-A'])
    expect(currentRound(record)).toMatchObject({ stage: 'answers', kinds: ['fact'], research: true })
    expect(currentRound(record).reviewPlan).toBeUndefined()
    expect(kindsOf(currentRound(record))).toEqual(['fact'])
    expect(researchOf(currentRound(record))).toBe(true)
    advanceRound(record, clock())
    expect(queued(record, 'answer').map(turn => turn.seat)).toEqual(['A', 'B', 'C'])
    expect(record.turns.filter(turn => turn.stage === 'answer' || turn.stage === 'review').filter(turn => turn.delivery !== 'queued').every(turn => turn.superseded)).toBe(true)
  })

  it('holds answers to the criteria the user set, and asks again', () => {
    const record = council()
    throughAnswers(record)
    expect(reframe(record, { criteria: ['Keeps x'] }, START)).toBeUndefined()
    expect(reframe(record, { criteria: ['Synthetic one', 'Synthetic two'] }, START)).toEqual([])
    expect(criteriaOf(currentRound(record))).toEqual([{ id: 'C1', source: 'user', text: 'Synthetic one' }, { id: 'C2', source: 'user', text: 'Synthetic two' }])
    expect(currentRound(record).stage).toBe('answers')
  })

  it('waits for the framing, and changes nothing once the verdict is under way', () => {
    const record = council()
    advanceRound(record, clock())
    expect(reframe(record, { research: true }, START)).toBeUndefined()
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    currentRound(record).stage = 'verdict'
    expect(reframable(record)).toBe(false)
  })
})

describe('a conversation in parts', () => {
  it('queues every part before a thread\'s first stage prompt, once, and lets a stuck part be retried or given another model', () => {
    const record = council()
    record.history.parts = 3
    advanceRound(record, clock())
    expect(record.turns.map(turn => [turn.seat, turn.stage, turn.part])).toEqual([['chair', 'history', 1], ['chair', 'history', 2], ['chair', 'history', 3], ['chair', 'framing', undefined]])
    const [first, second] = record.turns
    sent(first!); first!.outcome = 'failed'
    expect(rowActions(record, first!, START, false)).toEqual(['retry', 'replace'])
    retryTurn(record, first!, clock())
    expect(record.turns.at(-1)).toMatchObject({ stage: 'history', part: 1, delivery: 'queued' })
    replaceSeat(record, second!, { modelId: 'native:codex:model:gpt-6.1-sol', modelName: 'GPT-6.1 Sol', provider: 'codex', effort: 'high' }, 'thread-new', clock())
    expect(second!.superseded).toBe(true)
  })

  it('sends the parts to a panelist too, and to no thread twice', () => {
    const record = council()
    record.history.parts = 2
    advanceRound(record, clock())
    for (const turn of record.turns.filter(item => item.stage === 'history')) answer(turn)
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    expect(record.turns.filter(turn => turn.stage === 'history').map(turn => turn.seat)).toEqual(['chair', 'chair', 'A', 'A', 'B', 'B', 'C', 'C'])
  })
})

describe('the stage deadline', () => {
  it('marks a working thread late once the deadline passes, offers its actions, and wakes once for it', () => {
    const record = council()
    advanceRound(record, clock())
    const framingTurn = queued(record, 'framing')[0]!
    sent(framingTurn)
    expect(isLate(framingTurn, START + 9 * 60_000, 10 * 60_000)).toBe(false)
    expect(rowActions(record, framingTurn, START + 9 * 60_000, false)).toEqual([])
    expect(isLate(framingTurn, START + 11 * 60_000, 10 * 60_000)).toBe(true)
    expect(rowActions(record, framingTurn, START + 11 * 60_000, false)).toEqual(['retry', 'replace', 'skip'])
    expect(nextClockChange(record, START)).toBe(START + 10 * 60_000 + 1)
  })

  it('never leaves a late thread out on its own', () => {
    const record = council()
    throughAnswers(record)
    const late = queued(record, 'review')[0]!
    sent(late)
    for (const turn of queued(record, 'review')) answer(turn, reviewBlock(currentRound(record).reviewPlan![turn.seat]!))
    advanceRound(record, clock(START + 60 * 60_000))
    expect(currentRound(record).stage).toBe('reviews')
  })
})

describe('the crux check and the fairness check', () => {
  const crux: CouncilCrux = { test: 'npx vitest run tests/unit/a.test.ts', lookup: false, sides: [['A'], ['B']], meanings: [{ result: 'passes', meaning: 'A' }, { result: 'fails', meaning: 'B' }] }

  function toVerdict(record: CouncilRecord): CouncilTurn {
    throughAnswers(record)
    for (const turn of queued(record, 'review')) answer(turn, reviewBlock(currentRound(record).reviewPlan![turn.seat]!))
    advanceRound(record, clock())
    return queued(record, 'verdict')[0]!
  }

  it('runs a crux check once, by a panelist on neither side, then asks the chair for the verdict', () => {
    const record = council()
    answer(toVerdict(record), crux)
    advanceRound(record, clock())
    expect(currentRound(record)).toMatchObject({ stage: 'crux', cruxRunners: ['C'] })
    answer(queued(record, 'crux')[0]!, { result: 'passed', outcome: 1 })
    advanceRound(record, clock())
    expect(currentRound(record)).toMatchObject({ stage: 'verdict', cruxDone: true })
    expect(queued(record, 'verdict')).toHaveLength(1)
  })

  it('has each side try to establish the other\'s claim when no panelist is on neither side', () => {
    const record = council(2)
    answer(toVerdict(record), { ...crux })
    advanceRound(record, clock())
    expect(queued(record, 'crux').map(turn => [turn.seat, turn.establish])).toEqual([['A', 1], ['B', 0]])
  })

  it('waits for every panelist\'s fairness answer or two minutes before the verdict can be sent, and sends objections to the chair', () => {
    const record = council()
    const verdict = toVerdict(record)
    answer(verdict)
    currentRound(record).verdict = 'Synthetic verdict.'
    advanceRound(record, clock())
    expect(currentRound(record).stage).toBe('fairness')
    const fairness = queued(record, 'fairness')
    expect(fairness.map(turn => turn.seat)).toEqual(['A', 'B', 'C'])
    expect(fairnessDone(record, currentRound(record), START + 60_000)).toBe(false)
    expect(fairnessDone(record, currentRound(record), START + 2 * 60_000)).toBe(true)
    answer(fairness[0]!, { fair: true }); answer(fairness[1]!, { fair: true })
    answer(fairness[2]!, { fair: false, claim: 'x', passage: 'Synthetic verdict.' })
    currentRound(record).objections.push({ seat: 'C', claim: 'x', passage: 'Synthetic verdict.', answer: 'pending' })
    advanceRound(record, clock())
    expect(fairnessDone(record, currentRound(record), START + 1)).toBe(true)
    const amend = queued(record, 'amend')[0]!
    expect(amend).toMatchObject({ seat: 'chair', objections: ['C'] })
    expect(currentRound(record).stage).toBe('fairness')
    answer(amend, { objections: [{ seat: 'C', answer: 'stands' }] })
    advanceRound(record, clock())
    expect(currentRound(record).stage).toBe('done')
  })
})

describe('a stopped Council', () => {
  it('moves no further', () => {
    const record = council()
    record.stoppedAt = new Date(START).toISOString()
    expect(advanceRound(record, clock())).toBe(false)
    expect(record.turns).toEqual([])
  })
})

describe('the saved record', () => {
  it('keeps no words while Keep local history is off', () => {
    const record = council()
    advanceRound(record, clock())
    answer(queued(record, 'framing')[0]!, framing)
    advanceRound(record, clock())
    record.turns[0]!.summary = 'decision'
    currentRound(record).objections.push({ seat: 'A', claim: 'Synthetic claim', passage: 'Synthetic passage', answer: 'pending' })
    const saved = JSON.stringify(savedRecord(record, false))
    for (const words of ['Synthetic question?', 'Synthetic claim', 'Synthetic passage', '"summary"', '"block"', 'Keeps']) expect(saved).not.toContain(words)
    expect(savedRecord(record, false).rounds[0]).not.toHaveProperty('framing')
    expect(savedRecord(record, true)).toBe(record)
  })
})
