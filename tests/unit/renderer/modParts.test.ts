// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MOD_PARTS } from '../../../src/shared/modParts'
import { modLooksText, modPaints } from '../../../src/renderer/src/state/mods'

async function sources(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? sources(join(folder, entry.name))
    : /\.tsx?$/.test(entry.name) ? Promise.resolve([join(folder, entry.name)]) : Promise.resolve([])))
  return nested.flat()
}

describe('part names (ADR-0217)', () => {
  it('puts every part name in MOD_PARTS on an element in the renderer, and no other', async () => {
    const files = await sources(join(process.cwd(), 'src/renderer/src'))
    const text = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n')
    const placed = new Set([...text.matchAll(/data-part=\{modPart\('([a-z-]+)'\)\}/g)].map(match => match[1]))
    expect([...placed].sort()).toEqual(MOD_PARTS.map(part => part.name).sort())
  })
})

describe('modLooksText', () => {
  const mods = [
    { id: 'a', name: 'A', look: 'a { color: red; }' },
    { id: 'b', name: 'B', look: 'b { color: blue; }' },
    { id: 'c', name: 'C', look: 'c { background: url(https://example.com); }', problem: 'outside' as const },
    { id: 'd', name: 'D', look: '  ' },
  ]
  it('paints the looks of mods that are on and passed the check, each under its id', () => {
    expect(modLooksText(mods, [])).toBe('/* a */\na { color: red; }\n\n/* b */\nb { color: blue; }')
    expect(modLooksText(mods, ['a'])).toBe('/* b */\nb { color: blue; }')
    expect(mods.map(mod => modPaints(mod, []))).toEqual([true, true, false, false])
  })
})
