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
  /** An open skills menu with a highlighted choice owns Enter. */
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

/**
 * `menuOwnsEnter` is the composer's own knowledge that a highlighted menu choice takes Enter.
 * Without it, the textarea's aria-expanded stands in, as before the skills picker.
 */
export function readComposerKey(event: KeyboardEvent<HTMLTextAreaElement>, menuOwnsEnter?: boolean): ComposerKeyEvent {
  return {
    key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, defaultPrevented: event.defaultPrevented,
    isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode,
    menuOpen: menuOwnsEnter ?? event.currentTarget.getAttribute('aria-expanded') === 'true',
  }
}

export type SkillMenuKeyAction = 'next' | 'previous' | 'select' | 'close' | 'none'

/**
 * What a key means while the skills menu is showing. Arrow keys move, Tab takes the highlighted (or
 * first) choice, Enter takes only a highlighted choice, Escape closes. Composition owns every key.
 */
export function skillMenuKeyAction(event: Pick<ComposerKeyEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode' | 'defaultPrevented'> & { readonly ctrlKey?: boolean; readonly metaKey?: boolean }, options: { readonly optionCount: number; readonly highlighted: boolean }): SkillMenuKeyAction {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return 'none'
  if (event.key === 'Escape') return 'close'
  if (options.optionCount === 0) return 'none'
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'Tab' && !event.shiftKey) return 'select'
  if (event.key === 'Enter' && !event.shiftKey && options.highlighted) return 'select'
  return 'none'
}
