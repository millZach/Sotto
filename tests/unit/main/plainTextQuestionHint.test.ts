import { describe, expect, it } from 'vitest'
import { looksLikePlainTextQuestionCard, PLAIN_TEXT_QUESTION_HINT } from '../../../src/main/agents/plainTextQuestionHint'
import { watcherReplyStart } from '../../../src/main/agents/watcherNews'

describe('plainTextQuestionHint', () => {
  it('flags finished replies that present a plain-text option menu instead of calling the card tool', () => {
    expect(looksLikePlainTextQuestionCard([
      'Here are the two takes I mocked up.',
      'A) Option A — Dark left rail with compact header',
      'B) Option B — Floating bottom bar',
      'Which variant would you like me to keep?',
    ].join('\n'))).toBe(true)

    expect(looksLikePlainTextQuestionCard([
      'Question card: ready to ship?',
      '1. Commit & open PR',
      '2. Keep changes local',
      'Reply with 1 or 2.',
    ].join('\n'))).toBe(true)
  })

  it('ignores normal summaries, changelogs, checklists, and code blocks', () => {
    expect(looksLikePlainTextQuestionCard([
      'Done! Summary of changes:',
      '1. Updated antigravity.ts',
      '2. Added unit tests',
      'All checks passed.',
    ].join('\n'))).toBe(false)

    expect(looksLikePlainTextQuestionCard([
      'Completed tasks:',
      '- [x] Option 1 verified',
      '- [x] Option 2 verified',
      'Which option ran first? The changelog explains it above.',
    ].join('\n'))).toBe(false)

    expect(looksLikePlainTextQuestionCard([
      'Example menu formatting:',
      '```markdown',
      '1. First option',
      '2. Second option',
      'Which option should I pick?',
      '```',
      'Everything is merged and pushed.',
    ].join('\n'))).toBe(false)
  })

  it('appends the hint to watcherReplyStart only when no question card is already open', () => {
    const thread = { status: 'idle' as const, lastTurn: { id: 't1', status: 'completed' as const } }
    const reply = { text: '1. Commit and push\n2. Amend PR\nWhich option should I take?' }
    expect(watcherReplyStart(thread, 't1', reply, false, false, false)).toContain(PLAIN_TEXT_QUESTION_HINT)
    expect(watcherReplyStart(thread, 't1', reply, false, false, true)).not.toContain(PLAIN_TEXT_QUESTION_HINT)
  })
})
