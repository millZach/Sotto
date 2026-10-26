/**
 * Vite's `import.meta.glob`, for main's code that a spec runs in Playwright's own Node process (#1579). The app's build
 * and Vitest load interface catalogs through Lingui's Vite plugin (ADR-0123), which Playwright's loader does not run, so
 * `viteGlobPlugin.cjs` turns each `import.meta.glob(...)` into a call to `viteGlob` here.
 *
 * It reads only what Sotto's code globs: `.po` catalogs, by paths relative to the file that globs them, with `*` inside a
 * file name and `!` to leave paths out. Each catalog is compiled as the Vite plugin compiles it: every message the
 * language's and the source language's catalogs hold, each the language's own translation, else its fallback languages',
 * else the source language's, then compiled with Lingui's own compiler and pseudo-localized for a pseudo-language.
 * `tests/unit/e2e/viteGlob.test.ts` holds every catalog to what Lingui's own pipeline makes of it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { createCompiledCatalog } from '@lingui/cli/api'
import { getConfig, type LinguiConfigNormalized } from '@lingui/conf'
import { formatter } from '@lingui/format-po'
import type { CompiledCatalog } from '../../../src/shared/interfaceCatalogLoader'

type CatalogEntry = { readonly message?: string; readonly translation?: string }
type Catalog = Readonly<Record<string, CatalogEntry>>

let config: LinguiConfigNormalized | undefined
const lingui = (): LinguiConfigNormalized => config ??= getConfig({ cwd: join(__dirname, '..', '..', '..'), skipValidation: true })
const parse = formatter().parse as (content: string) => Catalog

/** A catalog file's messages, or none when the language has no catalog in that folder. */
function readCatalog(file: string): Catalog | undefined {
  let content: string
  try { content = readFileSync(file, 'utf8') } catch { return undefined }
  return parse(content)
}

/** The languages a language falls back to, in order, as `lingui.config.ts` names them. */
function fallbacksOf(locale: string): string[] {
  const fallbackLocales = lingui().fallbackLocales || {}
  const named = fallbackLocales[locale], fallback = fallbackLocales.default
  const list = [...typeof named === 'string' ? [named] : named ?? [], ...typeof fallback === 'string' ? [fallback] : fallback ?? []]
  return [...new Set(list)].filter(item => item !== locale)
}

/** One `.po` catalog compiled as Lingui's Vite plugin compiles it (`{ messages }`). */
export function compileCatalog(file: string): CompiledCatalog {
  const { sourceLocale, pseudoLocale } = lingui()
  const locale = basename(file, '.po'), folder = dirname(file)
  const own = readCatalog(file) ?? {}, source = readCatalog(join(folder, `${sourceLocale}.po`)) ?? {}
  const fallbacks = fallbacksOf(locale).map(item => readCatalog(join(folder, `${item}.po`))).filter(item => item !== undefined)
  const messages: Record<string, string> = {}
  for (const [id, entry] of Object.entries({ ...source, ...own })) {
    messages[id] = own[id]?.translation || fallbacks.find(catalog => catalog[id]?.translation)?.[id]?.translation
      || source[id]?.translation || source[id]?.message || entry.message || id
  }
  const pseudo = (pseudoLocale as unknown as readonly { locale: string; options?: object }[] | undefined)?.find(item => item.locale === locale)
  const { source: compiled, errors } = createCompiledCatalog(locale, messages, { namespace: 'json',
    ...pseudo ? { pseudoLocale: pseudo.locale, ...pseudo.options ? { pseudoLocaleOptions: pseudo.options } : {} } : {} })
  if (errors.length) throw new Error(`The catalog ${file} has messages Lingui cannot compile: ${errors.map(error => error.id).join(', ')}.`)
  return JSON.parse(compiled) as CompiledCatalog
}

/** Whether a path, relative to the globbing file, matches a pattern whose only wildcard is `*` within one segment. */
const matches = (pattern: string, path: string): boolean => {
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')
  return new RegExp(`^${source}$`, 'u').test(path)
}

/** The paths a pattern finds, relative to `directory` as Vite keys them. Only the last segments may hold a `*`. */
function expand(directory: string, pattern: string): string[] {
  const segments = pattern.split('/')
  let found = ['']
  for (const segment of segments) {
    const next: string[] = []
    for (const path of found) {
      const joined = (name: string) => path ? `${path}/${name}` : name
      if (!segment.includes('*')) { next.push(joined(segment)); continue }
      let names: string[]
      try { names = readdirSync(join(directory, path)) } catch { continue }
      for (const name of names) if (matches(segment, name)) next.push(joined(name))
    }
    found = next
  }
  return found.map(path => posix.normalize(path)).map(path => path.startsWith('.') ? path : `./${path}`)
}

/**
 * `import.meta.glob(patterns, { eager })` from a file in `directory`: each `.po` catalog the patterns find and do not
 * leave out, keyed as Vite keys it, compiled at once when eager and on its first load otherwise.
 */
export function viteGlob(directory: string, patterns: string | readonly string[], options: { readonly eager?: boolean } = {}): Record<string, CompiledCatalog | (() => Promise<CompiledCatalog>)> {
  const list = typeof patterns === 'string' ? [patterns] : patterns
  const leftOut = list.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const found = new Set<string>()
  for (const pattern of list) if (!pattern.startsWith('!')) for (const path of expand(directory, pattern)) found.add(path)
  const result: Record<string, CompiledCatalog | (() => Promise<CompiledCatalog>)> = {}
  for (const path of [...found].sort()) {
    if (leftOut.some(pattern => matches(pattern, path))) continue
    if (!path.endsWith('.po')) throw new Error(`Playwright's stand-in for import.meta.glob reads only .po catalogs, not ${path}. Teach tests/e2e/support/viteGlob.ts the new kind of file.`)
    const file = join(directory, path)
    result[path] = options.eager ? compileCatalog(file) : () => Promise.resolve().then(() => compileCatalog(file))
  }
  return result
}
