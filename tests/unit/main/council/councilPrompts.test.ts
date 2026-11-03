// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '../../../../src/shared/agents'
import type { AgentActivity } from '../../../../src/shared/agentActivity'
import { COUNCIL_FIELD_MAX, readFairnessBlock } from '../../../../src/shared/councilBlocks'
import { councilFileSchema } from '../../../../src/main/council/councilRecord'
import { answerPrompt, fairnessPrompt, framingWords, historyAboveWords, historyPartPrompt, historyParts, historyText, PROMPT_LIMIT, quoteHistory, reviewPrompt, verdictPrompt } from '../../../../src/main/council/councilPrompts'

const message = (id: string, role: 'user' | 'assistant', text: string, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role, text, createdAt: '2026-11-02T12:00:00.000Z', ...extra })
const activity = (id: string, after: string, extra: Partial<AgentActivity>): AgentActivity =>
  ({ id, turnId: after, sequence: Number(id.replace(/\D/gu, '')), afterMessageId: after, kind: 'tool', status: 'completed', title: '', ...extra })

describe('the origin conversation as quoted history', () => {
  it('carries every message in full, names tool calls by what they touched and leaves their output out', () => {
    const quoted = quoteHistory({ provider: 'claude', messages: [
      message('u1', 'user', 'Synthetic request', { attachments: [{ id: 'a', name: 'screenshot.png', mimeType: 'image/png', sizeBytes: 10 }] }),
      message('r1', 'assistant', 'Synthetic reply'),
      message('visual:1', 'assistant', 'Synthetic visual', { visual: { kind: 'diagram' } as never }),
      message('w1', 'user', 'Synthetic hidden news', { wakeUp: true, hiddenWakeUp: true }),
    ], activities: [
      activity('t1', 'u1', { kind: 'command', title: 'Ran', command: 'npm test', cwd: 'src', output: 'SECRET OUTPUT' }),
      activity('t2', 'u1', { kind: 'file-change', title: 'Edit', changes: [{ path: 'src/a.ts', kind: 'update', diff: 'SECRET DIFF' }] }),
      activity('t3', 'u1', { kind: 'tool', title: 'Read src/b.ts', output: 'SECRET FILE' }),
      activity('t4', 'u1', { kind: 'reasoning', title: 'Thinking', text: 'SECRET THOUGHT' }),
    ] })
    const text = historyText('Synthetic thread', quoted)
    expect(quoted).toMatchObject({ messages: 2, tools: 3, lastMessageId: 'r1' })
    for (const words of ['Synthetic request', 'Synthetic reply', 'ran `npm test` in src', 'changed src/a.ts (update)', 'used Read src/b.ts', 'Attached, not carried: screenshot.png', 'quoted as history']) {
      expect(text).toContain(words)
    }
    for (const hidden of ['SECRET', 'Synthetic visual', 'Synthetic hidden news']) expect(text).not.toContain(hidden)
  })

  it('sends a conversation too long for one prompt whole, in parts that each fit a send, in order', () => {
    const messages = Array.from({ length: 60 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user', `Synthetic message ${index} ${'x'.repeat(4_000)}`))
    messages.push(message('huge', 'assistant', `Synthetic huge ${'y'.repeat(150_000)} end of huge`))
    const parts = historyParts('Synthetic thread', quoteHistory({ provider: 'codex', messages, activities: [] }))
    expect(parts.length).toBeGreaterThan(2)
    const prompts = parts.map((part, index) => historyPartPrompt(index + 1, parts.length, part))
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(PROMPT_LIMIT)
    const all = parts.join('\n')
    for (let index = 0; index < 60; index++) expect(all).toContain(`Synthetic message ${index} `)
    expect(all).toContain('end of huge')
    expect(all.indexOf('Synthetic message 59 ')).toBeGreaterThan(all.indexOf('Synthetic message 0 '))
    expect(prompts[1]).toContain('This is part 2 of')
    expect(historyAboveWords(parts.length)).toContain(`in ${parts.length} parts`)
  })

  it('holds answers to the criteria the user set, said to be the user\'s', () => {
    const words = framingWords(undefined, 'A', ['fact'], [{ id: 'C1', source: 'user', text: 'Synthetic user criterion' }])
    expect(words).toContain('C1 (set by the user): Synthetic user criterion')
    expect(framingWords(undefined, 'A', ['decision'], [])).toContain('could not be read')
  })
})

describe('prompt sizes', () => {
  const long = (letter: string, size: number) => ({ letter, text: `${letter} ${'w'.repeat(size)}` })
  const preamble = `Synthetic preamble ${'p'.repeat(40_000)}`

  it('keeps a review, a verdict and a fairness check for a thread new to its seat under a send\'s limit', () => {
    const review = reviewPrompt({ preamble, ownAnswer: 'o'.repeat(80_000), letter: 'A', kind: 'decision', answers: [long('B', 80_000), long('C', 80_000)], ids: ['B1', 'C1'] })
    expect(review.length).toBeLessThanOrEqual(PROMPT_LIMIT)
    expect(review).toContain('[Cut here')
    const verdict = verdictPrompt({ preamble, question: 'q'.repeat(20_000), kinds: ['decision'], answers: ['A', 'B', 'C', 'D', 'E'].map(letter => long(letter, 60_000)),
      reviews: ['A', 'B', 'C', 'D', 'E'].map(letter => long(letter, 60_000)), leftOut: [], panelists: 5, cruxAllowed: true })
    expect(verdict.length).toBeLessThanOrEqual(PROMPT_LIMIT)
    expect(verdict).toContain('```council-crux')
    expect(fairnessPrompt({ preamble, ownAnswer: 'o'.repeat(90_000), letter: 'B', verdict: 'v'.repeat(200_000) }).length).toBeLessThanOrEqual(PROMPT_LIMIT)
  })

  it('gives a short text whole and lets a long one have the room it leaves', () => {
    const review = reviewPrompt({ letter: 'A', kind: 'decision', answers: [long('B', 100), long('C', 150_000)], ids: ['B1', 'C1'] })
    expect(review).toContain(`B ${'w'.repeat(100)}\n</answer B>`)
    expect(review.length).toBeLessThanOrEqual(PROMPT_LIMIT)
  })

  it('asks for an answer with the question verbatim, the framing\'s criteria by source and the panelist\'s angle', () => {
    const prompt = answerPrompt({ question: 'Synthetic question?' }, { letter: 'B', snapshot: 'commit abc on main', remote: false,
      framing: { kinds: ['decision'], criteria: [{ id: 'C1', source: 'assumed', text: 'Synthetic criterion' }], headings: ['Answer'], words: 300, angles: [{ seat: 'B', text: 'Synthetic angle' }], research: { needed: false, reason: '' } } })
    for (const words of ['<question>\nSynthetic question?\n</question>', 'C1 (assumed by the chair): Synthetic criterion', 'Also weigh: Synthetic angle', 'finding: B1 | observed']) expect(prompt).toContain(words)
    // Research is off: the panelist is told not to, and is given no source evidence to cite.
    expect(prompt).toContain('needs no outside research')
    expect(prompt).not.toContain('- source: a page')
    expect(prompt).not.toContain('| source |')
  })

  it('offers the chair a crux lookup only when the question needs outside research', () => {
    const input = { kinds: ['decision' as const], answers: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }], reviews: [], leftOut: [], panelists: 2, cruxAllowed: true }
    expect(verdictPrompt({ ...input, research: true })).toContain('lookup:')
    const without = verdictPrompt({ ...input, research: false })
    expect(without).not.toContain('lookup:')
    expect(without).toContain('giving a test to run in the working folder')
  })

  it('asks a reviewer for a verdict on every ID it was handed, and an ideas reviewer for every score', () => {
    expect(reviewPrompt({ letter: 'A', kind: 'decision', answers: [{ letter: 'B', text: 'x' }], ids: ['B1', 'B2'] })).toContain('Give every one of them a verdict')
    expect(reviewPrompt({ letter: 'A', kind: 'ideas', answers: [{ letter: 'B', text: 'x' }], ids: ['B1'] })).toContain('Score every one of them')
  })

  it('briefs outside research only when the round needs it, and asks for sources then', () => {
    const prompt = answerPrompt({ question: 'Synthetic question?' }, { letter: 'A', snapshot: 'commit abc on main', remote: false, framing: undefined, kinds: ['fact'], research: true, again: true })
    for (const words of ['needs outside research', 'with your own tools', '- source: a page', 'finding: A5 | source | https://', 'answer again from the start', 'answer it as a fact to check']) expect(prompt).toContain(words)
  })
})

describe('long fields', () => {
  it('are kept within what the saved record holds', () => {
    const quote = 'q'.repeat(3_000)
    const read = readFairnessBlock(['```council-fairness', 'fair: no', `claim: ${quote}`, `passage: ${quote.slice(0, 50)}`, '```'].join('\n'), quote)
    expect(read.ok && read.value.claim!.length).toBe(COUNCIL_FIELD_MAX)
    const record = { id: '00000000-0000-4000-8000-000000000000', createdAt: '2026-11-02T12:00:00.000Z', originThread: 'origin', originTitle: 'Synthetic', projectId: 'p',
      snapshot: { path: '/s', repositoryRoot: '/', commit: 'a'.repeat(40), branch: 'main', untracked: 0 }, history: { messages: 1, words: 1, tools: 0, parts: 1 },
      seats: ['A', 'B', 'chair'].map(seat => ({ seat, role: seat === 'chair' ? 'chair' : 'panelist', modelId: 'm', modelName: 'm', effort: null, thread: `t-${seat}`, formerThreads: [], started: true, context: true })),
      rounds: [{ index: 0, askedAt: '2026-11-02T12:00:00.000Z', stage: 'fairness', leftOut: [], objections: [{ seat: 'A', claim: read.ok ? read.value.claim : '', passage: 'q', answer: 'pending' }] }],
      turns: [], deadlineMinutes: 10 }
    expect(councilFileSchema.safeParse({ version: 1, councils: [record] }).success).toBe(true)
  })
})
