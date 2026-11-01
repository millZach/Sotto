import { describe, expect, it } from 'vitest'
import { isTopEffort } from '../../../src/shared/topEffort'
import { ULTRACODE, withUltracode } from '../../../src/shared/ultracode'

/**
 * When the composer's trace lights (ADR-0019, October 26 amendment): at the top level of the levels the thread's model
 * offers, whatever its provider, and at Max where a level such as Ultracode sits past it. The iPhone keeps the same rule
 * in `SottoCore` (`EffortWords.isTop`), checked by `ThreadSettingsTests`.
 */
const claude = withUltracode(['low', 'medium', 'high', 'xhigh', 'max'])
const providers: Record<string, { readonly levels: readonly string[]; readonly top: readonly string[] }> = {
  codex: { levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], top: ['xhigh'] },
  claude: { levels: claude, top: ['max', ULTRACODE] },
  'claude without Ultracode (Watcher)': { levels: ['low', 'medium', 'high', 'xhigh', 'max'], top: ['max'] },
  'claude on a model without Extra high': { levels: withUltracode(['low', 'medium', 'high']), top: ['high'] },
  grok: { levels: ['low', 'medium', 'high'], top: ['high'] },
  muse: { levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'], top: ['max', 'ultra'] },
}

describe('isTopEffort', () => {
  for (const [provider, { levels, top }] of Object.entries(providers)) {
    it(`lights ${provider} at ${top.join(' and ')} and nowhere else`, () => {
      for (const level of levels) expect(isTopEffort(levels, level), level).toBe(top.includes(level))
    })
  }

  it('lights Claude at Max and at Ultracode', () => {
    expect(claude).toContain(ULTRACODE)
    expect(isTopEffort(claude, 'max')).toBe(true)
    expect(isTopEffort(claude, ULTRACODE)).toBe(true)
    expect(isTopEffort(claude, 'xhigh')).toBe(false)
  })

  it('lights nothing for a model with one level, none, or the provider default', () => {
    expect(isTopEffort(['max'], 'max')).toBe(false)
    expect(isTopEffort([], 'max')).toBe(false)
    expect(isTopEffort(claude, '')).toBe(false)
    expect(isTopEffort(['low', 'high'], 'max')).toBe(false)
  })
})
