import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Quote } from 'lucide-react'
import { useOptionalApp } from '../state/AppContext'
import { chordClaimed, chordMatches } from './branchToolbar.logic'
import { chordBelongsElsewhere } from '../tools/changesShortcut'
import { MAX_REPLY_QUOTES, quoteFromSelection, replyQuoteStore, useReplyQuotes, type ReplyQuoteStore } from './replyQuotes'
import './replyQuotes.css'

/** The chord that adds a selection to the prompt, unless the dictation hotkey already means it. */
export const REPLY_QUOTE_SHORTCUT = 'mod+shift+a'

/** The gap between the selection and the button, and the button and the transcript's edges. */
const GAP_PX = 8

/**
 * Add to prompt, over words the user selected in one of the agent's replies (ADR-0127). It stands above the selection,
 * or under it where the top of the transcript would cut it off, and follows it as the transcript scrolls. A press puts
 * the words on this thread's composer as a quote and hands focus to the composer; Escape puts the button away.
 */
export const ReplyQuoteButton = memo(function ReplyQuoteButton({ threadId, scroller, onAdded, store = replyQuoteStore }: {
  readonly threadId: string
  readonly scroller: RefObject<HTMLElement | null>
  /** The words are on the composer: the pane puts focus in it. A new function each render draws nothing again; the newest is called. */
  readonly onAdded?: (() => void) | undefined
  /** The window's own unless a test passes one. */
  readonly store?: ReplyQuoteStore
}): ReactNode {
  const app = useOptionalApp()
  const platform = app?.platform ?? 'win32'
  const chord = chordClaimed(REPLY_QUOTE_SHORTCUT, app?.settings?.hotkey, platform) ? REPLY_QUOTE_SHORTCUT : null
  // Subscribed so the button hears when the prompt fills or empties.
  useReplyQuotes(store, threadId)
  const full = store.full(threadId)
  const [pending, setPending] = useState<{ readonly messageId: string; readonly text: string } | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  const pressing = useRef(false)

  const read = useCallback((): void => {
    if (pressing.current) return
    const next = quoteFromSelection(document.getSelection(), scroller.current)
    setPending(current => current?.messageId === next?.messageId && current?.text === next?.text ? current : next)
  }, [scroller])

  /** Puts the button over the selection, in the transcript's own coordinates, or hides it while the selection is out of view. */
  const place = useCallback((): void => {
    // The button stands in the transcript's frame, beside the scroller; read from the frame itself, since a hidden
    // button has no offset parent to ask.
    const element = pop.current, view = scroller.current, host = view?.parentElement
    const selection = document.getSelection()
    if (!element || !view || !host || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (typeof range.getBoundingClientRect !== 'function') return
    const rect = range.getBoundingClientRect(), frame = view.getBoundingClientRect(), origin = host.getBoundingClientRect()
    const outside = rect.bottom < frame.top || rect.top > frame.bottom
    element.hidden = outside
    if (outside) return
    const width = element.offsetWidth, height = element.offsetHeight
    const above = rect.top - height - GAP_PX
    const top = above < frame.top + GAP_PX ? Math.min(rect.bottom + GAP_PX, frame.bottom - height - GAP_PX) : above
    const left = Math.max(GAP_PX, Math.min(rect.left + rect.width / 2 - width / 2 - origin.left, origin.width - width - GAP_PX))
    element.style.top = `${top - origin.top}px`
    element.style.left = `${left}px`
  }, [scroller])

  const dismiss = useCallback((): void => {
    document.getSelection()?.removeAllRanges()
    setPending(null)
  }, [])

  const added = useRef(onAdded)
  added.current = onAdded
  const add = (quote: { readonly messageId: string; readonly text: string } | null): void => {
    if (quote === null || store.add(threadId, quote) === null) return
    dismiss()
    added.current?.()
  }

  // A different thread starts with nothing pending.
  useEffect(() => { setPending(null) }, [threadId])

  // The selection is read once it is made: on the release of a drag, and after a key that extends or ends it. A selection
  // that empties hides the button at once.
  useEffect(() => {
    const down = (event: PointerEvent): void => { if (!pop.current?.contains(event.target as Node | null)) pressing.current = true }
    const up = (): void => { pressing.current = false; requestAnimationFrame(read) }
    const cancel = (): void => { pressing.current = false }
    const changed = (): void => { if (document.getSelection()?.isCollapsed !== false) setPending(current => current === null ? current : null) }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', cancel, true)
    document.addEventListener('keyup', read)
    document.addEventListener('selectionchange', changed)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', cancel, true)
      document.removeEventListener('keyup', read)
      document.removeEventListener('selectionchange', changed)
    }
  }, [read])

  useLayoutEffect(() => { if (pending !== null) place() }, [pending, full, place])

  useEffect(() => {
    if (pending === null) return
    const view = scroller.current
    const follow = (): void => place()
    view?.addEventListener('scroll', follow, { passive: true })
    window.addEventListener('resize', follow)
    return () => { view?.removeEventListener('scroll', follow); window.removeEventListener('resize', follow) }
  }, [pending, scroller, place])

  // Escape puts the button away; the chord adds whatever this transcript's selection holds, the button shown or not.
  // Registered once, reading the latest render through a ref.
  const latest = useRef({ pending, chord, platform, full, add })
  latest.current = { pending, chord, platform, full, add }
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      const now = latest.current
      if (event.defaultPrevented || event.repeat) return
      if (event.key === 'Escape' && now.pending !== null) { event.preventDefault(); dismiss(); return }
      if (now.chord === null || !chordMatches(event, now.chord, now.platform) || chordBelongsElsewhere(event.target)) return
      const quote = quoteFromSelection(document.getSelection(), scroller.current)
      if (quote === null) return
      event.preventDefault()
      if (!now.full) now.add(quote)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [dismiss, scroller])

  if (pending === null) return null
  const keys = chord === null ? undefined : platform === 'darwin' ? 'Meta+Shift+A' : 'Control+Shift+A'
  const fullNote = `A message carries at most ${MAX_REPLY_QUOTES} quotes. Send it or remove one first.`
  return <div ref={pop} className="reply-quote-pop">
    {full ? <p className="reply-quote-pop__note">{fullNote}</p>
      : <button type="button" className="reply-quote-pop__add tt-focusable" aria-label="Add to prompt" title="Add to prompt" aria-keyshortcuts={keys}
        // Pressing must not end the selection before the press has read it.
        onMouseDown={event => event.preventDefault()} onClick={() => add(pending)}>
        <Quote size={14} aria-hidden="true" /><span>Add to prompt</span>
        {chord === null ? null : <kbd aria-hidden="true">{platform === 'darwin' ? '⌘⇧A' : 'Ctrl+Shift+A'}</kbd>}
      </button>}
  </div>
}, (before, after) => before.threadId === after.threadId && before.scroller === after.scroller && before.store === after.store)
