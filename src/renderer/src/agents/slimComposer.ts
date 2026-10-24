import { useLayoutEffect, useRef, type RefObject } from 'react'
import { prefersReducedMotion } from '../state/reducedMotion'

/**
 * The slim composer (ADR-0125, an Owl feature): while the user reads back through a thread, the floating composer steps
 * down to one line with its primary disc, so more of the thread shows (the user's pick on October 23, 2026, variant B of
 * `docs/prototypes/composer-shrink-prototype.html`). Everything here is the rule and its motion; the pane owns the state.
 */

/** How far above its end the transcript must be read before the composer slims. */
export const READING_BACK_PX = 160
/** How long the card takes to change height, slim or full. */
export const SLIM_MS = 200
/** The card's own move between slim and full, by which a measure of the card knows to wait for it and for nothing else. */
export const SLIM_MOTION_ID = 'slim-composer'

/** Whether the card is moving between slim and full, when its box is neither. Its other motions, as the effort border's, do not count. */
export function slimMoving(card: Element): boolean {
  return typeof card.getAnimations === 'function' && card.getAnimations().some(motion => motion.id === SLIM_MOTION_ID && motion.playState === 'running')
}

export interface SlimFacts {
  /** The Owl feature is on (and, in Watcher's pane, Watcher too). */
  readonly enabled: boolean
  /** The transcript is read more than READING_BACK_PX above its end. */
  readonly readingBack: boolean
  /** Focus is anywhere in the composer, from a click, Tab or a key typed into the transcript. */
  readonly focused: boolean
  /** The composer holds text or attachments: a draft keeps it full. */
  readonly draft: boolean
  /** A question waits above the message bar, so the composer stacks instead of floating and never slims. */
  readonly questionWaits: boolean
}

/** Whether the composer shows as the slim line. Only a floating composer with nothing in it, read away from, slims. */
export function composerSlim(facts: SlimFacts): boolean {
  return facts.enabled && facts.readingBack && !facts.focused && !facts.draft && !facts.questionWaits
}

/** Whether a scroller is read far enough above its end for the composer to slim. */
export function readsBack(scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > READING_BACK_PX
}

/** What a key pressed there acts on itself, so it never goes to the composer. */
const OWN_KEYS = [
  'input', 'textarea', 'select', 'button', 'a[href]', 'summary', '[contenteditable]:not([contenteditable="false"])',
  ...['button', 'textbox', 'menuitem', 'option', 'tab', 'slider', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'menu', 'dialog', 'link']
    .map(role => `[role="${role}"]`),
].join(', ')

/**
 * Whether a key pressed in the transcript is the start of typing, which the composer takes: one printable character
 * with no Ctrl, Alt or Cmd, pressed on the transcript itself or on words in it, never on a control, a field or a card
 * that answers keys. Space keeps scrolling the transcript.
 */
export function typesIntoComposer(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented'> & { readonly target: EventTarget | null }): boolean {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false
  if ([...event.key].length !== 1 || event.key.trim() === '') return false
  const target = event.target
  return typeof Element !== 'undefined' && target instanceof Element && target.closest(OWN_KEYS) === null
}

/**
 * The card's change of height, slim or full: it moves from where it stood to where it now stands, over SLIM_MS, or at
 * once with motion reduced. The card's box is read once, in the render that changes `slim`, before the page changes.
 */
export function useSlimMotion(compose: RefObject<HTMLElement | null>, slim: boolean, onSettled: () => void = () => undefined): void {
  const shown = useRef(slim)
  const before = useRef<DOMRect | null>(null)
  if (shown.current !== slim) {
    shown.current = slim
    before.current = compose.current?.querySelector('.thread-prompt')?.getBoundingClientRect() ?? null
  }
  useLayoutEffect(() => {
    const from = before.current
    before.current = null
    const card = compose.current?.querySelector<HTMLElement>('.thread-prompt')
    if (from === null || card == null || typeof card.animate !== 'function' || prefersReducedMotion()) return
    const to = card.getBoundingClientRect()
    if (Math.abs(from.height - to.height) < 1 && Math.abs(from.top - to.top) < 1) return
    // What the card holds is cut at its moving foot; the creature standing above it and the effort ring stay whole.
    const clip = 'inset(-200px -4px 0 -4px)'
    const motion = card.animate([
      { height: `${from.height}px`, transform: `translateY(${from.top - to.top}px)`, clipPath: clip },
      { height: `${to.height}px`, transform: 'none', clipPath: clip },
    ], { id: SLIM_MOTION_ID, duration: SLIM_MS, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    motion.addEventListener('finish', onSettled)
    return () => { motion.removeEventListener('finish', onSettled); motion.cancel() }
  }, [compose, slim, onSettled])
}
