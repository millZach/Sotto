import type { PasteInvocation } from './pasteCommand'

// 'keystroke "v"' resolves through the active keyboard layout; the raw
// 'key code 9' form pastes the wrong key on non-QWERTY layouts. The transcript
// travels on the clipboard and is never interpolated into this script.
const PASTE_INVOCATION: Readonly<PasteInvocation> = Object.freeze({
  // Absolute path so a PATH entry cannot substitute a different osascript.
  executable: '/usr/bin/osascript',
  args: Object.freeze([
    '-e',
    'tell application "System Events" to keystroke "v" using command down',
  ]),
})

export function buildDarwinPasteInvocation(): Readonly<PasteInvocation> {
  return PASTE_INVOCATION
}
