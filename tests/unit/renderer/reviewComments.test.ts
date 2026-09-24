import { describe, expect, it, vi } from 'vitest'
import {
  composeReviewMessage, MAX_REVIEW_COMMENTS, ReviewCommentStore, reviewCommentText, reviewLabel, reviewRange, type ReviewLine,
} from '../../../src/renderer/src/agents/reviewComments'

const add = (newLine: number, text: string): ReviewLine => ({ kind: 'add', text, oldLine: null, newLine })
const remove = (oldLine: number, text: string): ReviewLine => ({ kind: 'remove', text, oldLine, newLine: null })
const context = (oldLine: number, newLine: number, text: string): ReviewLine => ({ kind: 'context', text, oldLine, newLine })

describe('review comment names', () => {
  it('names new-file lines, and old ones marked (before) only when every line was removed', () => {
    const lines = [remove(12, '  const clip = await speak(v, SAMPLE)'), add(12, '  if (!key) return { ok: false }'), add(13, '  const clip = await speak(v, SAMPLE, 2)')]
    expect(reviewRange(lines)).toEqual({ first: 12, last: 13, before: false })
    expect(reviewLabel({ path: 'src/main/voice.ts', lines })).toBe('voice.ts L12 to L13')
    expect(reviewLabel({ path: 'src/main/voice.ts', lines }, true)).toBe('src/main/voice.ts L12 to L13')
    expect(reviewLabel({ path: 'src/main/keychain.ts', lines: [remove(4, 'a'), remove(5, 'b')] })).toBe('keychain.ts L4 to L5 (before)')
    expect(reviewLabel({ path: 'README.md', lines: [context(3, 7, 'keep')] })).toBe('README.md L7')
  })
})

describe('the text a comment sends', () => {
  it('follows the user’s message with each comment and its lines as a fenced diff', () => {
    const comments = [
      { path: 'src/main/voice.ts', lines: [add(12, '  if (!key) return { ok: false }'), add(13, '  const clip = await speak(v, SAMPLE, 2)')], text: ' Say why it returns early. ' },
      { path: 'src/main/keychain.ts', lines: [remove(4, '  const file = settingsPath()'), remove(5, '  writeJson(file, { xaiKey: k })')], text: 'Does anything still read xaiKey?' },
    ]
    expect(composeReviewMessage('  Tighten these two before we merge.\n', comments)).toBe([
      'Tighten these two before we merge.',
      '',
      'Comment on `src/main/voice.ts L12 to L13`:',
      '',
      'Say why it returns early.',
      '',
      '```diff',
      '+  if (!key) return { ok: false }',
      '+  const clip = await speak(v, SAMPLE, 2)',
      '```',
      '',
      'Comment on `src/main/keychain.ts L4 to L5 (before)`:',
      '',
      'Does anything still read xaiKey?',
      '',
      '```diff',
      '-  const file = settingsPath()',
      '-  writeJson(file, { xaiKey: k })',
      '```',
    ].join('\n'))
  })

  it('sends the comments alone when there is no message, and a context line keeps its leading space', () => {
    expect(composeReviewMessage('   ', [{ path: 'a.ts', lines: [context(1, 1, 'keep')], text: 'Why?' }])).toBe('Comment on `a.ts L1`:\n\nWhy?\n\n```diff\n keep\n```')
  })

  it('never lets quoted backticks close the fence or the name early', () => {
    const text = reviewCommentText({ path: 'docs/`odd`.md', lines: [add(2, '```ts'), add(3, '````')], text: 'Fence' })
    expect(text).toBe('Comment on ``docs/`odd`.md L2 to L3``:\n\nFence\n\n`````diff\n+```ts\n+````\n`````')
  })
})

describe('the review comment store', () => {
  const store = (): ReviewCommentStore => { let id = 0; return new ReviewCommentStore(() => `c${++id}`) }

  it('keeps each thread’s comments apart, deletes one, and takes the sent ones off', () => {
    const comments = store()
    const listener = vi.fn()
    comments.subscribe(listener)
    expect(comments.add('t1', { path: 'a.ts', lines: [add(1, 'a')], text: ' first ' })).toMatchObject({ id: 'c1', threadId: 't1', text: 'first' })
    comments.add('t1', { path: 'b.ts', lines: [add(2, 'b')], text: 'second' })
    comments.add('t2', { path: 'a.ts', lines: [add(1, 'a')], text: 'other thread' })
    expect(comments.list('t1').map(item => item.id)).toEqual(['c1', 'c2'])
    comments.remove('t1', 'c1')
    expect(comments.list('t1').map(item => item.id)).toEqual(['c2'])
    comments.sent('t1', ['c2'])
    expect(comments.list('t1')).toEqual([])
    expect(comments.list('t2')).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(5)
  })

  it('refuses an empty comment, one with no lines, and one past the most a message carries', () => {
    const comments = store()
    expect(comments.add('t', { path: 'a.ts', lines: [add(1, 'a')], text: '   ' })).toBeNull()
    expect(comments.add('t', { path: 'a.ts', lines: [], text: 'x' })).toBeNull()
    for (let index = 0; index < MAX_REVIEW_COMMENTS; index++) comments.add('t', { path: 'a.ts', lines: [add(index + 1, 'a')], text: 'x' })
    expect(comments.full('t')).toBe(true)
    expect(comments.add('t', { path: 'a.ts', lines: [add(99, 'a')], text: 'one more' })).toBeNull()
    expect(comments.list('t')).toHaveLength(MAX_REVIEW_COMMENTS)
  })

  it('keeps a draft with words in it rather than replacing it, and drops only an empty one on a click elsewhere', () => {
    const comments = store()
    comments.openDraft('t', 'a.ts', [add(1, 'a')])
    comments.closeEmptyDraft('t')
    expect(comments.draft('t')).toBeNull()
    comments.openDraft('t', 'a.ts', [add(1, 'a')])
    comments.editDraft('t', 'Explain this')
    comments.closeEmptyDraft('t')
    expect(comments.openDraft('t', 'b.ts', [add(9, 'b')])).toMatchObject({ path: 'a.ts', text: 'Explain this' })
    expect(comments.addDraft('t')).toMatchObject({ path: 'a.ts', text: 'Explain this' })
    expect(comments.draft('t')).toBeNull()
    comments.openDraft('t', 'b.ts', [add(9, 'b')])
    comments.closeDraft('t')
    expect(comments.draft('t')).toBeNull()
  })
})
