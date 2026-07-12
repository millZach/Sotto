import { describe, expect, it } from 'vitest'

import { buildPasteInvocation } from '../../../src/main/output/pasteCommand'

describe('buildPasteInvocation', () => {
  it('builds a frozen PowerShell invocation containing only a static Ctrl+V script', () => {
    const invocation = buildPasteInvocation()

    expect(invocation.executable).toBe('powershell.exe')
    expect(invocation.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
    ])
    expect(invocation.args).toHaveLength(6)
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(Object.isFrozen(invocation.args)).toBe(true)

    const script = Buffer.from(invocation.args[5] ?? '', 'base64').toString('utf16le')
    expect(script).toBe(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
    )
  })
})
