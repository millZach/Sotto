import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
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

  it('reads a reworked paragraph once, each change in its place, with its whole earlier wording one press away', () => {
    const before = 'The worker thread runs them on a connection of its own, half a second after the last one finished, so no save on main runs one, and a save can still wait for one.'
    const after = 'The store worker runs them between its writes, half a second after the last one finished, so nothing on main runs one, and only the writer waits for it.'
    const container = draw(`@@ -1 +1 @@\n-${before}\n+${after}\n`, 'CONTEXT.md')
    const row = container.querySelector('.changes-line[data-kind="edited"]')!
    expect(row.getAttribute('data-reworked')).toBe('true')
    expect(row.getAttribute('data-rewritten')).toBeNull()
    // In the paragraph, at each change, the words that went struck before the words that came, each pair once.
    const text = row.querySelector('.changes-line__text')!
    const marks = [...text.querySelectorAll(':scope > del, :scope > ins')].map(mark => mark.textContent)
    expect(marks.slice(0, 4)).toEqual(['Removed: worker thread runs them on a connection of its own', 'Added: store worker runs them between its writes', 'Removed: no save', 'Added: nothing'])
    // Shut, the line under it only says what a press does; nothing of the paragraph shows twice.
    const toggle = row.querySelector<HTMLButtonElement>('.changes-earlier__toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toBe('Show earlier wording')
    expect(row.querySelector('.changes-earlier__text')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Hide earlier wording')
    const earlier = row.querySelector('.changes-earlier__text')!
    expect(earlier.textContent!.replace(/Removed: /gu, '')).toBe(before)
    expect(earlier.querySelector('del')!.textContent).toBe('Removed: worker thread runs them on a connection of its own')
  })

  it('reads a long paragraph rewritten whole as it is now, with no word marks, and its earlier wording a press away', () => {
    const before = 'The worker thread that will make every write to the event store and run its log checkpoints, confirming each posted write back to main. It is planned, not built: until it is, the store confirms on main.'
    const after = 'Store worker thread making each write the event store holds, and its checkpoints too. Its commit shows before its confirmation arrives, so the overlay leaves out what main already holds, and closing waits a minute at most.'
    const row = draw(`@@ -1 +1 @@\n-${before}\n+${after}\n`, 'CONTEXT.md').querySelector('.changes-line[data-kind="edited"]')!
    expect(row.getAttribute('data-rewritten')).toBe('true')
    expect(row.querySelector('.changes-line__text > del')).toBeNull()
    expect(row.querySelector('.changes-line__text > ins')!.textContent).toBe(`Added: ${after}`)
    expect(row.querySelector('.changes-earlier__toggle')!.textContent).toBe('Show earlier wording')
  })

  it('leaves code as the line that went above the line that came', () => {
    const container = draw("@@ -1 +1 @@\n-const kind = 'history-on'\n+const kind = 'history-off'\n", 'src/a.ts')
    expect([...container.querySelectorAll('.changes-line')].map(row => row.getAttribute('data-kind'))).toEqual(['hunk', 'remove', 'add'])
  })
})
