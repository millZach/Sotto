// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { aboutPrototype, PROTOTYPE_HOLD_MAX_MS, PROTOTYPE_SEND_BACK_NOTE, PROTOTYPE_SEND_BACK_WINDOW_MS, PrototypeQuestions, sendBackAnswer, type PrototypeSendBack } from '../../../src/main/agents/prototypeQuestions'
import type { PageSearch } from '../../../src/main/agents/questionPages'
import type { AgentHostSnapshot, AgentMessage, AgentRequest, AgentThread, QuestionPage } from '../../../src/shared/agents'

// Checked prototype questions (ADR-0108): a question about a prototype is held while Sotto looks for its pages, shown
// with a working page, and otherwise sent back once with a fixed note. The thread's next question within a minute shows;
// when none comes, Sotto shows its own copy of the question, marked link missing.

const page = (token: string): QuestionPage => ({ token: token.padEnd(32, 'x'), kind: 'file', name: 'greeting.html', start: 'greeting.html' })
const reply = (text: string): AgentMessage => ({ id: 'reply', role: 'assistant', text, createdAt: '2026-10-22T10:00:00.000Z' })
const question = (id: string, text = 'Which prototype variant do you like?', extra: Partial<AgentRequest> = {}): AgentRequest => ({ id, kind: 'question', text, options: [], ...extra })
function thread(requests: AgentRequest[], overrides: Partial<AgentThread> = {}): AgentThread {
  return { id: 'thread', title: 'Greeting', projectId: 'project', modelId: 'm', status: 'running', messages: [reply('Here it is.')], requests, ...overrides }
}
const snapshot = (...threads: AgentThread[]): AgentHostSnapshot => ({ connected: true, projects: [], models: [], threads } as unknown as AgentHostSnapshot)

/** A host's coordinator in miniature: what each search found, the send-backs it was asked for, and a clock it owns. */
function setup(options: { taken?: boolean | 'throw' } = {}) {
  const searches = new Map<string, PageSearch>()
  const sent: { threadId: string; request: AgentRequest; answer: PrototypeSendBack }[] = []
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
  let now = 1_000, changes = 0
  const held = new PrototypeQuestions({
    searched: (threadId, source) => searches.get(`${threadId}\n${source}`),
    sendBack: async (threadId, request, answer) => {
      sent.push({ threadId, request, answer })
      if (options.taken === 'throw') throw new Error('provider gone')
      return options.taken ?? true
    },
    changed: () => { changes++ },
    now: () => now,
    timer: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true } },
  })
  return {
    held, sent, timers,
    get changes() { return changes },
    advance: (ms: number) => { now += ms },
    found: (requestId: string, working: QuestionPage[], pages: QuestionPage[] = working) => searches.set(`thread\nrequest:${requestId}`, { finished: true, pages, working }),
    searching: (requestId: string) => searches.set(`thread\nrequest:${requestId}`, { finished: false, pages: [], working: [] }),
    shown: (shownThread: AgentThread) => held.decorate(snapshot(shownThread)).threads[0]!,
    fire: (ms: number) => { for (const timer of timers.filter(item => item.ms === ms && !item.cancelled)) { timer.cancelled = true; timer.run() } },
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('aboutPrototype', () => {
  it('reads prototype or mock-up as a word in the question or the reply before it', () => {
    expect(aboutPrototype(question('q', 'Which prototype do you like?'))).toBe(true)
    expect(aboutPrototype(question('q', 'Which PROTOTYPES do you like?'))).toBe(true)
    expect(aboutPrototype(question('q', 'Pick one', { questions: [{ id: '0', question: 'Pick a variant', header: 'Mock-up', options: [], multiSelect: false, allowFreeText: true }] }))).toBe(true)
    expect(aboutPrototype(question('q', 'Pick one', { options: [{ id: 'a', label: 'The mockup with tabs' }] }))).toBe(true)
    expect(aboutPrototype(question('q', 'Which variant?'), 'I made two mock-ups.')).toBe(true)
    expect(aboutPrototype(question('q', 'Which variant?'), 'I built it.')).toBe(false)
    expect(aboutPrototype(question('q', 'Should the prototypical case come first?'))).toBe(false)
    expect(aboutPrototype(question('q', 'Merge the branch?'))).toBe(false)
  })
})

describe('sendBackAnswer', () => {
  it('answers every question with the note, and nothing for a question that takes only listed choices', () => {
    expect(sendBackAnswer(question('q'))).toEqual({ answer: PROTOTYPE_SEND_BACK_NOTE })
    const free = (id: string) => ({ id, question: 'Which?', options: [{ id: 'a', label: 'A' }], multiSelect: false, allowFreeText: true })
    expect(sendBackAnswer(question('q', 'Pick', { questions: [free('0'), free('1')] }))).toEqual({ answer: PROTOTYPE_SEND_BACK_NOTE,
      questionAnswers: { 0: { optionIds: [], text: PROTOTYPE_SEND_BACK_NOTE }, 1: { optionIds: [], text: PROTOTYPE_SEND_BACK_NOTE } } })
    expect(sendBackAnswer(question('q', 'Pick', { questions: [free('0'), { ...free('1'), allowFreeText: false }] }))).toBeUndefined()
    expect(sendBackAnswer({ id: 'p', kind: 'permission', text: 'Open the prototype?', options: [] })).toBeUndefined()
  })
})

describe('PrototypeQuestions', () => {
  it('shows a question that is not about a prototype at once, keeping the thread’s own object', () => {
    const { shown } = setup()
    const asked = thread([question('q', 'Merge the branch?')])
    expect(shown(asked)).toBe(asked)
  })

  it('holds a prototype question while its pages are looked for, then shows it with a working page', () => {
    const { held, shown, searching, found, sent } = setup()
    searching('q')
    const asked = thread([question('q'), { id: 'p', kind: 'permission', text: 'Run it?', options: [] }])
    expect(shown(asked).requests.map(request => request.id)).toEqual(['p'])
    expect(held.holds('thread')).toBe(true)
    found('q', [page('a')])
    expect(shown(asked)).toBe(asked)
    expect(held.holds('thread')).toBe(false)
    expect(sent).toEqual([])
  })

  it('gives a snapshot taken again the questions it held', () => {
    const { held, searching } = setup()
    searching('q')
    const given = snapshot(thread([question('q')]))
    const published = held.decorate(given)
    expect(published.threads[0]!.requests).toEqual([])
    expect(held.restore(published).threads[0]).toBe(given.threads[0])
    expect(held.decorate(held.restore(published)).threads[0]!.requests).toEqual([])
  })

  it('sends a question with no working page back once, keeps it hidden until the provider puts it away, and shows the next question in the minute', async () => {
    const test = setup()
    test.found('q', [], [page('dead')])
    const asked = thread([question('q')])
    expect(test.shown(asked).requests).toEqual([])
    await settle()
    expect(test.sent).toEqual([{ threadId: 'thread', request: question('q'), answer: { answer: PROTOTYPE_SEND_BACK_NOTE } }])
    // Taken again, it is not sent again, and stays hidden while the provider still has it.
    expect(test.shown(asked).requests).toEqual([])
    await settle()
    expect(test.sent).toHaveLength(1)
    expect(test.held.holds('thread')).toBe(true)
    // The provider puts it away and asks again within the minute: shown, and marked link missing when it still has no page.
    expect(test.shown(thread([])).requests).toEqual([])
    test.searching('again')
    expect(test.shown(thread([question('again')])).requests).toEqual([])
    test.found('again', [])
    expect(test.shown(thread([question('again')])).requests).toEqual([{ ...question('again'), linkMissing: true }])
    await settle()
    expect(test.sent).toHaveLength(1)
    // The minute ended with the question: no copy comes.
    expect(test.timers.filter(timer => timer.ms === PROTOTYPE_SEND_BACK_WINDOW_MS && !timer.cancelled)).toEqual([])
  })

  it('shows the next question in the minute without a mark when it has a working page', async () => {
    const test = setup()
    test.found('q', [])
    test.shown(thread([question('q')]))
    await settle()
    test.shown(thread([]))
    test.found('again', [page('a')])
    const again = thread([question('again', 'The prototype is at greeting.html. Which variant?')])
    expect(test.shown(again)).toBe(again)
  })

  it('shows its own copy, marked link missing, when no question comes in the minute, and a new question puts it away', async () => {
    const test = setup()
    const original = question('q', 'Which prototype?', { options: [{ id: 'a', label: 'A' }], questions: [{ id: '0', question: 'Which prototype?', options: [{ id: 'a', label: 'A' }], multiSelect: false, allowFreeText: true }] })
    test.found('q', [])
    test.shown(thread([original]))
    await settle()
    test.shown(thread([]))
    const before = test.changes
    test.fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
    expect(test.changes).toBe(before + 1)
    const copy = { id: 'sotto:prototype-question:q', kind: 'question', text: 'Which prototype?', options: original.options, questions: original.questions, linkMissing: true }
    expect(test.shown(thread([])).requests).toEqual([copy])
    expect(test.held.isCopy('thread', copy.id)).toBe(true)
    // A snapshot that still carries the copy carries it once.
    expect(test.shown(thread([copy as AgentRequest])).requests).toEqual([copy])
    // A new question from the thread puts it away, and is a question like any other.
    const unrelated = thread([question('next', 'Merge the branch?')])
    expect(test.shown(unrelated)).toBe(unrelated)
    expect(test.held.isCopy('thread', copy.id)).toBe(false)
  })

  it('shows the original, marked link missing, when the provider still waits on it at the end of the minute', async () => {
    const test = setup()
    test.found('q', [])
    test.shown(thread([question('q')]))
    await settle()
    test.fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
    expect(test.shown(thread([question('q')])).requests).toEqual([{ ...question('q'), linkMissing: true }])
    expect(test.held.holds('thread')).toBe(false)
  })

  it('puts its copy away when the thread is archived or settled', async () => {
    const test = setup()
    test.found('q', [])
    test.shown(thread([question('q')]))
    await settle()
    test.shown(thread([]))
    test.fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
    expect(test.shown(thread([])).requests).toHaveLength(1)
    expect(test.shown(thread([], { workspaceSettledAt: '2026-10-22T11:00:00.000Z' })).requests).toEqual([])
    expect(test.shown(thread([])).requests).toEqual([])
  })

  it('shows a question that cannot carry the note at once, marked link missing, and sends nothing', async () => {
    const test = setup()
    test.found('q', [])
    const choices = question('q', 'Which prototype?', { questions: [{ id: 'pick', question: 'Which prototype?', options: [{ id: 'a', label: 'A' }], multiSelect: false, allowFreeText: false }] })
    expect(test.shown(thread([choices])).requests).toEqual([{ ...choices, linkMissing: true }])
    await settle()
    expect(test.sent).toEqual([])
  })

  for (const outcome of [false, 'throw'] as const) {
    it(`shows the question, marked link missing, when the note does not go (${outcome === false ? 'refused' : 'failed'})`, async () => {
      const test = setup({ taken: outcome })
      test.found('q', [])
      expect(test.shown(thread([question('q')])).requests).toEqual([])
      await settle()
      expect(test.changes).toBeGreaterThan(0)
      expect(test.shown(thread([question('q')])).requests).toEqual([{ ...question('q'), linkMissing: true }])
      expect(test.held.holds('thread')).toBe(false)
      // The next question is the thread's own, not an answer to a note that never went.
      test.searching('later')
      expect(test.shown(thread([question('q'), question('later', 'Merge it?')])).requests.map(request => request.id)).toEqual(['q', 'later'])
    })
  }

  it('shows a question whose search never ends once it has been held long enough', () => {
    const test = setup()
    test.searching('q')
    expect(test.shown(thread([question('q')])).requests).toEqual([])
    expect(test.timers.some(timer => timer.ms === PROTOTYPE_HOLD_MAX_MS)).toBe(true)
    test.advance(PROTOTYPE_HOLD_MAX_MS)
    expect(test.shown(thread([question('q')])).requests).toEqual([question('q')])
  })

  it('never holds a question in Watcher’s own threads or a settled thread', () => {
    const test = setup()
    test.searching('q')
    const watcher = thread([question('q')], { kind: 'watcher' })
    expect(test.shown(watcher)).toBe(watcher)
    const settled = thread([question('q')], { archivedAt: '2026-10-22T11:00:00.000Z' })
    expect(test.shown(settled)).toBe(settled)
  })

  it('turns the answer to its copy into the user’s message, quoting the question', async () => {
    const test = setup()
    const original = question('q', 'Which prototype?', { questions: [
      { id: '0', question: 'Which prototype?', options: [{ id: 'a', label: 'Tabs' }, { id: 'b', label: 'Cards' }], multiSelect: false, allowFreeText: true },
      { id: '1', question: 'Ship it?', options: [{ id: 'y', label: 'Yes' }], multiSelect: false, allowFreeText: true },
    ] })
    test.found('q', [])
    test.shown(thread([original]))
    await settle()
    test.shown(thread([]))
    test.fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
    const id = 'sotto:prototype-question:q'
    expect(test.held.copyAnswer('thread', id, '', { 0: { optionIds: ['b'], text: 'with a footer' }, 1: { optionIds: ['y'] } }))
      .toBe('Answers to your earlier questions:\n"Which prototype?": Cards, with a footer\n"Ship it?": Yes')
    expect(() => test.held.copyAnswer('thread', id, '', { 0: { optionIds: ['z'] }, 1: { optionIds: ['y'] } })).toThrow('Choose an offered question option.')
    expect(() => test.held.copyAnswer('thread', id, '  ')).toThrow('Answer the question before sending. Nothing was sent.')
    expect(() => test.held.copyAnswer('thread', 'sotto:prototype-question:other', 'Tabs')).toThrow('This request is no longer pending. Refresh the thread.')
    const copy = test.held.withdrawCopy('thread', id)
    expect(copy?.id).toBe(id)
    expect(test.shown(thread([])).requests).toEqual([])
    test.held.putBackCopy('thread', copy!)
    expect(test.shown(thread([])).requests.map(request => request.id)).toEqual([id])
  })

  it('quotes a plain question’s words and its choice’s label', async () => {
    const test = setup()
    test.found('q', [])
    test.shown(thread([question('q', 'Which prototype?', { options: [{ id: 'tabs', label: 'The one with tabs' }] })]))
    await settle()
    test.shown(thread([]))
    test.fire(PROTOTYPE_SEND_BACK_WINDOW_MS)
    expect(test.held.copyAnswer('thread', 'sotto:prototype-question:q', 'tabs')).toBe('Answer to your earlier question "Which prototype?": The one with tabs')
  })
})
