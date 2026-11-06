import { expect, it } from 'vitest'
import { watcherCardLine, watcherWaitingCardWords } from '../../../src/main/agents/watcherNews'
import { watcherCardWordsSchema } from '../../../src/shared/watcher'
import type { AgentRequest } from '../../../src/shared/agents'

// #2230: Watcher guessed what cards asked. A waiting question's own words go with its row and its news, read only.
const page = (name: string) => ({ token: 'a'.repeat(32), kind: 'file' as const, name, start: name })
const choice = (label: string) => ({ id: label, label })

it('gives a question card\'s headline, choices and prototype pages, never a page\'s token or a permission\'s words (#2230)', () => {
  const asked: AgentRequest = { id: 'card', kind: 'question', text: 'fallback', options: [], pages: [page('docs/prototypes/rail.html')],
    questions: [{ id: 'q1', header: 'Rail', question: 'Which rail do you want?', options: [choice('A, tinted'), choice('B, plain')], multiSelect: false, allowFreeText: true },
      { id: 'q2', question: 'Ship it?', options: [], multiSelect: false, allowFreeText: true }] }
  const words = watcherWaitingCardWords(asked)!
  expect(words).toEqual({ question: 'Rail: Which rail do you want?', choices: ['A, tinted', 'B, plain'], moreQuestions: 1, prototype: ['docs/prototypes/rail.html'] })
  expect(watcherCardWordsSchema.parse(words)).toEqual(words)
  expect(watcherCardLine(words)).toBe('Its question, in the worker\'s words: "Rail: Which rail do you want?". Its choices: "A, tinted", "B, plain". The card asks 1 more question. Its prototype: "docs/prototypes/rail.html".')
  expect(watcherCardLine(words)).not.toContain('a'.repeat(32))
  // A plain question gives its text and options.
  expect(watcherWaitingCardWords({ kind: 'question', text: 'Merge now?', options: [choice('Merge'), choice('Wait')] })).toEqual({ question: 'Merge now?', choices: ['Merge', 'Wait'] })
  // A permission request's words can carry a command's arguments, so none go.
  expect(watcherWaitingCardWords({ kind: 'permission', text: 'GH_TOKEN=secret gh pr merge', options: [] })).toBeUndefined()
})

it('keeps a card\'s words short: the question, eight choices and how many more (#2230)', () => {
  const long = '🦉'.repeat(400)
  const words = watcherWaitingCardWords({ kind: 'question', text: long, options: Array.from({ length: 11 }, (_, n) => choice(`${n} ${'x'.repeat(200)}`)) })!
  expect([...words.question]).toHaveLength(300)
  expect(words.choices).toHaveLength(8)
  expect(words.choices.every(label => [...label].length <= 100)).toBe(true)
  expect(words.moreChoices).toBe(3)
  expect(watcherCardWordsSchema.safeParse(words).success).toBe(true)
  expect(watcherCardLine(words)).toContain(', and 3 more.')
})
