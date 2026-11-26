// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { modLookReachesOutside } from '../../../src/shared/mods'

describe('modLookReachesOutside (ADR-0217)', () => {
  it('lets a look that loads nothing through, data: pictures and #fragments included', () => {
    expect(modLookReachesOutside('[data-part="sidebar"] { background: var(--tt-surface); }')).toBe(false)
    expect(modLookReachesOutside('[data-part="sidebar"] { background: url("data:image/png;base64,AAAA") center / cover; }')).toBe(false)
    expect(modLookReachesOutside("[data-part='composer'] { mask: url( '#round' ); }")).toBe(false)
    expect(modLookReachesOutside('@font-face { font-family: Mine; src: url(data:font/woff2;base64,AAAA); }')).toBe(false)
  })

  it('refuses a look that reaches outside Sotto', () => {
    for (const look of [
      '@import "https://example.com/x.css";',
      '[data-part="sidebar"] { background: url(https://example.com/x.png); }',
      "[data-part='sidebar'] { background: url('file:///etc/hosts'); }",
      '[data-part="sidebar"] { background: URL( //example.com/x.png ); }',
      '[data-part="sidebar"] { background: image-set("x.png" 1x); }',
      '[data-part="sidebar"] { background: src("x.png"); }',
    ]) expect(modLookReachesOutside(look), look).toBe(true)
  })

  it('reads CSS escapes as the browser does, so an escaped url( is still a url(', () => {
    expect(modLookReachesOutside('[data-part="sidebar"] { background: \\75 rl(https://example.com/x.png); }')).toBe(true)
    expect(modLookReachesOutside('[data-part="sidebar"] { background: u\\rl(https://example.com/x.png); }')).toBe(true)
    expect(modLookReachesOutside('@\\69mport "https://example.com/x.css";')).toBe(true)
  })

  it('ignores what a comment says', () => {
    expect(modLookReachesOutside('/* was url(https://example.com/x.png) */ [data-part="strip"] { opacity: 0.9; }')).toBe(false)
  })
})
