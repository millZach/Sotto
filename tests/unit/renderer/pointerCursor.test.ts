// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every stylesheet the windows load, comments left out. */
function stylesheets(folder: string): { readonly path: string; readonly css: string }[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return stylesheets(path)
    return entry.name.endsWith('.css') ? [{ path: relative(process.cwd(), path).replaceAll('\\', '/'), css: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '') }] : []
  })
}

// #1832: buttons, rows, tabs and toggles show the arrow, as a desktop app's controls do, and the hand is only for links.
describe('the pointer', () => {
  const sheets = stylesheets(join(process.cwd(), 'src/renderer/src'))

  it('is the hand in one rule only, for links, in global.css', () => {
    const hands = sheets.flatMap(({ path, css }) => [...css.matchAll(/([^{}]*)\{[^{}]*cursor:\s*pointer/gu)].map(match => `${path}: ${match[1]!.replace(/\s+/gu, ' ').trim()}`))
    expect(hands).toEqual(["src/renderer/src/styles/global.css: :where(a[href], [role='link'], [data-outside-link])"])
  })

  it('keeps the hand on the text links that open a page outside Sotto', () => {
    // Release notes from the update toast, and Tailscale's guide from host setup.
    for (const file of ['src/renderer/src/App.tsx', 'src/renderer/src/features/settings/HostPhonesDialog.tsx', 'src/renderer/src/features/settings/HostSetupChecklist.tsx']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8'), file).toContain('data-outside-link=""')
    }
  })

  it('is the arrow on every control, set once in global.css with no weight of its own', () => {
    const global = sheets.find(sheet => sheet.path.endsWith('styles/global.css'))!.css
    const rule = /:where\(button, summary, select, \[role='button'\], \[role='tab'\][^{]*\)\s*\{\s*cursor:\s*default;\s*\}/u.exec(global)
    expect(rule, 'the arrow rule in global.css').not.toBeNull()
    for (const control of ["[role='switch']", "[role='checkbox']", "[role='menuitem']", "[role='option']", "[role='slider']", "[type='checkbox']", "[type='range']"]) expect(rule![0]).toContain(control)
    // A label is left out: the cursor is inherited, and a label round a text field would hand the field the arrow.
    expect(rule![0]).not.toMatch(/\blabel\b/u)
  })
})
