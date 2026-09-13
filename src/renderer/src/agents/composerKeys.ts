import type { KeyboardEvent } from 'react'

/** What an Enter keydown in a thread composer means. */
export type ComposerEnterIntent = 'send' | 'newline' | 'none'

export interface ComposerKeyEvent {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly defaultPrevented: boolean
  /** IME composition in progress; Chromium also reports keyCode 229 for the confirming keystroke. */
  readonly isComposing: boolean
  readonly keyCode: number
  /** The textarea's aria-expanded: an open command or skill menu owns Enter. */
  readonly menuOpen: boolean
}

/**
 * Enter sends and Shift+Enter inserts a newline. Ctrl/Cmd+Enter also sends.
 * Composition, an already handled key and an open command menu never send.
 */
export function composerEnterIntent(event: ComposerKeyEvent): ComposerEnterIntent {
  if (event.key !== 'Enter') return 'none'
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || event.menuOpen) return 'none'
  if (event.shiftKey || event.altKey) return 'newline'
  return 'send'
}

export function readComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): ComposerKeyEvent {
  return {
    key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, defaultPrevented: event.defaultPrevented,
    isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode,
    menuOpen: event.currentTarget.getAttribute('aria-expanded') === 'true',
  }
}
