import React, { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, CornerDownRight, X } from 'lucide-react'
import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { shownWords, type LaterWords } from '../features/settings/laterWords'
import { PROVIDER_LABELS, type AgentMessageHandover } from '../../../shared/agents'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { handoverLedger } from '../../../shared/handover'
import { SottoMark } from '../components/SottoMark'
import { clockLabel } from '../agents/threadFacts'
import type { WatcherHandoverCalls, WatcherRoom } from './watcherRoom'

/**
 * Watcher's handover after a provider change (ADR-0073, Zach's pick B of the continue prototype, in place): a strip over
 * the new Watcher's composer says that sending starts it with a handover of the last one, what that carries and leaves
 * out, offers it to read, and puts it away on X or Escape. Only a send made while the strip stands carries it, ahead of
 * the user's words in the same message; the conversation then shows it as Sotto's handover, context rather than a request.
 */

/** What a handover carried and left out, in words; shared with a continued thread's handover (ADR-0089). */
export { handoverLedger }

/**
 * Sending with the handover, for Watcher's composer while the offer stands: the send button's words, and the step that
 * tells main which draft carries it before the draft goes. `prepare` answers main's refusal, or null.
 */
export interface WatcherSendGate {
  readonly label: string
  readonly prepare: (draftId: string) => Promise<string | null>
}
export const WatcherSendGateContext = createContext<WatcherSendGate | null>(null)
export function useWatcherSendGate(): WatcherSendGate | null { return useContext(WatcherSendGateContext) }

/**
 * The gate for an offer, through the room's own calls; null without an offer or a bridge that takes one. `label` is the
 * send button's words in the interface language, so the gate is made again when the language changes.
 */
export function watcherSendGate(calls: WatcherHandoverCalls | null | undefined, settle: WatcherRoom['settle'] | undefined, offered: boolean, label: string): WatcherSendGate | null {
  if (!offered || calls == null || settle === undefined) return null
  return {
    label,
    prepare: async draftId => {
      try { return settle(await calls.continueWith({ draftId })) } catch { return i18n._(msg`Sotto could not reach Watcher, so nothing was sent. Send your message again.`) }
    },
  }
}

/** The offer over the new Watcher's composer. Keyed by the conversation it hands over, so a new offer starts closed. */
export function WatcherHandoverOffer({ room, offer, composerId }: {
  readonly room: WatcherRoom
  readonly offer: NonNullable<WatcherRoomState['handover']>
  /** The composer focus goes to when the offer is put away, or when it arrives with focus nowhere. */
  readonly composerId: string
}): ReactNode {
  const { t } = useLingui()
  const [text, setText] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<LaterWords | null>(null)
  const readButton = useRef<HTMLButtonElement>(null)
  const strip = useRef<HTMLElement>(null)
  const putAway = useRef<() => void>(() => undefined)
  const regionId = useId()
  const { carried, leftOut } = handoverLedger(offer.counts)
  // A provider change remounts the composer under the pointer or the keyboard; focus that went nowhere goes back to it.
  useEffect(() => {
    if (document.activeElement === null || document.activeElement === document.body) document.getElementById(composerId)?.focus()
  }, [composerId])
  // Escape from the composer under the strip puts the offer away too, once nothing open there has taken the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const area = strip.current?.closest('.thread-workspace__compose')
      if (event.key !== 'Escape' || !(event.target instanceof Element) || !area?.contains(event.target) || strip.current?.contains(event.target)) return
      // The prompt editor's own keymap takes every Escape to select around the caret, which leaves nothing open; there,
      // only a composer menu that is open keeps the key.
      const editor = event.target.closest('.prompt-editor')
      if (event.defaultPrevented && (editor === null || editor.getAttribute('aria-expanded') === 'true')) return
      event.preventDefault()
      putAway.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const calls = room.handover
  if (calls === null) return null
  const toggle = async (): Promise<void> => {
    if (open) { setOpen(false); return }
    if (text !== null) { setOpen(true); return }
    setReading(true); setError(null)
    try {
      const read = await calls.read()
      if (read.status === 'ok') { setText(read.text); setOpen(true) } else setError(read.message)
    } catch { setError(msg`Sotto could not read the handover. Nothing was sent. Press Read it to try again.`) }
    finally { setReading(false) }
  }
  const dismiss = async (): Promise<void> => {
    setError(null)
    document.getElementById(composerId)?.focus()
    try { const refusal = room.settle(await calls.dismiss()); if (refusal !== null) setError(refusal) }
    catch { setError(msg`Sotto could not put the handover away, so it still goes with your next message. Nothing was sent. Press X to try again.`) }
  }
  putAway.current = () => { void dismiss() }
  const provider = PROVIDER_LABELS[offer.provider]
  return <section ref={strip} className="watcher-handover" aria-label={t`Handover of the last Watcher`}
    onKeyDown={event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      // Escape closes what is open first, then puts the offer away.
      if (open) { setOpen(false); readButton.current?.focus() } else void dismiss()
    }}>
    <div className="watcher-handover__lead">
      <CornerDownRight size={15} aria-hidden="true" />
      {/* After New Watcher, the last one was on the same provider, so the strip names none. */}
      <p className="tt-paragraph" role="status">{offer.provider === room.state?.current?.provider
        ? <Trans>Sending starts the new Watcher with a <strong>handover</strong> of the last one.</Trans>
        : <Trans>Sending starts the new Watcher with a <strong>handover</strong> of the last one, from {provider}.</Trans>}</p>
      <button type="button" className="watcher-handover__dismiss tt-focusable" aria-label={t`Don’t hand over: start the new Watcher without it`}
        title={t`Don’t hand over: start the new Watcher without it`} onClick={() => void dismiss()}><X size={15} aria-hidden="true" /></button>
    </div>
    <p className="watcher-handover__ledger tt-paragraph">
      {offer.counts.historyKept ? null : <>{t`Keep local history is off, so it holds only what Sotto kept since it last started.`}{' '}</>}
      {leftOut === null ? t`It carries ${carried}.` : t`It carries ${carried} and leaves out ${leftOut}.`}{' '}
      <button ref={readButton} type="button" className="watcher-handover__read tt-focusable" aria-expanded={open} aria-controls={open ? regionId : undefined}
        disabled={reading} onClick={() => void toggle()}>{open ? t`Hide it` : reading ? t`Reading it…` : t`Read it`}</button>
    </p>
    {open && text !== null ? <div id={regionId} className="watcher-handover__text tt-focusable" tabIndex={0} role="region" aria-label={t`The handover, word for word`}>{text}</div> : null}
    {error === null ? null : <p className="watcher-handover__error tt-paragraph" role="alert">{shownWords(error)}</p>}
  </section>
}

/**
 * The thread a continued thread's handover came from (ADR-0089), which its card names; absent in Watcher's conversation,
 * whose handover is always of the last Watcher.
 */
export const HandoverFromContext = createContext<{ readonly title: string } | null>(null)

/**
 * The handover a message carried, as Sotto's, ahead of the user's words: where it came from, that it is context and not
 * a request, what it carried and left out, and its words on request. Escape folds them again.
 */
export function HandoverMessage({ handover, createdAt }: { readonly handover: AgentMessageHandover; readonly createdAt: string }): ReactNode {
  const { t } = useLingui()
  const from = useContext(HandoverFromContext)
  const fromTitle = from?.title
  const provider = PROVIDER_LABELS[handover.provider]
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const regionId = useId()
  const { carried, leftOut } = handoverLedger(handover.counts)
  return <article className="thread-message watcher-handover-message" data-role="user" data-from="sotto" aria-label={from ? t`Handover from ${fromTitle}` : t`Handover from the last Watcher`}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus()
    }}>
    <header><span className="thread-message__who"><SottoMark className="thread-message__mark" />Sotto</span><span className="thread-message__tag">{t({ message: 'Handover', comment: 'The tag on a message that carries a handover' })}</span>
      <time dateTime={createdAt}>{clockLabel(Date.parse(createdAt))}</time></header>
    <p className="watcher-handover-message__lead tt-paragraph">{from
      ? <Trans>From <strong>{fromTitle}</strong> on {provider}. Context, not a new request.</Trans>
      : <Trans>From the last Watcher, on {provider}. Context, not a new request.</Trans>}</p>
    <p className="watcher-handover-message__ledger tt-paragraph">{handover.counts.historyKept ? null : <>{t`Keep local history was off, so it held only what Sotto had kept since it last started.`}{' '}</>}
      {t`Carried ${carried}.`}{leftOut === null ? '' : <>{' '}{t`Left out ${leftOut}.`}</>}</p>
    <button ref={button} type="button" className="watcher-handover__disclose tt-focusable" aria-expanded={open} aria-controls={open ? regionId : undefined}
      onClick={() => setOpen(value => !value)}><ChevronRight size={14} aria-hidden="true" />{open ? t`Hide the handover` : t`Read the handover, word for word`}</button>
    {open ? <div id={regionId} className="watcher-handover__text tt-focusable" tabIndex={0} role="region" aria-label={t`The handover, word for word`}>{handover.text}</div> : null}
  </article>
}
