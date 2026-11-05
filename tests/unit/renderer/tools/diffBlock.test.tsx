import { describe, expect, it } from 'vitest'
import { codeBreaks } from '../../../../src/renderer/src/tools/DiffBlock'

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
