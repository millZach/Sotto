import { expect, it } from 'vitest'
import { watcherCardLine, watcherNewsText, watcherPermissionCardLine, watcherWaitingCardWords } from '../../../src/main/agents/watcherNews'
import type { WatcherEvent } from '../../../src/shared/watcherNews'
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

// November 10, 2026 (#2433): VellCAD's permission cards reached Watcher as "waits on the user" and nothing else, so it could not
// tell Zach what they asked. Zach's pick: the tool and the model's own summary, never the command.
it('says which tool a permission card asks for and its summary, never its command, path or fields (#2433)', () => {
  const card = (context: AgentRequest['context']): AgentRequest => ({ id: 'perm', kind: 'permission', text: 'GH_TOKEN=secret gh pr merge 12', options: [], ...context ? { context } : {} })
  const line = watcherPermissionCardLine(card({ toolName: 'Bash', command: 'GH_TOKEN=secret gh pr merge 12', cwd: '/home/someone/project', summary: 'Merges the pull request', target: '/home/someone/secret.txt', details: 'token: secret' }))!
  expect(line).toBe('It asks to use "Bash". Its summary, in the worker\'s words: "Merges the pull request".')
  expect(line).not.toContain('secret'); expect(line).not.toContain('someone')
  // A summary Sotto asked the thread's provider for is not the worker's (ADR-0185).
  expect(watcherPermissionCardLine(card({ toolName: 'Bash', summary: 'Merges the pull request', summaryAsk: 'answered' })))
    .toBe('It asks to use "Bash". Its summary, written for the card by its thread\'s provider when the worker gave none: "Merges the pull request".')
  // No summary yet: the tool alone. Neither: nothing, as before.
  expect(watcherPermissionCardLine(card({ toolName: 'Edit', target: '/home/someone/a.ts' }))).toBe('It asks to use "Edit".')
  expect(watcherPermissionCardLine(card({ command: 'rm -rf build' }))).toBeUndefined()
  expect(watcherPermissionCardLine(card(undefined))).toBeUndefined()
  expect(watcherPermissionCardLine({ kind: 'question', context: { toolName: 'Bash' } })).toBeUndefined()
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

it('gives the web links the card shows: in its words and in the agent\'s message it follows (#2230)', () => {
  const words = watcherWaitingCardWords({ kind: 'question', text: 'Pick one at https://forge.example.ts.net/proto/index.html.', options: [] },
    'Both takes are up: http://localhost:5173/rail and https://forge.example.ts.net/proto/index.html')!
  expect(words.links).toEqual(['https://forge.example.ts.net/proto/index.html', 'http://localhost:5173/rail'])
  expect(watcherCardLine(words)).toContain('Its links: https://forge.example.ts.net/proto/index.html, http://localhost:5173/rail.')
})

it('lets every reply\'s words give way before a waiting question\'s in a crowded note (#2230)', () => {
  const hostId = '6f1c2a5e-8d3b-4c7a-9e21-0b5d7f3a1c42', requestId = '3b9e7d21-4a6c-4f8e-b1d2-7c5a9e0f3b18', at = '2026-11-05T12:00:00.000Z'
  const target = (n: number) => ({ hostId, threadId: `thread-${n}` })
  const finished = Array.from({ length: 30 }, (_, n): WatcherEvent => ({ id: `f${n}`, kind: 'turn-finished', requestId, target: target(n), generation: 1, observedAt: at, turnId: `t${n}` }))
  const asked = Array.from({ length: 12 }, (_, n): WatcherEvent => ({ id: `q${n}`, kind: 'needs-user', requestId, target: target(100 + n), generation: 1, observedAt: at, requestCardId: `c${n}`, requestCardKind: 'question' }))
  const text = watcherNewsText({ source: 'watcher', watcher: { hostId, threadId: 'watcher' }, omitted: 0, events: [...asked, ...finished] },
    event => event.kind === 'needs-user' ? `Its question, in the worker's words: "Which take for ${event.requestCardId}?".` : `Its whole reply, in the worker's words: "${'x'.repeat(480)}".`)
  for (let n = 0; n < 12; n++) expect(text).toContain(`Which take for c${n}?`)
  expect(text).not.toContain('omitted')
})
