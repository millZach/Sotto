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

  it('never uses a hardware key code, which would depend on the keyboard layout', () => {
    const invocation = createPasteCommands('darwin').oneShot()

    expect(invocation.args.join(' ')).not.toContain('key code')
    expect(invocation.args.join(' ')).toContain('keystroke "v"')
  })

  it('has no transcript interpolation seam: repeated builds are byte-identical', () => {
    const first = createPasteCommands('darwin').oneShot()
    const second = createPasteCommands('darwin').oneShot()

    expect(second.executable).toBe(first.executable)
    expect(second.args).toEqual(first.args)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('offers no warm helper, because macOS has no compile step to pay up front', () => {
    expect(createPasteCommands('darwin').helper).toBeNull()
  })
})
