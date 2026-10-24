// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { agentCommandSchema, agentStateSchema } from '../../../src/shared/agents'
import { OWL_FEATURES, isOwlFeatureEnabled } from '../../../src/shared/owlFeatures'
import { DEFAULT_SETTINGS, parseSettings } from '../../../src/shared/settings'
import { quietLongerThan, THREAD_CLEAR_KEPT_REASONS, threadClearKeptWords, threadQuietSince } from '../../../src/shared/threadClear'

const DAY = 86_400_000

describe('clearing settled threads (ADR-0126)', () => {
  it('words every kept reason as a short lower-case clause', () => {
    for (const reason of THREAD_CLEAR_KEPT_REASONS) {
      const words = threadClearKeptWords(reason)
      expect(words.length, reason).toBeGreaterThan(0)
      expect(words.length, reason).toBeLessThan(80)
      expect(words.endsWith('.'), reason).toBe(false)
      // Watcher is a name, so its clause may open with a capital; every other one reads after a title.
      if (reason !== 'watched') expect(words[0], reason).toBe(words[0]!.toLowerCase())
    }
    expect(threadClearKeptWords('uncommitted')).toBe('uncommitted changes in its worktree')
    expect(threadClearKeptWords('pull-request')).toBe('pull request still open')
  })

  it('dates a thread from the later of its settle and its last activity, its own settle first', () => {
    const project = { workspaceSettledAt: '2026-09-01T00:00:00.000Z' }
    expect(threadQuietSince({ workspaceSettledAt: null, updatedAt: '2026-08-01T00:00:00.000Z' }, { workspaceSettledAt: null })).toBeUndefined()
    // The project's settle applies when the thread has none of its own.
    expect(threadQuietSince({ workspaceSettledAt: null, updatedAt: '2026-08-01T00:00:00.000Z' }, project)).toBe(Date.parse('2026-09-01T00:00:00.000Z'))
    // A thread written to after it was settled is as old as that write.
    expect(threadQuietSince({ workspaceSettledAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }, project)).toBe(Date.parse('2026-10-01T00:00:00.000Z'))
    expect(threadQuietSince({ workspaceSettledAt: '2026-09-02T00:00:00.000Z', summary: { messageCount: 1, activityCount: 0, lastMessageAt: '2026-09-05T00:00:00.000Z' } })).toBe(Date.parse('2026-09-05T00:00:00.000Z'))
  })

  it('takes every settled thread at any age, and only older ones otherwise', () => {
    const now = Date.parse('2026-10-23T00:00:00.000Z')
    expect(quietLongerThan(now, 0, now)).toBe(true)
    expect(quietLongerThan(now - 7 * DAY, 7, now)).toBe(false)
    expect(quietLongerThan(now - 7 * DAY - 1, 7, now)).toBe(true)
    expect(quietLongerThan(now - 29 * DAY, 30, now)).toBe(false)
  })

  it('offers only the ages Settings names, and at most a thousand threads to one Clear', () => {
    expect(agentCommandSchema.safeParse({ type: 'preview-clear-threads', olderThanDays: 0 }).success).toBe(true)
    expect(agentCommandSchema.safeParse({ type: 'preview-clear-threads', olderThanDays: 90 }).success).toBe(true)
    expect(agentCommandSchema.safeParse({ type: 'preview-clear-threads', olderThanDays: 180 }).success).toBe(false)
    expect(agentCommandSchema.safeParse({ type: 'clear-threads', olderThanDays: 7, threadIds: Array.from({ length: 1_000 }, (_, index) => `t${index}`) }).success).toBe(true)
    expect(agentCommandSchema.safeParse({ type: 'clear-threads', olderThanDays: 7, threadIds: Array.from({ length: 1_001 }, (_, index) => `t${index}`) }).success).toBe(false)
    expect(agentCommandSchema.safeParse({ type: 'delete-thread', threadId: 't', confirmedIgnored: ['dist/'] }).success).toBe(true)
  })

  it('carries each answer on the reply it belongs to', () => {
    const parsed = agentStateSchema.shape.threadClearResult.parse({ cleared: 2, kept: [{ threadId: 't', title: 'Fix login', projectTitle: 'Sotto', reason: 'pull-request' }] })
    expect(parsed?.kept[0]?.reason).toBe('pull-request')
    expect(agentStateSchema.shape.threadDeletePreview.parse({ threadId: 't', kept: null, worktree: null })).toEqual({ threadId: 't', kept: null, worktree: null })
  })

  it('is Never by default, kept on every track, and an Owl feature until it is sent to stable', () => {
    expect(DEFAULT_SETTINGS.clearSettledThreadsAfterDays).toBeNull()
    expect(parseSettings({ clearSettledThreadsAfterDays: 180 }).clearSettledThreadsAfterDays).toBe(180)
    expect(parseSettings({ clearSettledThreadsAfterDays: 14 }).clearSettledThreadsAfterDays).toBeNull()
    expect(OWL_FEATURES.find(feature => feature.id === 'clear-threads')?.sentToStable).toBe(false)
    expect(isOwlFeatureEnabled('clear-threads', 'owl')).toBe(true)
    expect(isOwlFeatureEnabled('clear-threads', 'stable')).toBe(false)
  })
})
