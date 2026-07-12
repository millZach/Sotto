const PASTE_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"

export interface PasteInvocation {
  readonly executable: string
  readonly args: readonly string[]
}

export function buildPasteInvocation(): Readonly<PasteInvocation> {
  const encodedScript = Buffer.from(PASTE_SCRIPT, 'utf16le').toString('base64')
  const args = Object.freeze([
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-EncodedCommand',
    encodedScript,
  ])

  return Object.freeze({ executable: 'powershell.exe', args })
}
