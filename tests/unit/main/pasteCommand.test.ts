import { describe, expect, it } from 'vitest'

import { createPasteCommands } from '../../../src/main/output/pasteCommand'

describe('createPasteCommands win32 one-shot invocation', () => {
  it('builds a frozen PowerShell invocation that reports whether Windows accepted every Ctrl+V input', () => {
    const invocation = createPasteCommands('win32').oneShot()

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
    expect(script).toContain('[DllImport("user32.dll", SetLastError = true)]')
    expect(script).toContain('SendInput')
    expect(script).toContain('CreateKeyboardInput(VK_CONTROL, 0)')
    expect(script).toContain('CreateKeyboardInput(VK_V, 0)')
    expect(script).toContain('CreateKeyboardInput(VK_V, KEYEVENTF_KEYUP)')
    expect(script).toContain('CreateKeyboardInput(VK_CONTROL, KEYEVENTF_KEYUP)')
    expect(script).toContain('return accepted == (uint)inputs.Length;')
    expect(script).toContain('if (-not [SottoPaste]::SendCtrlV()) { exit 1 }')
    expect(script).not.toContain('System.Windows.Forms')
    expect(script).not.toContain('SendKeys')
  })

  it('exposes a warm helper builder on win32 and none on darwin', () => {
    expect(createPasteCommands('win32').helper).not.toBeNull()
    expect(createPasteCommands('darwin').helper).toBeNull()
  })

  it('returns the same frozen command table for repeated lookups', () => {
    expect(createPasteCommands('win32')).toBe(createPasteCommands('win32'))
    expect(Object.isFrozen(createPasteCommands('win32'))).toBe(true)
    expect(Object.isFrozen(createPasteCommands('darwin'))).toBe(true)
  })
})
