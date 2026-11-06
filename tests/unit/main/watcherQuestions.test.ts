// @vitest-environment node
// Watcher's own questions (#2228): kept while Keep local history is on, as Watcher's conversation is; one Settle it agrees
// one settle; a new Watcher closes the last one's; and the news says the choice is the user's own.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WatcherQuestions } from '../../../src/main/agents/watcherQuestions'
import { toldEventsForLater, watcherNewsText } from '../../../src/main/agents/watcherNews'
import { WatcherToldNews } from '../../../src/main/agents/watcherToldNews'
import { WATCHER_UNWATCHED_REQUEST_ID, type WatcherEvent } from '../../../src/shared/watcherNews'
import { watcherQuestionChoice, watcherQuestionOf, watcherQuestionRequest, watcherQuestionRequestId, WATCHER_QUESTION_FIELD } from '../../../src/shared/watcherQuestions'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const folder = async () => { const made = await mkdtemp(join(tmpdir(), 'sotto-watcher-questions-')); folders.push(made); return made }
const HOST = '6c0f8f0e-7b1e-4d5a-9a43-1f4f0f3b2a10'
const worker = { hostId: HOST, threadId: 'worker' }
const ASK = { question: 'Run Owl build’s CI again?', options: [{ label: 'Run it again' }, { label: 'Leave it failed' }] }

describe('Watcher’s questions as main keeps them', () => {
  it('keeps questions and answers across a restart while history is kept, and none on disk while it is off', async () => {
    const directory = await folder()
    let history = true
    const questions = new WatcherQuestions(directory, () => history)
    const asked = await questions.ask('watcher', ASK)
    expect(await questions.answer(asked.id, 'Run it again')).toMatchObject({ state: 'answered', choice: 'Run it again' })
    const again = new WatcherQuestions(directory, () => history)
    await again.load()
    expect(again.all()).toEqual([expect.objectContaining({ id: asked.id, state: 'answered', choice: 'Run it again' })])
    history = false
    await again.privacyChanged()
    expect(await readdir(directory)).not.toContain('watcher-questions.json')
    // What this run holds stays in memory, and nothing new is written.
    await again.ask('watcher', ASK)
    expect(again.all()).toHaveLength(2)
    expect(await readdir(directory)).not.toContain('watcher-questions.json')
    const after = new WatcherQuestions(directory, () => history)
    await after.load()
    expect(after.all()).toEqual([])
  })

  it('answers only an open question, with a choice its card offered', async () => {
    const questions = new WatcherQuestions(await folder(), () => false)
    const asked = await questions.ask('watcher', ASK)
    expect(await questions.answer(asked.id, 'Something else')).toBeUndefined()
    expect(await questions.answer(asked.id, 'Leave it failed')).toMatchObject({ choice: 'Leave it failed' })
    expect(await questions.answer(asked.id, 'Run it again')).toBeUndefined()
  })

  it('agrees one settle for a Settle it, and none for Keep watching or another thread', async () => {
    const questions = new WatcherQuestions(await folder(), () => false)
    const settle = await questions.ask('watcher', { question: 'Settle Synthetic worker?', settle: worker })
    expect(settle.options.map(option => option.label)).toEqual(['Settle it', 'Keep watching'])
    expect(questions.agreedSettle('watcher', worker)).toBe(false)
    await questions.answer(settle.id, 'Settle it')
    expect(questions.agreedSettle('watcher', worker)).toBe(true)
    expect(questions.agreedSettle('watcher', { hostId: HOST, threadId: 'other' })).toBe(false)
    expect(questions.agreedSettle('another-watcher', worker)).toBe(false)
    await questions.spendSettle('watcher', worker)
    expect(questions.agreedSettle('watcher', worker)).toBe(false)
    const kept = await questions.ask('watcher', { question: 'Settle Synthetic worker again?', settle: worker })
    await questions.answer(kept.id, 'Keep watching')
    expect(questions.agreedSettle('watcher', worker)).toBe(false)
  })

  it('closes a Watcher’s open questions for its handover, and hands the room the same list until one changes', async () => {
    const questions = new WatcherQuestions(await folder(), () => false)
    const open = await questions.ask('watcher', ASK)
    const answered = await questions.ask('watcher', ASK)
    await questions.answer(answered.id, 'Run it again')
    const list = questions.all()
    expect(questions.all()).toBe(list)
    expect((await questions.close('watcher')).map(question => question.id)).toEqual([open.id])
    expect(questions.all()).not.toBe(list)
    expect(questions.get(open.id)).toMatchObject({ state: 'closed' })
    expect(questions.get(answered.id)).toMatchObject({ state: 'answered' })
    expect(questions.open('watcher')).toEqual([])
  })
})

describe('Watcher’s question as a card', () => {
  it('is an ordinary single-choice question card under its own request ID, with no written answer', () => {
    const request = watcherQuestionRequest({ id: '3f1a6c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', question: ASK.question, options: ASK.options, at: '2026-11-05T12:00:00.000Z' })
    expect(watcherQuestionOf(request.id)).toBe('3f1a6c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b')
    expect(watcherQuestionOf('native-request')).toBeUndefined()
    expect(request).toMatchObject({ kind: 'question', text: ASK.question, questions: [{ id: WATCHER_QUESTION_FIELD, multiSelect: false, allowFreeText: false,
      options: [{ id: 'choice-1', label: 'Run it again' }, { id: 'choice-2', label: 'Leave it failed' }] }] })
    expect(watcherQuestionChoice(ASK, { answer: '', questionAnswers: { [WATCHER_QUESTION_FIELD]: { optionIds: ['choice-2'] } } })).toBe('Leave it failed')
    expect(watcherQuestionChoice(ASK, { answer: '', questionAnswers: { [WATCHER_QUESTION_FIELD]: { optionIds: ['choice-1', 'choice-2'] } } })).toBeUndefined()
    // A client that sends only the words of its choice, as an older one does.
    expect(watcherQuestionChoice(ASK, { answer: 'run it again' })).toBe('Run it again')
    expect(watcherQuestionChoice(ASK, { answer: 'Do something else' })).toBeUndefined()
    expect(watcherQuestionRequestId('x')).toBe('watcher-question:x')
  })
})

describe('the news of the user’s answer', () => {
  const event = (answered: NonNullable<WatcherEvent['answered']>, requestId = WATCHER_UNWATCHED_REQUEST_ID): WatcherEvent => ({ id: `answered-${answered.choice}`, kind: 'user-answered',
    requestId, target: worker, generation: 0, observedAt: '2026-11-05T12:00:00.000Z', answered })
  const news = (events: WatcherEvent[]) => watcherNewsText({ source: 'watcher', watcher: { hostId: HOST, threadId: 'watcher' }, events, omitted: 0 })
  const QUESTION = '3f1a6c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b'

  it('quotes the question and says the choice is the user’s own', () => {
    const text = news([event({ questionId: QUESTION, question: ASK.question, choice: 'Run it again' })])
    expect(text).toContain(`The user answered your question ${JSON.stringify(ASK.question)} on its card: "Run it again".`)
    expect(text).toContain('That is the user\'s own choice')
    expect(text).toContain(QUESTION)
    expect(text).not.toContain('Use requestId')
  })

  it('says a Settle it agrees that one settle, and Keep watching keeps the thread', () => {
    const watch = '7a4c2e1f-0b3d-4e5f-8a9b-1c2d3e4f5a6b'
    const agreed = news([event({ questionId: QUESTION, question: 'Settle Synthetic worker?', choice: 'Settle it', settle: true }, watch)])
    expect(agreed).toContain('They agree to settle this thread: call settle_thread for it now')
    expect(agreed).toContain(`Use requestId ${watch} for this thread.`)
    expect(news([event({ questionId: QUESTION, question: 'Settle Synthetic worker?', choice: 'Keep watching', settle: true }, watch)])).toContain('They want this thread kept')
  })

  it('keeps answers that would not fit whole in one wake-up for the next, never leaving them out', () => {
    const many = Array.from({ length: 30 }, (_, index) => event({ questionId: QUESTION, question: `${'A long question. '.repeat(55)}${index}`, choice: 'Run it again' }))
    const later = toldEventsForLater(many.map((item, index) => ({ ...item, id: `answered-${index}` })))
    expect(later.size).toBeGreaterThan(0)
    expect(later.size).toBeLessThan(30)
    expect(later.has('answered-0')).toBe(false)
  })
})

describe('the saved words of news Watcher has not been told', () => {
  it('leave the disk when Keep local history goes off, and are saved again when it comes back on', async () => {
    const directory = await folder()
    let history = true
    const told = new WatcherToldNews(directory, () => history)
    await told.load()
    await told.add({ id: 'answered', kind: 'user-answered', requestId: WATCHER_UNWATCHED_REQUEST_ID, target: worker, generation: 0, observedAt: '2026-11-05T12:00:00.000Z',
      answered: { questionId: '3f1a6c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', question: ASK.question, choice: 'Run it again' } })
    expect(await readdir(directory)).toContain('watcher-told.json')
    history = false
    await told.privacyChanged()
    expect(await readdir(directory)).not.toContain('watcher-told.json')
    history = true
    await told.privacyChanged()
    expect(await readdir(directory)).toContain('watcher-told.json')
  })
})
