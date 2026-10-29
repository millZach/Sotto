import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import type { CheckReplyExcerpt, DelegatedView, DelegationCheckReply } from '../../../shared/delegation'
import { WATCHER_REPLY_BYTES_MAX } from '../../../shared/watcher'
import { useInterfaceLanguageState } from '../state/interfaceLanguage'
import { shownCount } from '../state/interfaceNumbers'
import { clockLabel } from './threadFacts'

/**
 * A check's reply on its row of delegated work (#1312, Zach's pick C on October 28, 2026, variant C of
 * docs/prototypes/check-reply-card-prototype.html, tag `prototype/check-reply-card`): the reply's first line, quoted and
 * said as the thread's, as a second line on the row, and the rest in a tray over the bottom of the transcript, read from
 * main only on a press. Sotto reads no pass or fail from it: nothing is coloured, badged or iconed by what it says, the
 * outcome stays Answered, and the tray shows the lines in the order the thread wrote them.
 */

/** The lines the tray shows; the rest are in the check's thread. */
export const CHECK_TRAY_LINES = 60
/** The tray's height when the window allows it, and the least it keeps however short the window. */
const TRAY_MOST = 400, TRAY_LEAST = 200

/** A check's reply as main gave it on the press, cut at 32 KiB. */
interface ShownReply { readonly text: string; readonly truncated: boolean }
interface OpenTray { readonly id: string; readonly opener: HTMLElement; readonly reply: ShownReply }
interface CheckTrays {
  readonly open: OpenTray | null
  /** Opens a row's tray with the reply its press read, in place of any other row's. */
  readonly show: (id: string, opener: HTMLElement, reply: ShownReply) => void
  /** Closes a row's tray, if it is the one open; `returning`, focus goes back to the control that opened it. */
  readonly close: (id: string, returning: boolean) => void
}
const CheckTraysContext = createContext<CheckTrays | null>(null)

/** One transcript's tray: one open at a time, opened from the row that owns it. */
export function CheckTraysProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [open, setOpen] = useState<OpenTray | null>(null)
  const current = useRef(open)
  current.current = open
  const show = useCallback((id: string, opener: HTMLElement, reply: ShownReply) => {
    current.current = { id, opener, reply }
    setOpen(current.current)
  }, [])
  const close = useCallback((id: string, returning: boolean) => {
    const held = current.current
    if (held?.id !== id) return
    current.current = null
    setOpen(null)
    if (returning && held.opener.isConnected) held.opener.focus({ preventScroll: true })
  }, [])
  const trays = useMemo(() => ({ open, show, close }), [open, show, close])
  return <CheckTraysContext.Provider value={trays}>{children}</CheckTraysContext.Provider>
}

/** Whether this delegation's tray is the one open, so its row is marked while it is. */
export function useCheckTrayOpen(id: string): boolean {
  return useContext(CheckTraysContext)?.open?.id === id
}

/** What names a check in its row's controls and its tray: its title and its machine, "this computer" or a host's name. */
export interface CheckNames { readonly title: string; readonly machine: string }

/**
 * The second line of an answered check's row: "It replied" and the excerpt in quotes, "· cut at 32 KiB" when Sotto cut the
 * reply, and Read its reply; or, when its reply was not kept here, a sentence saying so, with no tray. Nothing while it
 * works, so a waiting check's card is today's. Read its reply reads the reply from main first, and opens the tray only
 * with it: a reply main no longer holds turns the line into the not-kept sentence, with the focus on it, never an empty
 * tray (Sol on #1312). A read that fails proves nothing lost: the excerpt and Read its reply stay, with the focus, and a
 * line under them says to try again, until a press reads it.
 */
export function CheckReplyLine({ reply, delegation, names, read, onOpenCheck }: { readonly reply: CheckReplyExcerpt | undefined; readonly delegation: DelegatedView
  readonly names: CheckNames; readonly read: ((delegationId: string) => Promise<DelegationCheckReply>) | undefined; readonly onOpenCheck: (() => void) | undefined }): ReactNode {
  const { t } = useLingui()
  const trays = useContext(CheckTraysContext)
  const trayId = useId()
  // The excerpt a press found no longer held, so the row says so until main's next read; and whether that press moves the focus.
  const [gone, setGone] = useState<CheckReplyExcerpt | undefined>(undefined)
  // The last press's read failed, so main never answered: nothing is known lost, and a press tries again.
  const [failed, setFailed] = useState(false)
  const asking = useRef(false), mounted = useRef(true), unkept = useRef<HTMLParagraphElement>(null), toUnkept = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const notKept = reply !== undefined && (gone === reply || 'unavailable' in reply)
  useEffect(() => {
    if (notKept && toUnkept.current) { toUnkept.current = false; unkept.current?.focus({ preventScroll: true }) }
  }, [notKept])
  useInterfaceLanguageState()
  const held = trays?.open?.id === delegation.id ? trays.open : undefined
  // The tray goes with its row: a fold closed over it, or another thread in the pane, closes it.
  const close = trays?.close, id = delegation.id
  useEffect(() => () => close?.(id, false), [close, id])
  const closeTray = useCallback((returning: boolean) => close?.(id, returning), [close, id])
  if (reply === undefined) return null
  if (notKept || 'unavailable' in reply) return <p ref={unkept} className="check-unkept tt-paragraph" tabIndex={-1}>{t`Its reply wasn't kept here. Open the check to read it in its thread.`}</p>
  const { title, machine } = names
  const kib = shownCount(WATCHER_REPLY_BYTES_MAX / 1024)
  const canRead = trays !== null && read !== undefined
  const open = held !== undefined && canRead
  return <><p className="check-excerpt">
    <span className="check-excerpt__who">{t({ message: 'It replied', comment: 'Before a quote of the first line of a check\'s reply, in the check\'s own words.' })}</span>
    {' '}<q title={reply.excerpt}>{reply.excerpt}</q>
    {reply.truncated ? <>{' '}<span className="check-excerpt__cut"><span aria-hidden="true">· </span>{t({ message: `cut at ${kib} KiB`, comment: 'Sotto passed on only the first {kib} KiB of a check\'s reply.' })}</span></> : null}
    {canRead ? <>{' '}<button type="button" className="check-open tt-focusable" aria-expanded={open} aria-controls={open ? trayId : undefined}
      aria-label={t({ message: `Read the reply from ${title}, the check on ${machine}`, comment: '{title} is the check\'s thread; {machine} is "this computer" or a host\'s name.' })}
      onClick={event => {
        if (open) { trays.close(id, false); return }
        if (asking.current) return
        const opener = event.currentTarget, shown = reply
        asking.current = true
        const answered = (answer: DelegationCheckReply): void => {
          asking.current = false
          if (!mounted.current) return
          setFailed(false)
          if (answer) trays.show(id, opener, { text: answer.text, truncated: answer.truncated })
          else { toUnkept.current = opener === document.activeElement; setGone(shown) }
        }
        read(id).then(answered, () => { asking.current = false; if (mounted.current) setFailed(true) })
      }}>{t`Read its reply`}</button></> : null}
  </p>
  {failed && canRead && !open ? <p className="check-failed tt-paragraph" role="status">{t`Sotto couldn't read its reply just now. Nothing was lost. Try Read its reply again, or open the check.`}</p> : null}
  {open ? <CheckReplyTray id={trayId} delegation={delegation} names={names} opener={held.opener} reply={held.reply}
    onClose={closeTray} onOpenCheck={onOpenCheck} /> : null}</>
}

/** The reply's lines as the tray shows them: the first `CHECK_TRAY_LINES`, and how many with words in them follow. */
export function trayLines(text: string): { readonly shown: string; readonly lines: number; readonly more: boolean; readonly left: number } {
  const lines = text.split(/\r?\n/u)
  const shown = lines.slice(0, CHECK_TRAY_LINES)
  return { shown: shown.join('\n'), lines: shown.length, more: lines.length > CHECK_TRAY_LINES, left: lines.slice(CHECK_TRAY_LINES).filter(line => line.trim() !== '').length }
}

/**
 * The tray over the bottom of the transcript: the check's title, whose words these are and when, the reply's first sixty
 * lines in the thread's own type with the dashed edge another thread's words wear, then what follows and Open the check.
 * Escape and Close return focus to Read its reply. It stops short of its row, which stays in view above it, at the
 * window's minimum too.
 */
function CheckReplyTray({ id, delegation, names, opener, reply, onClose, onOpenCheck }: { readonly id: string; readonly delegation: DelegatedView; readonly names: CheckNames
  readonly opener: HTMLElement; readonly reply: ShownReply; readonly onClose: (returning: boolean) => void; readonly onOpenCheck: (() => void) | undefined }): ReactNode {
  const { t } = useLingui()
  const whoId = useId()
  const tray = useRef<HTMLElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useInterfaceLanguageState()

  // Where it goes: over the bottom of the transcript, in its column, above the composer.
  const [host] = useState<HTMLElement>(() => opener.closest<HTMLElement>('.thread-transcript') ?? document.body)
  const scroller = opener.closest<HTMLElement>('.thread-workspace__transcript')
  useLayoutEffect(() => { tray.current?.focus({ preventScroll: true }) }, [])
  // The tray stops short of its row's height, so the row fits above it; the transcript gains room to scroll under it.
  useLayoutEffect(() => {
    const element = tray.current, row = opener.closest<HTMLElement>('.delegated-work__row')
    if (!element || !row || !scroller) return
    scroller.style.removeProperty('padding-bottom')
    const base = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
    const fit = (): void => {
      const below = Number.parseFloat(getComputedStyle(element).bottom) || 0
      element.style.maxHeight = `${Math.max(TRAY_LEAST, Math.min(TRAY_MOST, scroller.clientHeight - below - row.getBoundingClientRect().height - 28))}px`
      scroller.style.paddingBottom = `${base + element.offsetHeight + 16}px`
      const view = scroller.getBoundingClientRect(), box = row.getBoundingClientRect(), limit = element.getBoundingClientRect().top - 10
      if (box.bottom > limit || box.top < view.top) scroller.scrollTop += box.top - view.top - 8
      const body = text.current
      setMore(body !== null && body.scrollTop + body.clientHeight < body.scrollHeight - 2)
    }
    fit()
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit); scroller.style.removeProperty('padding-bottom') }
  }, [opener, scroller, reply])

  // Escape closes it wherever the focus is in this transcript, before the Worked for fold it sits in. It listens from the
  // commit that draws the tray, as the focus moves into it: a passive effect runs a task later, and an Escape in that gap
  // went to the fold, which closed the turn, and the tray with it, and kept the focus (#1776).
  useLayoutEffect(() => {
    const transcript = opener.closest('.thread-transcript')
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const target = event.target instanceof Node ? event.target : null
      const here = target === null || target === document.body || target === opener || tray.current?.contains(target) === true || transcript?.contains(target) === true
      if (!here) return
      event.preventDefault()
      onClose(true)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [opener, onClose])

  const { title, machine } = names
  const time = delegation.outcomeAt === undefined ? undefined : clockLabel(Date.parse(delegation.outcomeAt)) || undefined
  const whose = time === undefined
    ? t({ message: `Its reply, in its own words, on ${machine}`, comment: 'Heads the tray with a check\'s reply. {machine} is "this computer" or a host\'s name.' })
    : t({ message: `Its reply, in its own words, on ${machine} · ${time}`, comment: 'Heads the tray with a check\'s reply. {machine} is "this computer" or a host\'s name; {time} is when it answered.' })
  const kib = shownCount(WATCHER_REPLY_BYTES_MAX / 1024)
  const lines = trayLines(reply.text)
  const first = lines.more ? t`Its first ${{ count: shownCount(CHECK_TRAY_LINES) }} lines.` : undefined
  const rest = reply.truncated ? t`Its reply was longer than ${kib} KiB, so this thread was given only the first ${kib} KiB. All of it is in the check's thread.`
    : lines.left ? plural(lines.left, { one: '# more line is in its thread.', other: '# more lines are in its thread.' })
      : t`That is all of its reply.`
  const foot = [first, rest].filter(Boolean).join(' ')
  const scrolls = lines.lines > 8
  const openCheck = onOpenCheck === undefined ? null : <button type="button" className="check-open tt-focusable"
    aria-label={t({ message: `Open ${title}, the check on ${machine}, to read all of its reply`, comment: '{title} is the check\'s thread; {machine} is "this computer" or a host\'s name.' })}
    onClick={() => { onClose(false); onOpenCheck() }}>{t`Open the check`}</button>
  return createPortal(<section ref={tray} className="check-tray" id={id} role="dialog" aria-modal="false" tabIndex={-1} aria-labelledby={whoId} data-reveal="">
    <div className="check-tray__head">
      <h3 className="check-tray__who" id={whoId}><b>{title}</b><span>{whose}</span></h3>
      <button type="button" className="check-tray__close tt-focusable" aria-label={t`Close the reply`} onClick={() => onClose(true)}><X size={16} aria-hidden="true" /></button>
    </div>
    <div ref={text} className="check-tray__text" data-more={more || undefined}
      onScroll={event => { const body = event.currentTarget; setMore(body.scrollTop + body.clientHeight < body.scrollHeight - 2) }}
      {...scrolls ? { tabIndex: 0, role: 'region', 'aria-label': lines.more ? t`The reply's first ${{ count: shownCount(CHECK_TRAY_LINES) }} lines` : t`Its whole reply` } : {}}>
      <pre className="check-pre">{lines.shown}</pre>
    </div>
    <p className="check-tray__foot tt-paragraph"><span>{foot}</span>{openCheck}</p>
  </section>, host)
}
