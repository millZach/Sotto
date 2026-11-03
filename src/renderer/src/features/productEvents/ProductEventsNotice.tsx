import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { Button } from '../../components/Button'
import { ProductEventsDialog } from './ProductEventsDialog'
import './productEvents.css'

/**
 * The one-time notice, a corner card (ADR-0179; Zach's pick A, tag prototype/product-events). Nothing is sent until a button
 * is pressed. It takes no focus when it appears, so a press meant for the composer cannot answer it. Escape puts it off wherever
 * focus is, unless an open dialog or something else claimed the press: that costs a question at the next start and sends nothing.
 */
export function ProductEventsNotice({ onAnswer, onPutOff }: {
  readonly onAnswer: (turnOff: boolean) => Promise<boolean>
  readonly onPutOff: () => void
}): ReactNode {
  const titleId = useId()
  const card = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  // The transient toasts share this corner; keep them clear of whatever height the card is.
  useLayoutEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--tt-corner-inset', `${Math.round(card.current?.getBoundingClientRect().height ?? 0) + 28}px`)
    return () => { root.style.removeProperty('--tt-corner-inset') }
  })
  useEffect(() => {
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      onPutOff()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onPutOff])
  const answer = async (turnOff: boolean): Promise<void> => {
    setBusy(true); setFailed(false)
    const saved = await onAnswer(turnOff).catch(() => false)
    // A saved answer takes the card down.
    if (!saved) { setBusy(false); setFailed(true) }
  }
  return <>
    <aside ref={card} className="product-events-notice" role="status" aria-labelledby={titleId}>
      <h2 id={titleId}><Trans>Sotto now sends product events</Trans></h2>
      <p className="tt-paragraph"><Trans>To learn what to build next, Sotto sends its developers which features you use, which provider and public model ran, how each turn ended, how long it took and its token counts.</Trans></p>
      <p className="tt-paragraph"><Trans>Each event carries a random ID for this install, and Sotto also sends hashed IDs of your Claude and OpenAI accounts. Hashed is not anonymous: those IDs link your computers to one person.</Trans></p>
      <p className="tt-paragraph product-events-notice__never"><Trans>It never sends your words, code, file names, paths, repo or branch names, thread IDs or keys.</Trans></p>
      {failed ? <p className="tt-paragraph product-events-notice__failed" role="alert"><Trans>Your answer could not be saved, and nothing was sent. Try again.</Trans></p> : null}
      <div className="product-events-notice__actions">
        <Button variant="primary" disabled={busy} onClick={() => void answer(false)}><Trans comment="On the product events notice: keeps them on and closes the notice.">Got it</Trans></Button>
        <Button variant="secondary" disabled={busy} onClick={() => void answer(true)}><Trans comment="On the product events notice: turns them off.">Turn off</Trans></Button>
        <button type="button" className="product-events-link tt-focusable" onClick={() => setListOpen(true)}><Trans>See every event</Trans></button>
      </div>
    </aside>
    {listOpen ? <ProductEventsDialog onClose={() => setListOpen(false)} /> : null}
  </>
}
