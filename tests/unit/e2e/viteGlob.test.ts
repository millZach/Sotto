// @vitest-environment node
/**
 * Playwright's stand-in for Vite's `import.meta.glob` (#1579) against the real thing. Vitest compiles `.po` catalogs
 * through Lingui's Vite plugin, the transform the app's build runs (ADR-0123), so every catalog it globs here is what the
 * app ships, and the stand-in must compile each to exactly the same messages, pseudo-languages included.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompiledCatalog } from '../../../src/shared/interfaceCatalogLoader'
import { compileCatalog, viteGlob } from '../../e2e/support/viteGlob'

const built = import.meta.glob<CompiledCatalog>('../../../src/locales/*/*.po', { eager: true })
const main = join(__dirname, '..', '..', '..', 'src', 'main')

describe("Playwright's stand-in for import.meta.glob (#1579)", () => {
  it("compiles every catalog to the messages Lingui's Vite plugin makes of it", () => {
    const paths = Object.keys(built)
    // Seven areas, each with English, its translations and the two pseudo-languages.
    expect(paths.length).toBeGreaterThan(7 * 3)
    expect(paths.some(path => path.endsWith('/en-XA.po')) && paths.some(path => path.endsWith('/ar-XB.po'))).toBe(true)
    for (const path of paths) expect(compileCatalog(join(__dirname, path)).messages, path).toEqual(built[path]!.messages)
  })

  it("finds what main's globs find, keyed as Vite keys them, eager or loaded on demand", async () => {
    const eager = viteGlob(main, ['../locales/main/en.po', '../locales/shared/en.po'], { eager: true })
    expect(Object.keys(eager)).toEqual(['../locales/main/en.po', '../locales/shared/en.po'])
    expect((eager['../locales/main/en.po'] as CompiledCatalog).messages).toEqual(built['../../../src/locales/main/en.po']!.messages)

    const lazy = viteGlob(main, ['../locales/main/*.po', '../locales/shared/*.po', '!../locales/*/en.po'])
    const expected = Object.keys(built).filter(path => /\/locales\/(main|shared)\/[^/]+\.po$/u.test(path) && !path.endsWith('/en.po'))
      .map(path => path.replace('../../../src/locales/', '../locales/')).sort()
    expect(Object.keys(lazy).sort()).toEqual(expected)
    const french = lazy['../locales/main/fr.po']
    expect(typeof french).toBe('function')
    expect((await (french as () => Promise<CompiledCatalog>)()).messages).toEqual(built['../../../src/locales/main/fr.po']!.messages)
  })

  it('refuses a kind of file it cannot compile, naming where to teach it', () => {
    expect(() => viteGlob(main, ['./*.ts'], { eager: true })).toThrow(/reads only \.po catalogs/u)
  })
})
