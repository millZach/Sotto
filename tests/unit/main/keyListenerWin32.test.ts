// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { keyListenerWin32Invocation, WIN32_KEY_TOKENS } from '../../../src/main/hotkeys/keyListenerWin32'

const CS_SOURCE = readFileSync(join(__dirname, '../../../native/key-listener/win32.cs'), 'utf8')

function decodedCommand(args: readonly string[]): string {
  return Buffer.from(args[args.length - 1] ?? '', 'base64').toString('utf16le')
}

describe('keyListenerWin32Invocation', () => {
  it('runs Windows PowerShell with an encoded command and no execution policy override', () => {
    const invocation = keyListenerWin32Invocation('C:\\Sotto\\resources\\native\\win32.cs', false)

    expect(invocation.executable).toBe('powershell.exe')
    expect(invocation.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(invocation.args).toHaveLength(5)
    expect(invocation.args.join(' ')).not.toMatch(/ExecutionPolicy/i)
    expect(Object.isFrozen(invocation)).toBe(true)
    expect(Object.isFrozen(invocation.args)).toBe(true)
  })

  it('encodes the Add-Type call and passes acceptSynthetic through', () => {
    const path = 'C:\\Sotto\\resources\\native\\win32.cs'

    expect(decodedCommand(keyListenerWin32Invocation(path, false).args)).toBe(
      "Add-Type -LiteralPath 'C:\\Sotto\\resources\\native\\win32.cs'; [SottoKeyListener]::Run($false)",
    )
    expect(decodedCommand(keyListenerWin32Invocation(path, true).args)).toBe(
      "Add-Type -LiteralPath 'C:\\Sotto\\resources\\native\\win32.cs'; [SottoKeyListener]::Run($true)",
    )
  })

  it('doubles every quote PowerShell would read as closing the path', () => {
    const decoded = decodedCommand(keyListenerWin32Invocation("C:\\O'Brien\\it\u2019s [1]\\win32.cs", false).args)

    expect(decoded).toBe("Add-Type -LiteralPath 'C:\\O''Brien\\it\u2019\u2019s [1]\\win32.cs'; [SottoKeyListener]::Run($false)")
  })

  it('refuses a path with a line break', () => {
    expect(() => keyListenerWin32Invocation('C:\\a\nb\\win32.cs', false)).toThrow(/line break/)
    expect(() => keyListenerWin32Invocation('C:\\a\rb\\win32.cs', false)).toThrow(/line break/)
  })

  it('stays well under the Windows command line limit for a long install path', () => {
    const longPath = `C:\\Users\\${'x'.repeat(200)}\\AppData\\Local\\Programs\\Sotto\\resources\\native\\win32.cs`
    const encoded = keyListenerWin32Invocation(longPath, true).args[4] ?? ''

    expect(encoded.length).toBeLessThan(8000)
  })
})

describe('win32.cs', () => {
  it('has exactly the key table WIN32_KEY_TOKENS mirrors', () => {
    const table: Record<number, string> = {}
    for (const match of CS_SOURCE.matchAll(/t\[(0x[0-9A-Fa-f]+)\] = "([^"]+)";/g)) {
      const vk = Number(match[1])
      expect(table[vk], `duplicate entry ${match[1]}`).toBeUndefined()
      table[vk] = match[2] ?? ''
    }

    expect(table).toEqual({ ...WIN32_KEY_TOKENS })
    expect(Object.keys(table)).toHaveLength(82)
    expect(WIN32_KEY_TOKENS[0x0d]).toBe('Enter')
    expect(WIN32_KEY_TOKENS[0x87]).toBe('F24')
    expect(WIN32_KEY_TOKENS[0x5c]).toBe('Super')
  })

  it('handles system key messages and drops injected input unless asked', () => {
    expect(CS_SOURCE).toContain('WM_SYSKEYDOWN = 0x0104')
    expect(CS_SOURCE).toContain('WM_SYSKEYUP = 0x0105')
    expect(CS_SOURCE).toContain('LLKHF_INJECTED = 0x10')
    expect(CS_SOURCE).toContain('(acceptInjected || (flags & LLKHF_INJECTED) == 0)')
    expect(CS_SOURCE).toContain('public static void Run(bool acceptSynthetic)')
  })

  it('reconciles reported keys with GetAsyncKeyState and tells the numpad apart by LLKHF_EXTENDED', () => {
    expect(CS_SOURCE).toContain('private static extern short GetAsyncKeyState(int vKey);')
    expect(CS_SOURCE).toContain('(GetAsyncKeyState(key & 0xFF) & 0x8000) == 0')
    expect(CS_SOURCE).toMatch(/if \(!QueueCount\.Wait\(500\)\)\s*\{\s*Reconcile\(\);\s*continue;/)
    // Only the idle poll reconciles; a per-item call could emit an up ahead of a queued down.
    expect(CS_SOURCE.match(/Reconcile\(\);/g)).toHaveLength(1)
    expect(CS_SOURCE).toContain('LLKHF_EXTENDED = 0x01')
    expect(CS_SOURCE).toContain('item.Extended = (flags & LLKHF_EXTENDED) != 0;')
    expect(CS_SOURCE).toContain('(vk == 0x0D && extended) || (!extended && ((vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E))')
  })

  it('writes to stdout only through the protocol writer', () => {
    expect(CS_SOURCE).not.toMatch(/Console\.(Write|Out|Error)|OpenStandardError|Debug\.|Trace\./)
    expect(CS_SOURCE.match(/\.Write(Line)?\(/g)).toEqual(['.Write('])
    expect(CS_SOURCE).toContain('output.Write(line + "\\n");')
  })

  it('uses no C# 6 or later syntax that Windows PowerShell 5.1 cannot compile', () => {
    expect(CS_SOURCE).not.toMatch(/\$"|\?\.|nameof\(|out var |=>/)
  })
})
