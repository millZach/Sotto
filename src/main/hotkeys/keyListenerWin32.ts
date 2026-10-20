// Mirror of the key table in native/key-listener/win32.cs; a unit test keeps them equal.
// win32.cs maps numpad Enter (0x0D extended) and the non-extended navigation VKs (NumLock off) to Other.
export const WIN32_KEY_TOKENS: Readonly<Record<number, string>> = Object.freeze(buildWin32KeyTokens())

function buildWin32KeyTokens(): Record<number, string> {
  const tokens: Record<number, string> = {
    0x20: 'Space',
    0x0d: 'Enter',
    0x09: 'Tab',
    0x08: 'Backspace',
    0x2e: 'Delete',
    0x26: 'Up',
    0x28: 'Down',
    0x25: 'Left',
    0x27: 'Right',
    0x24: 'Home',
    0x23: 'End',
    0x21: 'PageUp',
    0x22: 'PageDown',
    0x1b: 'Escape',
    0xa2: 'CommandOrControl',
    0xa3: 'CommandOrControl',
    0xa4: 'Alt',
    0xa5: 'Alt',
    0xa0: 'Shift',
    0xa1: 'Shift',
    0x5b: 'Super',
    0x5c: 'Super',
  }
  for (let index = 0; index < 26; index += 1) tokens[0x41 + index] = String.fromCharCode(0x41 + index)
  for (let index = 0; index < 10; index += 1) tokens[0x30 + index] = String(index)
  for (let index = 1; index <= 24; index += 1) tokens[0x6f + index] = `F${index}`
  return tokens
}

// PowerShell also closes a single-quoted string on the typographic single quotes.
const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g

export function keyListenerWin32Invocation(
  csPath: string,
  acceptSynthetic: boolean,
): { executable: string; args: readonly string[] } {
  if (/[\r\n]/.test(csPath)) {
    throw new Error('The key listener source path cannot contain a line break.')
  }
  const quotedPath = `'${csPath.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`
  // -LiteralPath, not -Path: Add-Type -Path treats [ and ] in a folder name as wildcards.
  const script = `Add-Type -LiteralPath ${quotedPath}; [SottoKeyListener]::Run(${acceptSynthetic ? '$true' : '$false'})`
  const args = Object.freeze([
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ])
  // Bare name, as pasteCommand.win32.ts runs it.
  return Object.freeze({ executable: 'powershell.exe', args })
}
