// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { citationQuoted, findCouncilBlock, parseCitation, readAmendBlock, readAnswerBlock, readCruxBlock, readCruxResultBlock, readFairnessBlock, readFramingBlock,
  readReviewBlock, withoutCouncilBlocks, type ReviewContext } from '../../../src/shared/councilBlocks'

const fence = (name: string, ...lines: string[]): string => ['```' + name, ...lines, '```'].join('\n')

describe('finding a result block', () => {
  it('takes the last block of that name and keeps the words around it apart', () => {
    const reply = ['Synthetic answer words.', fence('council-answer', 'answer: first'), 'More words.', fence('council-answer', 'answer: second')].join('\n')
    expect(findCouncilBlock(reply, 'council-answer')?.fields).toEqual([['answer', 'second']])
    expect(withoutCouncilBlocks(reply)).toBe('Synthetic answer words.\nMore words.')
  })

  it('says a reply without the block is missing, and a line that is not a field is unreadable', () => {
    expect(readAnswerBlock('Synthetic prose only.', 'A', [])).toMatchObject({ ok: false, missing: true })
    const unreadable = readAnswerBlock(fence('council-answer', 'answer: yes', 'this line has no field'), 'A', [])
    expect(unreadable).toMatchObject({ ok: false, missing: false })
    expect(unreadable.ok ? '' : unreadable.reason).toContain('line 2')
  })

  it('ignores other fences, such as code the answer quotes', () => {
    const reply = ['```ts', 'const answer = 1', '```', fence('council-answer', 'answer: Synthetic', 'finding: A1 | judgement | Synthetic claim')].join('\n')
    expect(readAnswerBlock(reply, 'A', [])).toMatchObject({ ok: true })
  })
})

describe('citations', () => {
  it('reads a path and lines inside the snapshot, and refuses one that leaves it', () => {
    expect(parseCitation('src/main/agents/threadStore.ts:120-134')).toEqual({ path: 'src/main/agents/threadStore.ts', start: 120, end: 134 })
    expect(parseCitation('`./src/a.ts:7`')).toEqual({ path: 'src/a.ts', start: 7, end: 7 })
    expect(parseCitation('src\\b.ts:3-4')).toEqual({ path: 'src/b.ts', start: 3, end: 4 })
    for (const outside of ['/etc/passwd:1', 'C:/x.ts:1', '../x.ts:1', 'src/../../x.ts:2', 'src/a.ts:9-3', 'src/a.ts', 'src/a.ts:0']) expect(parseCitation(outside), outside).toBeUndefined()
  })

  it('matches a citation only when the reply quotes every cited line with words in it, and says when the file is shorter', () => {
    const file = 'line one\nconst keep = readThread(id)\n}\n\nline five\n'
    const place = { path: 'a.ts', start: 2, end: 5 }
    expect(citationQuoted(file, place, 'It calls `const keep =   readThread(id)` first.\n}\nline five')).toBe(true)
    // One line of the range quoted is not the range.
    expect(citationQuoted(file, place, 'It calls `const keep = readThread(id)` first.')).toBe(false)
    expect(citationQuoted(file, place, 'It calls something else.')).toBe(false)
    // A range of blank and short lines quotes nothing, so it cannot match.
    expect(citationQuoted(file, { path: 'a.ts', start: 3, end: 4 }, '}')).toBe(false)
    expect(citationQuoted(file, { path: 'a.ts', start: 9, end: 9 }, 'anything')).toBeUndefined()
  })
})

describe('framing', () => {
  it('reads the kind, criteria by source, headings, a word limit and an angle for each panelist', () => {
    const read = readFramingBlock(fence('council-framing', 'kind: decision, fact', 'criterion: question | Keeps data local', 'criterion: assumed | Costs one request',
      'headings: Recommendation; Evidence', 'words: 400', 'angle: A | Weigh cost', 'angle: B | Weigh risk'), ['A', 'B', 'C'])
    expect(read).toEqual({ ok: true, value: { kinds: ['decision', 'fact'], criteria: [{ id: 'C1', source: 'question', text: 'Keeps data local' }, { id: 'C2', source: 'assumed', text: 'Costs one request' }],
      headings: ['Recommendation', 'Evidence'], words: 400, angles: [{ seat: 'A', text: 'Weigh cost' }, { seat: 'B', text: 'Weigh risk' }], research: { needed: false, reason: '' } } })
  })

  it('reads whether the question needs outside research, with why, and takes none when the field is left out', () => {
    const framing = (research: string) => readFramingBlock(fence('council-framing', 'kind: fact', 'criterion: question | x', 'headings: A', 'words: 300', research), ['A', 'B'])
    expect(framing('research: yes | The library changed its API last month')).toMatchObject({ ok: true, value: { research: { needed: true, reason: 'The library changed its API last month' } } })
    expect(framing('research: No | The snapshot holds everything')).toMatchObject({ ok: true, value: { research: { needed: false, reason: 'The snapshot holds everything' } } })
    expect(framing('research: maybe')).toMatchObject({ ok: false })
  })

  it('refuses an unknown kind, an unmarked criterion and an angle for a seat that is not there', () => {
    expect(readFramingBlock(fence('council-framing', 'kind: poem', 'criterion: question | x', 'headings: A', 'words: 300'), ['A', 'B'])).toMatchObject({ ok: false })
    expect(readFramingBlock(fence('council-framing', 'kind: fact', 'criterion: x', 'headings: A', 'words: 300'), ['A', 'B'])).toMatchObject({ ok: false })
    expect(readFramingBlock(fence('council-framing', 'kind: ideas', 'criterion: question | x', 'headings: A', 'words: 300', 'angle: D | y'), ['A', 'B'])).toMatchObject({ ok: false })
  })
})

describe('answers', () => {
  it('reads findings marked observed, inferred or judgement, with evidence for an observation', () => {
    const read = readAnswerBlock(fence('council-answer', 'answer: Ship it after 0.2',
      'finding: B1 | observed | src/main/a.ts:10-12 | The store reads once', 'finding: B2 | inferred | Startup stays fast', 'finding: B3 | observed | command | Tests pass',
      'challenge: C2 | false-premise | Nothing costs a request'), 'B', ['C1', 'C2'])
    expect(read.ok && read.value.findings.map(finding => [finding.id, finding.kind, finding.evidence])).toEqual([['B1', 'observed', 'src/main/a.ts:10-12'], ['B2', 'inferred', undefined], ['B3', 'observed', 'command']])
    expect(read.ok && read.value.challenges).toEqual([{ criterion: 'C2', problem: 'false-premise', why: 'Nothing costs a request' }])
  })

  it('reads a source as its link, the passage it supports, quoted, and its claim', () => {
    const read = readAnswerBlock(fence('council-answer', 'answer: Use 4.2', 'finding: A1 | source | https://example.org/docs/changelog#4.2 | "The | option was removed in 4.2." | The option is gone'), 'A', [])
    expect(read).toEqual({ ok: true, value: { answer: 'Use 4.2', challenges: [],
      findings: [{ id: 'A1', kind: 'source', evidence: 'https://example.org/docs/changelog#4.2', quote: 'The | option was removed in 4.2.', claim: 'The option is gone' }] } })
    expect(readAnswerBlock(fence('council-answer', 'answer: x', 'finding: A1 | source | “https://example.org” | “Curly quotes” | y'), 'A', [])).toMatchObject({ ok: false })
  })

  it('checks only a source\'s shape: a web link, a quoted passage and a claim', () => {
    const source = (line: string) => readAnswerBlock(fence('council-answer', 'answer: x', line), 'A', [])
    expect(source('finding: A1 | source | https://example.org/page | “A curly-quoted passage” | The claim')).toMatchObject({ ok: true })
    expect(source('finding: A1 | source | http://localhost:3000/x | "local" | claim')).toMatchObject({ ok: true })
    for (const bad of ['finding: A1 | source | not a link | "q" | c', 'finding: A1 | source | file:///etc/passwd | "q" | c', 'finding: A1 | source | https://example.org | unquoted passage | c',
      'finding: A1 | source | https://example.org | "q"', 'finding: A1 | source | ftp://example.org/x | "q" | c']) expect(source(bad), bad).toMatchObject({ ok: false })
  })

  it('refuses another panelist\'s IDs, an ID twice, an observation without evidence and an unknown criterion', () => {
    const answer = (...lines: string[]) => readAnswerBlock(fence('council-answer', 'answer: x', ...lines), 'A', ['C1'])
    expect(answer('finding: B1 | judgement | x')).toMatchObject({ ok: false })
    expect(answer('finding: A1 | judgement | x', 'finding: A1 | inferred | y')).toMatchObject({ ok: false })
    expect(answer('finding: A1 | observed | It just works')).toMatchObject({ ok: false })
    expect(answer('finding: A1 | judgement | x', 'challenge: C9 | wrong | y')).toMatchObject({ ok: false })
    expect(answer()).toMatchObject({ ok: false })
  })
})

describe('reviews', () => {
  const decision: ReviewContext = { letter: 'A', kind: 'decision', reviewed: new Map([['B', ['B1', 'B2']], ['C', ['C1']]]) }

  it('reads a decision review with a ranking of the answers it read and the claims it checked', () => {
    const read = readReviewBlock(fence('council-review', 'ranking: C > B', 'findings: B1 confirmed, B2 refuted, C1 unchecked', 'answer: same'), decision)
    expect(read).toMatchObject({ ok: true, value: { ranking: ['C', 'B'], findings: [{ id: 'B1', verdict: 'confirmed' }, { id: 'B2', verdict: 'rejected' }, { id: 'C1', verdict: 'unchecked' }], answer: 'same' } })
  })

  it('needs the ranking, uses only listed IDs once, and asks a changed answer for its new answer and evidence', () => {
    const review = (...lines: string[]) => readReviewBlock(fence('council-review', ...lines), decision)
    expect(review('answer: same')).toMatchObject({ ok: false })
    expect(review('ranking: B > D', 'answer: same')).toMatchObject({ ok: false })
    expect(review('ranking: B > C', 'findings: A1 confirmed', 'answer: same')).toMatchObject({ ok: false })
    expect(review('ranking: B > C', 'findings: B1 confirmed, B1 rejected', 'answer: same')).toMatchObject({ ok: false })
    const all = 'findings: B1 confirmed, B2 rejected, C1 unchecked'
    expect(review('ranking: B > C', all, 'answer: changed')).toMatchObject({ ok: false })
    expect(review('ranking: B > C', all, 'answer: changed', 'new_answer: Wait for 0.3', 'evidence: src/a.ts:1-2')).toMatchObject({ ok: true, value: { newAnswer: 'Wait for 0.3', evidence: ['src/a.ts:1-2'] } })
  })

  it('needs a verdict on every finding it was handed, so each count has the readers who checked it', () => {
    const review = (kind: ReviewContext['kind'], ...lines: string[]) => readReviewBlock(fence('council-review', ...lines), { ...decision, kind })
    expect(review('decision', 'ranking: B > C', 'findings: B1 confirmed, C1 unchecked', 'answer: same')).toMatchObject({ ok: false, reason: expect.stringContaining('B2') })
    expect(review('decision', 'ranking: B > C', 'answer: same')).toMatchObject({ ok: false })
    expect(review('fact', 'supports: B', 'findings: B1 confirmed, B2 confirmed', 'answer: same')).toMatchObject({ ok: false, reason: expect.stringContaining('C1') })
    expect(review('review', 'findings: B1 confirmed, B2 rejected')).toMatchObject({ ok: false })
    expect(review('ideas', 'scores: B1 4, C1 5', 'favourites: C1')).toMatchObject({ ok: false, reason: expect.stringContaining('B2') })
  })

  it('asks no ranking of a reader who read one answer, as with two panelists', () => {
    expect(readReviewBlock(fence('council-review', 'findings: B1 confirmed', 'answer: same'), { letter: 'A', kind: 'decision', reviewed: new Map([['B', ['B1']]]) })).toMatchObject({ ok: true })
  })

  it('lets a reviewer confirm, refute or leave unchecked a source, and a changed answer rest on one', () => {
    const context: ReviewContext = { letter: 'A', kind: 'decision', reviewed: new Map([['B', ['B1', 'B2']]]) }
    expect(readReviewBlock(fence('council-review', 'findings: B1 confirmed, B2 refuted', 'answer: changed', 'new_answer: Use 4.2', 'evidence: https://example.org/changelog'), context))
      .toMatchObject({ ok: true, value: { findings: [{ id: 'B1', verdict: 'confirmed' }, { id: 'B2', verdict: 'rejected' }], evidence: ['https://example.org/changelog'] } })
    expect(readReviewBlock(fence('council-review', 'answer: changed', 'new_answer: x', 'evidence: somewhere online'), context)).toMatchObject({ ok: false })
  })

  it('reads the kind-specific fields for a fact, a review and ideas', () => {
    const fact = readReviewBlock(fence('council-review', 'supports: A', 'findings: B1 confirmed, B2 rejected, C1 unchecked', 'answer: same'), { ...decision, kind: 'fact' })
    expect(fact).toMatchObject({ ok: true, value: { supports: 'A' } })
    expect(readReviewBlock(fence('council-review', 'findings: B1 confirmed, B2 rejected, C1 unchecked', 'answer: same'), { ...decision, kind: 'fact' })).toMatchObject({ ok: false })
    const review = readReviewBlock(fence('council-review', 'findings: B1 confirmed, B2 rejected, C1 unchecked', 'new: A4 | Missed a lock'), { ...decision, kind: 'review' })
    expect(review).toMatchObject({ ok: true, value: { added: [{ id: 'A4', claim: 'Missed a lock' }] } })
    expect(readReviewBlock(fence('council-review', 'findings: B1 confirmed', 'answer: changed', 'new_answer: x', 'evidence: a.ts:1'), { ...decision, kind: 'review' })).toMatchObject({ ok: false })
    const ideas = readReviewBlock(fence('council-review', 'scores: B1 4, B2 2, C1 5', 'favourites: C1, B1'), { ...decision, kind: 'ideas' })
    expect(ideas).toMatchObject({ ok: true, value: { scores: [{ id: 'B1', score: 4 }, { id: 'B2', score: 2 }, { id: 'C1', score: 5 }], favourites: ['C1', 'B1'] } })
    expect(readReviewBlock(fence('council-review', 'scores: B1 9', 'favourites: B1'), { ...decision, kind: 'ideas' })).toMatchObject({ ok: false })
  })

  it('refers to an answer whose block was unavailable by its letter alone', () => {
    const context: ReviewContext = { letter: 'A', kind: 'review', reviewed: new Map([['B', ['B']]]) }
    expect(readReviewBlock(fence('council-review', 'findings: B rejected'), context)).toMatchObject({ ok: true })
    expect(readReviewBlock(fence('council-review', 'findings: B1 rejected'), context)).toMatchObject({ ok: false })
  })
})

describe('crux check', () => {
  it('reads the chair\'s test, the sides and what each result would mean', () => {
    const read = readCruxBlock(fence('council-crux', 'test: npx vitest run tests/unit/a.test.ts', 'sides: A, C | B', 'if: passes => A is right', 'if: fails => B is right'), ['A', 'B', 'C'], true)
    expect(read).toMatchObject({ ok: true, value: { lookup: false, sides: [['A', 'C'], ['B']], meanings: [{ result: 'passes', meaning: 'A is right' }, { result: 'fails', meaning: 'B is right' }] } })
    const lookupBlock = fence('council-crux', 'lookup: https://example.org/changelog, the 4.2 entry', 'sides: A | B', 'if: removed => A', 'if: deprecated => B')
    expect(readCruxBlock(lookupBlock, ['A', 'B'], true)).toMatchObject({ ok: true, value: { test: 'https://example.org/changelog, the 4.2 entry', lookup: true } })
    // Without outside research a crux check is a test in the snapshot: a lookup is refused.
    expect(readCruxBlock(lookupBlock, ['A', 'B'], false)).toMatchObject({ ok: false, reason: expect.stringContaining('no outside research') })
    expect(readCruxBlock(fence('council-crux', 'test: x', 'lookup: y', 'sides: A | B', 'if: a => b', 'if: c => d'), ['A', 'B'], true)).toMatchObject({ ok: false })
    expect(readCruxBlock(fence('council-crux', 'test: x', 'sides: A | A', 'if: a => b', 'if: c => d'), ['A', 'B'], true)).toMatchObject({ ok: false })
    expect(readCruxBlock(fence('council-crux', 'test: x', 'sides: A | B', 'if: a => b'), ['A', 'B'], true)).toMatchObject({ ok: false })
  })

  it('reads the neutral panelist\'s result by the number of the meaning that came out', () => {
    expect(readCruxResultBlock(fence('council-crux-result', 'result: 3 passed', 'outcome: 1'), 2)).toEqual({ ok: true, value: { result: '3 passed', outcome: 1 } })
    expect(readCruxResultBlock(fence('council-crux-result', 'result: no output', 'outcome: inconclusive'), 2)).toMatchObject({ ok: true, value: { outcome: 'inconclusive' } })
    expect(readCruxResultBlock(fence('council-crux-result', 'result: x', 'outcome: 3'), 2)).toMatchObject({ ok: false })
  })
})

describe('fairness check', () => {
  const verdict = 'Recommendation: ship after 0.2.\nA argues the import is   slow on first start.'

  it('reads Fair, and Unfair with the claim and the verdict passage that misstates it', () => {
    expect(readFairnessBlock(fence('council-fairness', 'fair: yes'), verdict)).toEqual({ ok: true, value: { fair: true } })
    expect(readFairnessBlock(fence('council-fairness', 'fair: no', 'claim: "The import runs once"', 'passage: "A argues the import is slow on first start."'), verdict))
      .toEqual({ ok: true, value: { fair: false, claim: 'The import runs once', passage: 'A argues the import is slow on first start.' } })
  })

  it('refuses an objection without both quotes, or with a passage the verdict does not hold', () => {
    expect(readFairnessBlock(fence('council-fairness', 'fair: no', 'claim: x'), verdict)).toMatchObject({ ok: false })
    expect(readFairnessBlock(fence('council-fairness', 'fair: no', 'claim: x', 'passage: The chair never wrote this'), verdict)).toMatchObject({ ok: false })
    expect(readFairnessBlock(fence('council-fairness', 'fair: maybe'), verdict)).toMatchObject({ ok: false })
  })

  it('reads the chair\'s answer to every objection it was sent', () => {
    expect(readAmendBlock(fence('council-amend', 'objection: A | amended', 'objection: C | stands | The quote is exact'), ['A', 'C']))
      .toEqual({ ok: true, value: { objections: [{ seat: 'A', answer: 'amended' }, { seat: 'C', answer: 'stands', reason: 'The quote is exact' }] } })
    expect(readAmendBlock(fence('council-amend', 'objection: A | amended'), ['A', 'C'])).toMatchObject({ ok: false })
  })
})
