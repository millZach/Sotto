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

  it('leaves code as the line that went above the line that came', () => {
    const container = draw("@@ -1 +1 @@\n-const kind = 'history-on'\n+const kind = 'history-off'\n", 'src/a.ts')
    expect([...container.querySelectorAll('.changes-line')].map(row => row.getAttribute('data-kind'))).toEqual(['hunk', 'remove', 'add'])
  })
})
