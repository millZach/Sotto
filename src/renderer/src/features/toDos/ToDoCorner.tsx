import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronUp, ExternalLink, ListTodo } from 'lucide-react'
import { plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'

import { TO_DO_NOTE_MAX, TO_DO_TITLE_MAX, type ToDosBridge } from '../../../../shared/toDos'
import { useOptionalAgents } from '../../agents/AgentContext'
import { listedHosts } from '../../agents/HostBadge'
import { Button } from '../../components/Button'
import { useMark } from '../../components/marks'
import { useOptionalApp } from '../../state/AppContext'
import { useOwlFeature } from '../../state/owlFeature'
import { shownCount } from '../../state/interfaceNumbers'
import { toDoClientOf, useToDos, type ToDoClient, type ToDoFailure, type ToDoRow } from './toDoClient'
import './toDos.css'

/** How long the list takes to roll back up, so it is still there to watch as it goes. */
const ROLL_UP_MS = 400

/** Whether the list stands in this window: the Owl list's answer, and the bridge main hands it only then. */
export function useToDosOn(bridge: ToDosBridge | undefined = window.sotto?.toDos): boolean {
  return useOwlFeature('to-do-list') && bridge !== undefined
}

/**
 * The to-do list (ADR-0188): a small icon in the window's corner, on every page. A press unrolls the list downward like a
 * scroll, as long as what it holds up to the window's height. A press outside, Escape, Roll up or the icon rolls it back up,
 * and so does the last item going. Owl only: stable has no bridge and this renders nothing.
 */
export function ToDoCorner({ bridge = window.sotto?.toDos }: { readonly bridge?: ToDosBridge | undefined }): ReactNode {
  const on = useToDosOn(bridge)
  if (!on || !bridge) return null
  return <ToDoCornerView client={toDoClientOf(bridge)} />
}

function ToDoCornerView({ client }: { readonly client: ToDoClient }): ReactNode {
  const { t } = useLingui()
  const { rows, left, unseen, failure, canAdd, view } = useToDos(client)
  const [phase, setPhase] = useState<'closed' | 'open' | 'rolling'>('closed')
  const [top, setTop] = useState(44)
  /** What was new when it opened, or came while it stood open: marked until it rolls up, though the badge has gone quiet. */
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set())
  const container = useRef<HTMLDivElement>(null)
  const icon = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const panelId = useId()
  const open = phase === 'open'
  useMark('to-do', true)

  const rollUp = useCallback((refocus: boolean): void => {
    client.rolledUp()
    setPhase('rolling')
    if (refocus) icon.current?.focus()
  }, [client])
  // Rolling up is seen through, then the list leaves the page. Unrolling again in those moments keeps it.
  useEffect(() => {
    if (phase !== 'rolling') return
    const timer = window.setTimeout(() => { setPhase('closed'); setMarked(new Set()) }, ROLL_UP_MS)
    return () => window.clearTimeout(timer)
  }, [phase])
  // Opening quiets the badge on each computer, and so does anything that comes while it stands open.
  useEffect(() => {
    if (!open) return
    const fresh = rows.filter(row => !row.item.seen).map(row => row.key)
    if (fresh.some(key => !marked.has(key))) setMarked(new Set([...marked, ...fresh]))
    if (fresh.length) client.seen()
  }, [client, marked, open, rows])
  // The last item going rolls the list up. A list opened empty stays, for adding to.
  const rowsBefore = useRef(rows.length)
  useEffect(() => {
    const before = rowsBefore.current
    rowsBefore.current = rows.length
    if (!open || before === 0 || rows.length > 0) return
    const focused = document.activeElement
    rollUp(focused === null || focused === document.body || container.current?.contains(focused) === true)
  }, [open, rollUp, rows.length])
  // A press anywhere else rolls it up and leaves focus where the press put it.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!container.current?.contains(event.target as Node)) rollUp(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open, rollUp])
  // Escape rolls it up wherever focus is, except from a note being written, which it closes first.
  useEffect(() => {
    if (!open) return
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || (event.target as Element | null)?.closest?.('.to-do-row__note')) return
      event.preventDefault(); event.stopPropagation()
      const focused = document.activeElement
      rollUp(focused === null || focused === document.body || container.current?.contains(focused) === true)
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [open, rollUp])
  const unroll = useCallback((): void => {
    const bottom = icon.current?.getBoundingClientRect().bottom
    if (bottom !== undefined) setTop(Math.round(bottom) + 7)
    setPhase('open')
  }, [])
  // A press opens it with the focus on its heading. A failure opens it where the focus is: the user is doing something else.
  const takeFocus = useRef(false)
  useLayoutEffect(() => {
    if (open && takeFocus.current) heading.current?.focus({ preventScroll: true })
    takeFocus.current = false
  }, [open])
  // A press that failed says so, even with the list rolled up by then or the wait gone on across another page. Rolling up
  // is what reads it.
  useEffect(() => { if (failure && phase !== 'open') unroll() }, [failure, phase, unroll])

  const press = (): void => {
    if (open) { rollUp(true); return }
    takeFocus.current = true
    unroll()
  }
  const onBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null
    if (open && next !== null && !event.currentTarget.contains(next)) rollUp(false)
  }

  const loud = !open && unseen > 0
  const shown = loud ? unseen : left
  const count = shownCount(left)
  const newCount = shownCount(unseen)
  const label = loud
    ? t`To-do, ${count} to do, ${newCount} new. Unroll the list.`
    : open ? t`To-do, ${count} to do. Roll up the list.` : t`To-do, ${count} to do. Unroll the list.`
  const machines = view.machines.length
  return <div ref={container} className="to-do" onBlur={onBlur}>
    <button ref={icon} type="button" className="to-do__icon tt-focusable" aria-expanded={open} aria-haspopup="dialog" aria-controls={phase === 'closed' ? undefined : panelId}
      aria-label={label} title={t`To-do`} onClick={press}>
      <ListTodo size={17} aria-hidden="true" />
      {shown > 0 ? <span className="to-do__badge" data-loud={loud || undefined} aria-hidden="true">{shownCount(shown)}</span> : null}
    </button>
    {phase === 'closed' ? null : <div id={panelId} className="to-do-scroll" data-open={open || undefined} role="dialog" aria-label={t`To-do`} inert={!open}
      style={{ '--to-do-top': `${top}px` } as CSSProperties}>
      <div className="to-do-scroll__paper">
        <div className="to-do-scroll__sheet">
          <div className="to-do-scroll__head">
            <h2 ref={heading} tabIndex={-1}><Trans>To-do</Trans></h2>
            <span><Trans>{count} to do</Trans></span>
          </div>
          <ToDoList rows={rows} marked={marked} client={client} several={machines > 1} rollUp={() => rollUp(false)} />
          {failure ? <ToDoFailureLine failure={failure} /> : null}
          <ToDoFoot client={client} canAdd={canAdd} onRollUp={() => rollUp(true)} />
        </div>
      </div>
      <div className="to-do-scroll__roll" aria-hidden="true" onClick={() => rollUp(true)} />
    </div>}
  </div>
}

/** What happened, what is true now and what to do: no press here can say more, since the cause is on the computer that refused it. */
function ToDoFailureLine({ failure }: { readonly failure: ToDoFailure }): ReactNode {
  const { title, press } = failure
  return <p className="to-do-scroll__failure" role="alert">
    {press === 'check' ? <Trans>Sotto could not check off “{title}”, so it is still on your list. Try again.</Trans>
      : press === 'tell' ? <Trans>Sotto could not send your words about “{title}”, so it is still on your list. Your words are still in the box. Try again.</Trans>
        : <Trans>Sotto could not add “{title}”, so it is not on your list. Your list may be full. Check something off and try again.</Trans>}
  </p>
}

function ToDoList({ rows, marked, client, several, rollUp }: {
  readonly rows: readonly ToDoRow[]
  readonly marked: ReadonlySet<string>
  readonly client: ToDoClient
  readonly several: boolean
  readonly rollUp: () => void
}): ReactNode {
  const list = useRef<HTMLUListElement>(null)
  const lastRow = useRef(0)
  // A row leaving with the focus in it hands the focus to the row that takes its place, or the one before, then the heading.
  useLayoutEffect(() => {
    if (document.activeElement !== document.body) return
    const items = list.current?.querySelectorAll<HTMLElement>(':scope > li')
    if (!items?.length) return
    const row = items[Math.min(lastRow.current, items.length - 1)]
    row?.querySelector<HTMLElement>('button')?.focus()
  }, [rows.length])
  if (!rows.length) return <div className="to-do-scroll__body"><p className="to-do-scroll__none"><Trans>Nothing left to do.</Trans></p></div>
  return <div className="to-do-scroll__body">
    <ul ref={list} onFocusCapture={event => {
      const items = [...(list.current?.children ?? [])], at = items.findIndex(item => item.contains(event.target))
      if (at >= 0) lastRow.current = at
    }}>
      {rows.map(row => <ToDoItem key={row.key} row={row} client={client} isNew={marked.has(row.key) || !row.item.seen} several={several} rollUp={rollUp} />)}
    </ul>
  </div>
}

function ToDoItem({ row, client, isNew, several, rollUp }: {
  readonly row: ToDoRow
  readonly client: ToDoClient
  readonly isNew: boolean
  readonly several: boolean
  readonly rollUp: () => void
}): ReactNode {
  const { t } = useLingui()
  const app = useOptionalApp()
  const agents = useOptionalAgents()
  const { item } = row
  const [stepsOpen, setStepsOpen] = useState(false)
  const [noting, setNoting] = useState(false)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const undo = useRef<HTMLButtonElement>(null)
  const check = useRef<HTMLButtonElement>(null)
  const noteField = useRef<HTMLInputElement>(null)
  const noteOpener = useRef<HTMLButtonElement>(null)
  // Focus stays on the row as it changes hands between its check box and its Undo.
  const movedBy = useRef(false)
  useLayoutEffect(() => {
    if (!movedBy.current) return
    movedBy.current = false
    ;(row.held ? undo : check).current?.focus()
  }, [row.held])
  // The note's field takes the focus as it opens, and its opener takes it back as it closes.
  const noteWasOpen = useRef(false)
  useLayoutEffect(() => {
    if (noting) noteField.current?.focus()
    else if (noteWasOpen.current) noteOpener.current?.focus()
    noteWasOpen.current = noting
  }, [noting])

  const state = agents?.state
  const thread = item.threadId === undefined ? undefined : state?.host.threads.find(entry => entry.id === item.threadId)
  const threadName = thread?.title
  const host = several && state ? listedHosts(state).find(entry => entry.hostId === row.hostId)?.name : undefined
  if (row.held) {
    const title = item.title
    return <li className="to-do-row" data-held="">
      <p className="to-do-row__gone" role="status"><Trans>Checked off: {title}</Trans></p>
      {row.sending ? null : <Button ref={undo} variant="secondary" aria-label={t`Undo checking off: ${title}`} onClick={() => { movedBy.current = true; client.undo(row.key) }}><Trans>Undo</Trans></Button>}
    </li>
  }
  const openThread = (): void => {
    if (!item.threadId || !agents) return
    void agents.command({ type: 'select-thread', threadId: item.threadId })
    app?.actions.navigate('threads')
    rollUp()
  }
  const send = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const words = note.trim()
    if (!words || sending) return
    setSending(true)
    // Success takes the row away; a failure leaves the words in place to send again.
    await client.didNotWork(row, words)
    setSending(false)
  }
  const cancelNote = (): void => { setNoting(false); setNote('') }
  const onNoteKey = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation()
    cancelNote()
  }
  const title = item.title
  const stepCount = item.steps?.length ?? 0
  return <li className="to-do-row">
    <button ref={check} type="button" role="checkbox" aria-checked={false} className="to-do-row__check tt-focusable" aria-label={t`Check off: ${title}`}
      onClick={() => { movedBy.current = true; client.check(row) }}><span aria-hidden="true" /></button>
    <div className="to-do-row__words">
      <div className="to-do-row__title">{isNew ? <em className="to-do-row__new" role="img" aria-label={t`New`} /> : null}{item.title}</div>
      {item.why ? <div className="to-do-row__why">{item.why}</div> : null}
      <div className="to-do-row__meta">
        {thread && threadName !== undefined
          ? <button type="button" className="to-do-row__link tt-focusable" data-kind="thread" aria-label={t`Open the thread ${threadName}`} onClick={openThread}>{threadName}</button>
          : item.by === 'user' ? <span><Trans>You added this</Trans></span>
            : item.by === 'watcher' ? <span><Trans>Watcher added this</Trans></span>
              : item.by === 'thread' ? <span><Trans>A thread added this</Trans></span> : null}
        {host ? <span><Trans>on {host}</Trans></span> : null}
        {item.waits ? <span className="to-do-row__waits">{threadName !== undefined ? <Trans>{threadName} is waiting</Trans> : <Trans>A thread is waiting</Trans>}</span> : null}
        {item.link ? <button type="button" className="to-do-row__link tt-focusable" onClick={() => void window.sotto?.openExternalLink?.(item.link!.url)}>{item.link.label} <ExternalLink size={12} aria-hidden="true" /></button> : null}
        {stepCount ? <button type="button" className="to-do-row__link tt-focusable" aria-expanded={stepsOpen} onClick={() => setStepsOpen(!stepsOpen)}>
          {stepsOpen ? plural(stepCount, { one: 'Hide # step', other: 'Hide # steps' }) : plural(stepCount, { one: 'Show # step', other: 'Show # steps' })}
        </button> : null}
      </div>
      {stepsOpen && item.steps ? <ol className="to-do-row__steps">{item.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}
      {!item.waits ? null : noting
        ? <form className="to-do-row__note" onKeyDown={onNoteKey} onSubmit={event => void send(event)}>
          <input ref={noteField} className="tt-focusable" value={note} maxLength={TO_DO_NOTE_MAX} placeholder={t`Say what happened`} aria-label={t`What happened with ${title}`}
            onChange={event => setNote(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!note.trim() || sending}>{threadName !== undefined ? <Trans>Tell {threadName}</Trans> : <Trans>Tell the thread</Trans>}</Button>
          <Button type="button" variant="ghost" onClick={cancelNote}><Trans>Cancel</Trans></Button>
        </form>
        : <div className="to-do-row__meta"><button ref={noteOpener} type="button" className="to-do-row__link tt-focusable" onClick={() => setNoting(true)}><Trans>It didn't work</Trans></button></div>}
    </div>
  </li>
}

function ToDoFoot({ client, canAdd, onRollUp }: { readonly client: ToDoClient; readonly canAdd: boolean; readonly onRollUp: () => void }): ReactNode {
  const { t } = useLingui()
  const [title, setTitle] = useState('')
  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const words = title.trim()
    if (!words) return
    setTitle('')
    // A failure gives the words back to send again, unless the user has moved on to writing others.
    if (!await client.add(words)) setTitle(current => current === '' ? words : current)
  }
  return <form className="to-do-scroll__foot" onSubmit={event => void add(event)}>
    <input className="tt-focusable" value={title} maxLength={TO_DO_TITLE_MAX} disabled={!canAdd} placeholder={canAdd ? t`Add your own` : t`This computer keeps no list right now`}
      aria-label={t`Add a to-do of your own`} onChange={event => setTitle(event.target.value)} />
    <button type="button" className="to-do-scroll__rollup tt-focusable" onClick={onRollUp}><ChevronUp size={15} aria-hidden="true" /><Trans>Roll up</Trans></button>
  </form>
}
