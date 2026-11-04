import { describe, expect, it } from 'vitest'
import { DEFAULT_DYNAMIC_THREADS, isDynamicThread, parseDynamicThreadSettings, whyNotDynamic } from '../../../src/shared/dynamicThreads'
import { isOwlFeatureEnabled } from '../../../src/shared/owlFeatures'

describe('Dynamic threads (ADR-0191)', () => {
  it('holds the feature in Owl until Zach sends it', () => {
    expect(isOwlFeatureEnabled('dynamic-threads', 'owl')).toBe(true)
    expect(isOwlFeatureEnabled('dynamic-threads', 'stable')).toBe(false)
  })

  it('has no allowed list until the user has seen one, and four workers at Extra high', () => {
    expect(DEFAULT_DYNAMIC_THREADS).toEqual({ highestEffort: 'xhigh', workersAtOnce: 4 })
    expect(parseDynamicThreadSettings(undefined)).toEqual(DEFAULT_DYNAMIC_THREADS)
    expect(parseDynamicThreadSettings({ providers: [], highestEffort: 'high', workersAtOnce: 2 })).toEqual({ providers: [], highestEffort: 'high', workersAtOnce: 2 })
  })

  it('loses only the value that is damaged', () => {
    expect(parseDynamicThreadSettings({ providers: ['claude', 'no-such-provider'], highestEffort: 'high', workersAtOnce: 2 })).toEqual({ highestEffort: 'high', workersAtOnce: 2 })
    expect(parseDynamicThreadSettings({ providers: ['claude'], highestEffort: 'very high', workersAtOnce: 2 })).toEqual({ providers: ['claude'], highestEffort: 'xhigh', workersAtOnce: 2 })
    expect(parseDynamicThreadSettings({ providers: ['claude'], highestEffort: 'high', workersAtOnce: 0 })).toEqual({ providers: ['claude'], highestEffort: 'high', workersAtOnce: 4 })
    expect(parseDynamicThreadSettings({ providers: ['codex', 'codex'], extra: true })).toEqual({ providers: ['codex'], ...DEFAULT_DYNAMIC_THREADS })
  })

  it.each([
    [{ providerId: 'grok' }, 'Only a Claude Code or Codex thread'],
    [{}, 'Only a Claude Code or Codex thread'],
    [{ providerId: 'claude', delegatedBy: 'parent' }, 'A thread another thread started'],
    [{ providerId: 'codex', remoteHost: { hostId: 'forge', name: 'forge' } }, 'A thread on another machine'],
    [{ providerId: 'codex', kind: 'personal' }, 'Only a thread in a project'],
    [{ providerId: 'codex', archivedAt: '2026-11-04T00:00:00.000Z' }, 'An archived thread'],
  ] as const)('says why %j cannot be Dynamic', (thread, words) => {
    expect(whyNotDynamic(thread as never)).toContain(words)
    expect(isDynamicThread({ ...thread, dynamic: true } as never, true)).toBe(false)
  })

  it('reads the mark only on a thread that can hold it, while the feature is on', () => {
    expect(whyNotDynamic({ providerId: 'claude' } as never)).toBeUndefined()
    expect(isDynamicThread({ providerId: 'claude', dynamic: true } as never, true)).toBe(true)
    expect(isDynamicThread({ providerId: 'codex', dynamic: true } as never, true)).toBe(true)
    expect(isDynamicThread({ providerId: 'claude' } as never, true)).toBe(false)
    expect(isDynamicThread({ providerId: 'claude', dynamic: true } as never, false)).toBe(false)
  })
})
