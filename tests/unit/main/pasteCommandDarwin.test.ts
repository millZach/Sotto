// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { createPasteCommands } from '../../../src/main/output/pasteCommand'

const DARWIN_SCRIPT = 'tell application "System Events" to keystroke "v" using command down'

describe('createPasteCommands darwin one-shot invocation', () => {
  it('runs osascript by absolute path with a single layout-robust keystroke script', () => {
    const invocation = createPasteCommands('darwin').oneShot()

    expect(invocation.executable).toBe('/usr/bin/osascript')
    expect(invocation.args).toEqual(['-e', DARWIN_SCRIPT])
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(Object.isFrozen(invocation.args)).toBe(true)
  })

  it('has no transcript interpolation seam: repeated builds are byte-identical', () => {
    const first = createPasteCommands('darwin').oneShot()
    const second = createPasteCommands('darwin').oneShot()

    expect(second.executable).toBe(first.executable)
    expect(second.args).toEqual(first.args)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })
})
