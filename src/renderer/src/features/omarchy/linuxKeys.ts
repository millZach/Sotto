import { formatAccelerator } from '../../../../shared/accelerator'

/** Linux's dictation keys in Omarchy's words, for copy: the first hold shortcut and the main press shortcut. */
export function linuxKeyWords(settings: { readonly hotkey: string; readonly holdShortcuts: readonly string[] }): { readonly press: string; readonly hold: string | undefined } {
  const hold = settings.holdShortcuts[0]
  return { press: formatAccelerator(settings.hotkey, 'linux', 'editing'), hold: hold === undefined ? undefined : formatAccelerator(hold, 'linux', 'editing') }
}
