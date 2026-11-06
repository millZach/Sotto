import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '@lingui/react'
import { i18n } from '@lingui/core'
import { afterEach, describe, expect, it } from 'vitest'
import { DiffBlock, codeBreaks } from '../../../../src/renderer/src/tools/DiffBlock'

afterEach(cleanup)

const draw = (diff: string, path?: string): HTMLElement => {
  i18n.loadAndActivate({ locale: 'en', messages: {} })
  return render(<I18nProvider i18n={i18n}><DiffBlock diff={diff} path={path} /></I18nProvider>).container
}

describe('codeBreaks', () => {
  it("keeps a short run whole where a browser would break it at a hyphen or a slash", () => {
    const text = "  | (Extract<ThreadStoreWrite, { kind: 'history-off' }>"
    const plan = codeBreaks(text)!
    expect(plan.kept.map(range => text.slice(range.start, range.end))).toEqual(["'history-off'"])
  })

  it('gives a long run a break after its dots, commas and brackets', () => {
    const text = 'window.sotto!.updateSettings({darkTheme:id})'
    expect(codeBreaks(text)!.after.map(at => text.slice(0, at))).toEqual(['window.', 'window.sotto!.', 'window.sotto!.updateSettings(', 'window.sotto!.updateSettings({'])
  })

  it('leaves a line its browser breaks already serve', () => {
    expect(codeBreaks('const ready = true')).toBeNull()
  })
})

describe('DiffBlock', () => {
  it("reads a document's edited line once: what both keep, then what went struck out and what came", () => {
    const container = draw('@@ -4 +4 @@\n-Status: an idea. Nothing is scheduled.\n+Status: an idea. Five pull requests are scheduled.\n', 'docs/plan.md')
    const rows = container.querySelectorAll('.changes-line')
    expect(rows).toHaveLength(2)
    const edited = container.querySelector('.changes-line[data-kind="edited"]')!
    expect(edited.querySelector('del')!.textContent).toBe('Removed: Nothing is')
    expect(edited.querySelector('ins')!.textContent).toBe('Added: Five pull requests are')
    expect(edited.querySelector('.changes-line__number')!.textContent).toBe('4')
  })

  it('reads a reworked paragraph as two: the old one whole with what went struck, then the new one whole with what came', () => {
    const before = 'The worker thread runs them on a connection of its own, half a second after the last one finished, so no save on main runs one, and a save can still wait for one.'
    const after = 'The store worker runs them between its writes, half a second after the last one finished, so nothing on main runs one, and only the writer waits for it.'
    const container = draw(`@@ -1 +1 @@\n-${before}\n+${after}\n`, 'CONTEXT.md')
    const row = container.querySelector('.changes-line[data-kind="edited"]')!
    expect(row.getAttribute('data-reworked')).toBe('true')
    expect(row.getAttribute('data-rewritten')).toBeNull()
    const text = row.querySelector('.changes-line__text')!
    // Two paragraphs and nothing else: no words read in pairs on the line, and nothing to open.
    expect([...text.children].map(child => child.className)).toEqual(['changes-reworked__was', 'changes-reworked__now'])
    expect(row.querySelector('button')).toBeNull()
    const was = text.querySelector('.changes-reworked__was')!, now = text.querySelector('.changes-reworked__now')!
    // As it was, whole, with only what went marked; as it is now, whole, with only what came marked.
    expect(was.textContent!.replace(/Removed: /gu, '')).toBe(before)
    expect(was.querySelector('ins')).toBeNull()
    expect([...was.querySelectorAll('del')].map(mark => mark.textContent).slice(0, 2)).toEqual(['Removed: worker thread runs them on a connection of its own', 'Removed: no save'])
    expect(now.textContent!.replace(/Added: /gu, '')).toBe(after)
    expect(now.querySelector('del')).toBeNull()
    expect([...now.querySelectorAll('ins')].map(mark => mark.textContent).slice(0, 2)).toEqual(['Added: store worker runs them between its writes', 'Added: nothing'])
  })

  it('marks the line where words went with nothing in their place, in a reworked paragraph as it is now', () => {
    const before = 'Every write goes this way, and the store confirms each write on main as it makes it, then posts it, then waits, then posts the next one.'
    const after = 'Every write goes this way, and the store worker confirms each write as it makes it, then posts it.'
    const row = draw(`@@ -1 +1 @@\n-${before}\n+${after}\n`, 'CONTEXT.md').querySelector('.changes-line[data-reworked]')!
    const now = row.querySelector('.changes-reworked__now')!
    expect(now.textContent!.replace(/Added: /gu, '')).toBe(after)
    expect(now.querySelector(':scope > .changes-w:empty')).not.toBeNull()
  })

  it('reads a long paragraph rewritten whole as two paragraphs, as it was and as it is now', () => {
    const before = 'The worker thread that will make every write to the event store and run its log checkpoints, confirming each posted write back to main. It is planned, not built: until it is, the store confirms on main.'
    const after = 'Store worker thread making each write the event store holds, and its checkpoints too. Its commit shows before its confirmation arrives, so the overlay leaves out what main already holds, and closing waits a minute at most.'
    const row = draw(`@@ -1 +1 @@\n-${before}\n+${after}\n`, 'CONTEXT.md').querySelector('.changes-line[data-kind="edited"]')!
    expect(row.getAttribute('data-rewritten')).toBe('true')
    expect(row.querySelector('.changes-reworked__was')!.textContent).toBe(`Removed: ${before}`)
    expect(row.querySelector('.changes-reworked__now')!.textContent).toBe(`Added: ${after}`)
    expect(row.querySelector('button')).toBeNull()
  })

  it('leaves code as the line that went above the line that came', () => {
    const container = draw("@@ -1 +1 @@\n-const kind = 'history-on'\n+const kind = 'history-off'\n", 'src/a.ts')
    expect([...container.querySelectorAll('.changes-line')].map(row => row.getAttribute('data-kind'))).toEqual(['hunk', 'remove', 'add'])
  })
})
