// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractVsixThemes } from '../../../../src/main/themes/openVsx'
import { parseJsonc } from '../../../../src/shared/themes/jsonc'
import { VSCODE_WORKBENCH_COLOR_KEYS, parseVsCodeThemeFile } from '../../../../src/shared/themes/vscodeImport'
import { archive, extension, theme } from '../../../fixtures/openVsxArchive'

describe('atomic manifest and theme conversion', () => {
  it('preserves all importer-consumed keys with direct-import palette parity', () => {
    // Derive from the consumer calls, not the whitelist under test: this also catches future omissions.
    const source = readFileSync(new URL('../../../../src/shared/themes/vscodeImport.ts', import.meta.url), 'utf8')
    const consumed = new Set([...source.matchAll(/(?:pick|solidOver|readableOn)\(([^)]+)\)/gu)]
      .flatMap(match => [...match[1]!.matchAll(/'([^']+)'/gu)].map(key => key[1]!)))
    expect(consumed.size).toBeGreaterThan(35)
    expect([...consumed].filter(key => !(VSCODE_WORKBENCH_COLOR_KEYS as readonly string[]).includes(key))).toEqual([])
    for (const key of consumed) {
      const input = { ...theme, colors: { 'editor.background': '#111111', [key]: '#ffeeaa' } }
      const direct = parseVsCodeThemeFile(input)
      const installed = extractVsixThemes(archive({}, {}, JSON.stringify(input)), extension)[0]!
      expect(installed.colors, key).toEqual(direct.colors)
    }
  })
})

describe('JSONC lexical handling', () => {
  it('preserves commas, comment markers, escaped quotes and backslashes inside strings', () => {
    const name = 'Hello,} and ,] // text /* literal */ "quoted" \\ end'
    const source = `\uFEFF{"name":${JSON.stringify(name)},/* comment */"colors":{"editor.background":"#111111",},"items":[1, // comment\n],}`
    expect(parseJsonc(source)).toEqual({ name, colors: { 'editor.background': '#111111' }, items: [1] })
  })
  it.each(['{"a":1/* unterminated', '{"a":1/* c */2}', '{"a":1,/* unterminated }', '{"a":"unterminated}', '[,]', '[1,,]', '{"a":,}'])('rejects invalid JSONC instead of repairing it: %s', source => {
    expect(() => parseJsonc(source)).toThrow()
  })
})
