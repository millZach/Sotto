import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Shrink } from 'lucide-react'
import { PROVIDER_LABELS } from '../../../shared/agents'
import { formatTokenCount } from '../../../shared/threadUsage'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { Button } from '../components/Button'
import { SottoMark } from '../components/SottoMark'
import { useOptionalApp } from '../state/AppContext'
import { useAgents } from '../agents/AgentContext'
import type { WatcherRoom } from './watcherRoom'
import { WatcherOwl } from './WatcherOwl'

export const WATCHER_CONTEXT_LABEL = 'Watcher’s context and state'
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
  if (compacting) said.push('Compacting Watcher’s conversation.')
  else {
    if (tokens === null) said.push('Its provider has not reported its context yet.')
    if (!canCompact) said.push(`${provider ?? 'Its provider'} cannot compact, so each message rereads all of it.`)
    else if (point !== null) said.push(`${near ? `Close to ${point}. ` : ''}Sotto compacts Watcher’s conversation once it passes ${point}, between turns.`)
  }
  return { tokens, compactAt, canCompact, compacting, share, near, point, sentence: said.join(' ') }
}

/** One group of Watcher's state: its label, how many, and its items, or "None". */
function StateGroup({ label, items }: { readonly label: string; readonly items: readonly ReactNode[] }): ReactNode {
  return <section className="watcher-context__group">
    <h4>{items.length > 0 ? `${label}, ${items.length}` : label}</h4>
    {items.length > 0 ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="watcher-context__none">None</p>}
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
  const agents = useAgents()
  const mac = useOptionalApp()?.platform === 'darwin'
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      if (await agents.command({ type: 'compact-thread', threadId }) === null) setError('Sotto could not start compacting Watcher’s conversation. Nothing was lost. Try again.')
    } catch { setError('Sotto could not start compacting Watcher’s conversation. Nothing was lost. Try again.') }
    finally { sent.current = false; setSending(false) }
  }

  const summary = facts.compacting ? 'Compacting.'
    : facts.tokens === null ? 'Not reported yet.'
    : facts.canCompact && facts.point !== null ? `${formatTokenCount(facts.tokens)} of ${facts.point}${facts.near ? ', close to the point' : ''}.`
    : `${formatTokenCount(facts.tokens)}.`
  const showBar = facts.canCompact && (facts.compacting || facts.share !== null)
  const fill = facts.compacting ? 'busy' : facts.near ? 'near' : undefined
  const kept = state?.state
  const watching: readonly ReactNode[] = (kept?.watching ?? []).map(thread =>
    <React.Fragment key={`${thread.target.hostId}/${thread.target.threadId}`}>
      <span className="watcher-context__title">{thread.title}</span><span className="watcher-context__aside">{thread.waitsOn}</span>
    </React.Fragment>)
  const groups: RoomKept['kept'] = kept?.kept ?? { decisions: [], rules: [], issues: [], updatedAt: null }

  // Escape answers on the tile as well as in the panel: Shift+Tab back to the tile leaves the panel open.
  return <div className="watcher-context" onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
    <button ref={tile} type="button" className="watcher-head__tile watcher-context__tile tt-focusable" aria-label={WATCHER_CONTEXT_LABEL} title={WATCHER_CONTEXT_LABEL}
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
      <h2 id={headingId}>Watcher’s context</h2>
      {facts.tokens !== null ? <p className="watcher-context__figure">
        <b data-near={facts.near || undefined}>{formatTokenCount(facts.tokens)}</b>
        <span>{facts.canCompact && facts.point !== null ? `context, compacts at ${facts.point}` : 'context'}</span>
      </p> : null}
      {facts.canCompact && facts.compactAt !== null && (facts.compacting || facts.tokens !== null) ? <div className="watcher-context__meter" role="meter"
        aria-label="Watcher’s context" aria-valuemin={0} aria-valuemax={facts.compactAt} aria-valuenow={facts.tokens ?? 0}
        aria-valuetext={facts.compacting ? 'Compacting' : `${formatTokenCount(facts.tokens ?? 0)} of ${facts.point}`}>
        <i data-fill={fill} style={facts.compacting ? undefined : { width: `${Math.round((facts.share ?? 0) * 100)}%` }} />
      </div> : null}
      {facts.sentence !== '' ? <p className="watcher-context__said">{facts.sentence}</p> : null}
      <div className="watcher-context__actions">
        <Button variant="secondary" disabled={!canPress} onClick={() => void compact()}
          title={!facts.canCompact ? `${provider ?? 'Its provider'} cannot compact` : facts.compacting ? 'Compacting now' : running ? 'Waits for Watcher’s turn to end' : undefined}>
          <Shrink size={14} aria-hidden="true" />Compact context
        </Button>
      </div>
      {error ? <p className="watcher-context__error" role="alert">{error}</p> : null}
      <div className="watcher-context__state">
        <h3>Watcher’s state, kept through compaction</h3>
        <div className="watcher-context__groups">
          <StateGroup label="Watching" items={watching} />
          {state?.state?.unread ? <p className="watcher-context__said" role="status">Sotto could not read the decisions, rules and issues Watcher kept. Nothing kept was lost. Sotto reads them again when Watcher next asks for them.</p> : <>
            <StateGroup label="Waiting on you" items={groups.decisions} />
            <StateGroup label="Your rules" items={groups.rules} />
            <StateGroup label="Issues filed" items={groups.issues} />
          </>}
        </div>
      </div>
    </div> : null}
  </div>
}
