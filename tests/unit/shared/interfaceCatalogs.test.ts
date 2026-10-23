// @vitest-environment node
import { getConfig } from '@lingui/conf'
import { getCatalogs } from '@lingui/cli/api'
import { parse, type Token } from '@messageformat/parser'
import { beforeAll, describe, expect, it } from 'vitest'

import { INTERFACE_LANGUAGE_CODES, SOURCE_INTERFACE_LANGUAGE } from '../../../src/shared/interfaceLanguages'

/**
 * The interface catalogs (ADR-0123), checked the way CI must before a pull request merges. A build shows a message by
 * its id, so a message the code writes and the catalog lacks would show as that id: every catalog carries every message,
 * and `npm run i18n:extract` is how it gets there. A language may leave a message untranslated (it shows in English);
 * what it writes must parse and name the same placeholders as English.
 */
type Catalog = Awaited<ReturnType<typeof getCatalogs>>[number]
type Entries = Awaited<ReturnType<Catalog['read']>>

const config = getConfig({ cwd: process.cwd() })
let catalogs: Catalog[] = []
const areaOf = (catalog: Catalog): string => catalog.path.replaceAll('\\', '/').split('/').at(-2) ?? catalog.path

/** The argument names a message uses, `#` aside: plural and select keys are each language's own. */
function placeholdersOf(message: string): string[] {
  const names = new Set<string>()
  const walk = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      if (token.type === 'argument' || token.type === 'function') names.add(token.arg)
      if (token.type === 'plural' || token.type === 'select' || token.type === 'selectordinal') {
        names.add(token.arg)
        for (const select of token.cases) walk(select.tokens)
      }
    }
  }
  walk(parse(message))
  return [...names].sort()
}

function problemsOf(locale: string, source: NonNullable<Entries>, entries: Entries): string[] {
  if (entries === undefined) return [`${locale}: the catalog is missing; run npm run i18n:extract`]
  const problems: string[] = []
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.obsolete || !(id in source)) problems.push(`${locale}: "${entry.message ?? id}" is no longer in the code; run npm run i18n:extract`)
  }
  for (const [id, english] of Object.entries(source)) {
    const entry = entries[id]
    if (entry === undefined) { problems.push(`${locale}: "${english.message}" is missing; run npm run i18n:extract`); continue }
    if (!entry.translation) continue
    // English's own catalog repeats each message or leaves it empty; anything else would be shown in place of the code's.
    if (locale === SOURCE_INTERFACE_LANGUAGE && entry.translation !== english.message) {
      problems.push(`${locale}: "${english.message}" is written as "${entry.translation}"; English's catalog repeats the message`)
      continue
    }
    try {
      const expected = placeholdersOf(english.message ?? '')
      const written = placeholdersOf(entry.translation)
      if (written.join(',') !== expected.join(',')) problems.push(`${locale}: "${english.message}" names {${written.join(', ')}}, English names {${expected.join(', ')}}`)
    } catch {
      problems.push(`${locale}: "${english.message}" does not parse as an ICU message: ${entry.translation}`)
    }
  }
  return problems
}

beforeAll(async () => {
  catalogs = await getCatalogs(config)
})

describe('interface catalogs', () => {
  it('has one catalog per area, for English and every one of the twenty-nine languages', () => {
    expect(catalogs.map(areaOf).sort()).toEqual(['features', 'main', 'settings', 'shared', 'threads', 'tools', 'widget'])
    expect([...config.locales].sort()).toEqual([...INTERFACE_LANGUAGE_CODES, 'ar-XB', 'en-XA'].sort())
  })

  it('carries exactly the messages the code writes, English included', { timeout: 120_000 }, async () => {
    const problems: string[] = []
    for (const catalog of catalogs) {
      const extracted = await catalog.collect()
      const source = await catalog.read(SOURCE_INTERFACE_LANGUAGE)
      expect(extracted, areaOf(catalog)).toBeDefined()
      const written = Object.fromEntries(Object.entries(source ?? {}).filter(([, entry]) => !entry.obsolete))
      for (const [id, message] of Object.entries(extracted ?? {})) {
        if (!(id in written)) problems.push(`${areaOf(catalog)}: "${message.message ?? id}" is in the code but not the catalog; run npm run i18n:extract`)
      }
      for (const [id, entry] of Object.entries(source ?? {})) {
        if (entry.obsolete || !(id in (extracted ?? {}))) problems.push(`${areaOf(catalog)}: "${entry.message ?? id}" is no longer in the code; run npm run i18n:extract`)
      }
    }
    expect(problems).toEqual([])
  })

  it('parses every message in every catalog, English and the pseudo-languages included, with the placeholders English has and nothing missing or left over', async () => {
    const problems: string[] = []
    for (const catalog of catalogs) {
      const source = await catalog.read(SOURCE_INTERFACE_LANGUAGE) ?? {}
      for (const [id, entry] of Object.entries(source)) {
        try { parse(entry.message ?? id) } catch { problems.push(`${areaOf(catalog)}: English "${entry.message}" does not parse as an ICU message`) }
      }
      for (const locale of config.locales) problems.push(...problemsOf(locale, source, await catalog.read(locale)).map(problem => `${areaOf(catalog)}: ${problem}`))
    }
    expect(problems).toEqual([])
  })

  it('finds a placeholder a translation drops or renames, and a message that does not parse', () => {
    const source = { a: { message: 'Reset contrast to {amount}', translation: 'Reset contrast to {amount}' }, b: { message: '{count, plural, one {Theme removed.} other {# themes removed.}}', translation: '' } }
    expect(problemsOf('xx', source, {
      a: { message: 'Reset contrast to {amount}', translation: 'Kontrast auf {betrag} zurücksetzen' },
      b: { message: source.b.message, translation: '{count, plural, one {Design entfernt.} other {# Designs entfernt.}' },
      c: { message: 'Gone', translation: 'Weg', obsolete: true },
    })).toEqual([
      'xx: "Gone" is no longer in the code; run npm run i18n:extract',
      'xx: "Reset contrast to {amount}" names {betrag}, English names {amount}',
      `xx: "${source.b.message}" does not parse as an ICU message: {count, plural, one {Design entfernt.} other {# Designs entfernt.}`,
    ])
    expect(problemsOf('xx', source, { a: { message: source.a.message, translation: '' } })).toEqual([`xx: "${source.b.message}" is missing; run npm run i18n:extract`])
    // English's catalog may only repeat a message: one that drops a placeholder would compile and show.
    expect(problemsOf('en', source, {
      a: { message: source.a.message, translation: 'Reset contrast' },
      b: { message: source.b.message, translation: '' },
    })).toEqual([`en: "Reset contrast to {amount}" is written as "Reset contrast"; English's catalog repeats the message`])
  })
})
