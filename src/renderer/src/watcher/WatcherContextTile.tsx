import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Shrink } from 'lucide-react'
import { i18n, type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { PROVIDER_LABELS } from '../../../shared/agents'
import { formatTokenCount } from '../../../shared/threadUsage'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp } from '../state/AppContext'
import { useAgents } from '../agents/AgentContext'
import type { WatcherRoom } from './watcherRoom'
import { WatcherOwl } from './WatcherOwl'

const COMPACT_FAILED = msg`Sotto could not start compacting Watcher’s conversation. Nothing was lost. Try again.`

/** How close to the compaction point Watcher's context is before the tile carries its dot and the panel says so. */
const NEAR = 0.9

type RoomContext = NonNullable<WatcherRoomState['context']>
type RoomKept = NonNullable<WatcherRoomState['state']>

/** Where Watcher's context stands against the point where Sotto compacts it, in the words the panel and the tile share. */
function contextFacts(context: RoomContext | null, provider: string | null) {
  const tokens = context?.tokens ?? null
  const compactAt = context?.compactAt ?? null
  const canCompact = context?.canCompact ?? true
  const compacting = context?.compacting === true
  const share = tokens === null || compactAt === null ? null : Math.min(1, tokens / compactAt)
  const near = canCompact && !compacting && share !== null && share >= NEAR
  const point = compactAt === null ? null : formatTokenCount(compactAt)
  const said: string[] = []
  if (compacting) said.push(i18n._(msg`Compacting Watcher’s conversation.`))
  else {
    if (tokens === null) said.push(i18n._(msg`Its provider has not reported its context yet.`))
    if (!canCompact) said.push(provider === null ? i18n._(msg`Its provider cannot compact, so each message rereads all of it.`) : i18n._(msg`${provider} cannot compact, so each message rereads all of it.`))
    else if (point !== null) {
      if (near) said.push(i18n._(msg`Close to ${point}.`))
      said.push(i18n._(msg`Sotto compacts Watcher’s conversation once it passes ${point}, between turns.`))
    }
  }
  return { tokens, compactAt, canCompact, compacting, share, near, point, sentence: said.join(' ') }
}

/** What one item waits on the user for, in the panel's words. */
function waitingWords(item: RoomKept['waitingOnUser'][number]): string {
  const delegated = item.delegatedThreadId !== undefined
  switch (item.waitsFor) {
    case 'question': return delegated ? i18n._(msg`Question in a thread it delegated to`) : i18n._(msg({ message: 'Question', comment: 'What a thread waits on the user for, in Watcher’s state' }))
    case 'permission': return delegated ? i18n._(msg`Permission request in a thread it delegated to`) : i18n._(msg`Permission request`)
    default: return delegated ? i18n._(msg`Prototype to review in a thread it delegated to`) : i18n._(msg`Prototype to review`)
  }
}

/** One group of Watcher's state: its label, how many, and its items, or "None". */
function StateGroup({ label, items }: { readonly label: string; readonly items: readonly ReactNode[] }): ReactNode {
  const { t } = useLingui()
  const count = items.length
  return <section className="watcher-context__group">
    <h4>{count > 0 ? t({ message: `${label}, ${count}`, comment: 'A group of Watcher’s state and how many items it holds' }) : label}</h4>
    {count > 0 ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="watcher-context__none tt-paragraph">{t({ message: 'None', comment: 'A group of Watcher’s state with nothing in it' })}</p>}
  </section>
}

/**
 * The Sotto Owl tile in Watcher's header, once Watcher runs (#1189, Zach's pick C): a button with a thin bar under it
 * that fills toward the point where Sotto compacts Watcher's conversation, and a dot once it is close. It opens a panel
 * under it with the numbers, Compact context, and Watcher's state, which compaction keeps. Escape closes the panel and
 * returns focus to the tile; a press outside closes it and leaves focus where that press put it. On macOS, where no
 * app mark sits in the window's corner, the button wears Watcher's owl instead of the mark.
 */
export function WatcherContextTile({ room }: { readonly room: WatcherRoom }): ReactNode {
  const { t } = useLingui()
  const agents = useAgents()
  const mac = useOptionalApp()?.platform === 'darwin'
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<MessageDescriptor | null>(null)
  const sent = useRef(false)
  const tile = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const headingId = useId()
  const summaryId = useId()
  const state = room.state
  const current = state?.current ?? null
  const provider = current === null ? null : PROVIDER_LABELS[current.provider]
  const facts = contextFacts(state?.context ?? null, provider)
  const running = state?.currentOptions?.status === 'running'
  const threadId = room.currentThreadId
  // A room state with no context at all (a projection from before #1189) offers no compaction.
  const canPress = state?.context != null && facts.canCompact && !facts.compacting && !running && !sending && threadId !== null

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const away = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !tile.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])

  const close = (): void => { setOpen(false); tile.current?.focus() }
  const compact = async (): Promise<void> => {
    if (sent.current || !canPress || threadId === null) return
    sent.current = true; setSending(true); setError(null)
    // The window's command lane answers null when main could not confirm the command.
    try {
      if (await agents.command({ type: 'compact-thread', threadId }) === null) setError(COMPACT_FAILED)
    } catch { setError(COMPACT_FAILED) }
    finally { sent.current = false; setSending(false) }
  }

  const used = formatTokenCount(facts.tokens ?? 0)
  const point = facts.point
  const summary = facts.compacting ? t`Compacting.`
    : facts.tokens === null ? t`Not reported yet.`
    : facts.canCompact && point !== null ? (facts.near ? t`${used} of ${point}, close to the point.` : t`${used} of ${point}.`)
    : `${used}.`
  const label = t`Watcher’s context and state`
  const showBar = facts.canCompact && (facts.compacting || facts.share !== null)
  const fill = facts.compacting ? 'busy' : facts.near ? 'near' : undefined
  const kept = state?.state
  const watching: readonly ReactNode[] = (kept?.watching ?? []).map(thread =>
    <React.Fragment key={`${thread.target.hostId}/${thread.target.threadId}`}>
      <span className="watcher-context__title">{thread.title}</span><span className="watcher-context__aside">{thread.waitsOn}</span>
    </React.Fragment>)
  // What waits on the user, as Sotto works it out live: never Watcher's own notes (October 24, 2026, Zach's pick A).
  const waiting: readonly ReactNode[] = (kept?.waitingOnUser ?? []).map((item, index) =>
    <React.Fragment key={`${item.target.hostId}/${item.target.threadId}/${item.requestCardId ?? item.waitsFor}/${index}`}>
      <span className="watcher-context__title">{item.title}</span><span className="watcher-context__aside">{waitingWords(item)}</span>
    </React.Fragment>)
  const groups: RoomKept['kept'] = kept?.kept ?? { decisions: [], rules: [], issues: [], updatedAt: null }
  // Watcher's open lines: a closed line is done, and stays only for Watcher to read until Sotto clears it.
  const openLines = (lines: RoomKept['kept']['decisions']): readonly ReactNode[] => lines.flatMap(line => line.closedAt === undefined ? [line.text] : [])

  // Escape answers on the tile as well as in the panel: Shift+Tab back to the tile leaves the panel open.
  return <div className="watcher-context" onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button ref={tile} type="button" className="watcher-head__tile watcher-context__tile tt-focusable" aria-label={label} title={label}
      aria-describedby={summaryId} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      {mac ? <WatcherOwl size={24} /> : <SottoMark className="thread-nav__tile" />}
      {showBar ? <span className="watcher-context__bar" aria-hidden="true">
        <i data-fill={fill} style={facts.compacting ? undefined : { width: `${Math.round((facts.share ?? 0) * 100)}%` }} />
      </span> : null}
      {facts.near ? <span className="watcher-context__dot" aria-hidden="true" /> : null}
      <span id={summaryId} hidden>{summary}</span>
    </button>
    {open ? <div ref={panel} id={panelId} className="watcher-context__panel" role="dialog" aria-labelledby={headingId} tabIndex={-1}
      onBlur={event => { const next = event.relatedTarget as Node | null; if (next !== null && !event.currentTarget.contains(next) && next !== tile.current) setOpen(false) }}>
      <h2 id={headingId}><Trans>Watcher’s context</Trans></h2>
      {facts.tokens !== null ? <p className="watcher-context__figure">
        <b data-near={facts.near || undefined}>{formatTokenCount(facts.tokens)}</b>
        <span>{facts.canCompact && point !== null ? t`context, compacts at ${point}` : t({ message: 'context', comment: 'Follows a token count: how much of the model’s context Watcher uses' })}</span>
      </p> : null}
      {facts.canCompact && facts.compactAt !== null && (facts.compacting || facts.tokens !== null) ? <div className="watcher-context__meter" role="meter"
        aria-label={t`Watcher’s context`} aria-valuemin={0} aria-valuemax={facts.compactAt} aria-valuenow={facts.tokens ?? 0}
        aria-valuetext={facts.compacting ? t`Compacting` : t`${used} of ${point}`}>
        <i data-fill={fill} style={facts.compacting ? undefined : { width: `${Math.round((facts.share ?? 0) * 100)}%` }} />
      </div> : null}
      {facts.sentence !== '' ? <p className="watcher-context__said tt-paragraph">{facts.sentence}</p> : null}
      <div className="watcher-context__actions">
        <Button variant="secondary" disabled={!canPress} onClick={() => void compact()}
          title={!facts.canCompact ? (provider === null ? t`Its provider cannot compact` : t`${provider} cannot compact`) : facts.compacting ? t`Compacting now` : running ? t`Waits for Watcher’s turn to end` : undefined}>
          <Shrink size={14} aria-hidden="true" /><Trans>Compact context</Trans>
        </Button>
      </div>
      {error ? <p className="watcher-context__error tt-paragraph" role="alert">{i18n._(error)}</p> : null}
      <div className="watcher-context__state">
        <h3><Trans>Watcher’s state</Trans></h3>
        <div className="watcher-context__groups">
          <StateGroup label={t({ message: 'Watching', comment: 'The threads Watcher watches, a group of its state' })} items={watching} />
          <StateGroup label={t`Waiting on you`} items={waiting} />
          {state?.state?.unread ? <p className="watcher-context__said tt-paragraph" role="status"><Trans>Sotto could not read the decisions, rules and issues Watcher kept. Nothing kept was lost. Sotto reads them again when Watcher next asks for them.</Trans></p> : <>
            <StateGroup label={t`Decisions it noted`} items={openLines(groups.decisions)} />
            <StateGroup label={t`Your rules`} items={openLines(groups.rules)} />
            <StateGroup label={t`Issues filed`} items={openLines(groups.issues)} />
          </>}
        </div>
      </div>
    </div> : null}
  </div>
}
