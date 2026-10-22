import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { clockLabel } from '../agents/threadFacts'
import { prefersReducedMotion } from '../state/reducedMotion'
import { threadAddressIndex, type WatcherRoom } from './watcherRoom'
import type { OpenThread, OverviewEntry } from './WatcherOverview'
import { WatcherOwl } from './WatcherOwl'
import { watchedLead } from './WatcherWatched'
import { blobTag, buildPicture, edgePath, edgePoints, layoutPicture, nodeActivity, pictureMessages, PICTURE_CHIP_MIN, type BlobKind, type MergeStep,
  type PictureLayout, type PictureMergeTurns, type PictureMessage, type PictureModel, type PictureNode, type PictureSeen } from './constellation'
import './watcherPicture.css'

/** The picture takes the window's state at most this often, so a thread streaming never redraws it per update. */
const SAMPLE_MS = 250
/** Main's merge turns are read when what they depend on changes, but no oftener than this, and this often regardless. */
const MERGE_READ_GAP_MS = 3_000
const MERGE_READ_EVERY_MS = 30_000
/** How long a send waits for main to say whether it gave a merge turn before it moves as a check-in. */
const SEND_HOLD_MS = 800
const BLOB_MS = 1_100
const LIT_MS = 1_800
const MARK_MS = 4_000
const CARD_WIDTH = 320

/** The latest value, at most once per `ms`: the picture's inputs change with every streamed update, and it need not. */
function useSampled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value
  const last = useRef(0)
  useEffect(() => {
    if (Object.is(value, shown)) return
    const timer = window.setTimeout(() => { last.current = Date.now(); setShown(latest.current) }, Math.max(0, last.current + ms - Date.now()))
    return () => window.clearTimeout(timer)
  }, [value, shown, ms])
  return shown
}

/** What the merge turns depend on: the newest send, and each watched thread's pull request facts. */
function mergeSignature(room: WatcherRoomState): string {
  const last = room.receipts.at(-1)
  return JSON.stringify([room.receipts.length, last?.id, last?.deliveryState,
    room.watchedThreads.map(row => { const facts = row.evidence ?? []; return [facts.length, facts.at(-1)?.observedAt] })])
}

/**
 * Main's merge queue and merge turns, read only while the picture shows (#1339): at once, again when a send or a pull
 * request's facts change, at most every three seconds, and every thirty regardless. `now` reads at once, for a send that
 * waits to be told whether it was a merge turn.
 */
function useMergeTurns(read: WatcherRoom['readMergeTurns'], room: WatcherRoomState | null): { readonly merge: PictureMergeTurns | null; readonly now: () => void } {
  const [merge, setMerge] = useState<PictureMergeTurns | null>(null)
  const last = useRef(0)
  const live = useRef(true)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const run = useCallback(() => {
    if (read === null) return
    last.current = Date.now()
    void read().then(result => { if (live.current && result.status === 'ok') setMerge({ queue: result.queue, turns: result.turns }) }, () => undefined)
  }, [read])
  // The signature stands for the room here: a change elsewhere in it does not read again.
  const signature = room === null ? null : mergeSignature(room)
  useEffect(() => {
    if (read === null || signature === null) return
    const timer = window.setTimeout(run, Math.max(0, last.current + MERGE_READ_GAP_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [signature, run, read])
  useEffect(() => {
    if (read === null) return
    const timer = window.setInterval(run, MERGE_READ_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [run, read])
  return { merge, now: run }
}

/** The picture's own size, for laying it out; it lays out again when the room or the pane beside it changes size. */
function useSize(element: React.RefObject<HTMLElement | null>): { readonly width: number; readonly height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const target = element.current
    if (target === null) return
    const measure = (): void => setSize(current => current.width === target.clientWidth && current.height === target.clientHeight ? current : { width: target.clientWidth, height: target.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(target)
    return () => observer.disconnect()
  }, [element])
  return size
}

const STEP_WORDS: Readonly<Record<MergeStep, string>> = { ready: 'READY TO MERGE', go: 'GO MERGE', merged: 'MERGED' }
const STEP_SHORT: Readonly<Record<MergeStep, string>> = { ready: 'READY', go: 'GO', merged: 'merged' }
const CHECKS_WORDS = { passed: 'checks passed', failed: 'checks failed', pending: 'checks running', unknown: 'checks unknown' } as const

/** A thread's pull request as a chip: its number, its checks as a dot, and its merge turn. */
function PullRequestChip({ node }: { readonly node: PictureNode }): ReactNode {
  const pr = node.pullRequest
  if (pr === null) return null
  return <span className="watcher-picture__pr" data-checks={pr.checks} data-step={pr.step ?? undefined} data-state={pr.state} aria-hidden="true">
    <i />#{pr.number}{pr.step === null ? null : <b>{STEP_SHORT[pr.step]}</b>}
  </span>
}

/** What a node's button says: the thread, where it stands, its pull request, then what a press does. */
function nodeLabel(node: PictureNode): string {
  const pr = node.pullRequest
  const prWords = pr === null ? '' : `, pull request #${pr.number}${pr.step === null ? pr.checks === undefined ? '' : `, ${CHECKS_WORDS[pr.checks]}` : `, ${STEP_WORDS[pr.step]}`}`
  return `${node.title}: ${node.word}${prWords}${node.settled ? ', settled' : ''}. Show details`
}

/** One line for each thread: its ring, its title and its pull request, its dot facing Watcher. */
function Node({ node, x, y, width, mirror, open, onPress }: { readonly node: PictureNode; readonly x: number; readonly y: number; readonly width: number; readonly mirror: boolean
  readonly open: boolean; readonly onPress: (key: string, from: HTMLElement) => void }): ReactNode {
  return <button type="button" className="watcher-picture__node tt-focusable" data-mirror={mirror || undefined} data-settled={node.settled || undefined} data-tone={node.tone}
    style={{ left: x, top: y, '--node-width': `${Math.max(80, width)}px` } as CSSProperties} aria-label={nodeLabel(node)} aria-haspopup="dialog" aria-expanded={open}
    title={`${node.title} · ${node.word}`} onClick={event => onPress(node.key, event.currentTarget)}>
    <span className="watcher-row__ring" data-tone={node.ring} aria-hidden="true" />
    <span className="watcher-picture__title">{node.title}</span>
    {width >= PICTURE_CHIP_MIN ? <PullRequestChip node={node} /> : null}
  </button>
}

/**
 * A thread's detail card, beside its dot: where it stands, its pull request and merge turn, what it waits on the user
 * for, and what Watcher last did with it from Sotto's own receipts, with the words when the window holds them. Open
 * beside Watcher shows the thread itself; Open to answer goes to its waiting card.
 */
function DetailCard({ node, room, state, goes, layout, onClose, onOpen, from }: { readonly node: PictureNode; readonly room: WatcherRoomState; readonly state: AgentState
  readonly goes: ReadonlySet<string>; readonly layout: PictureLayout; readonly onClose: (refocus: boolean) => void; readonly onOpen: OpenThread; readonly from: HTMLElement | null }): ReactNode {
  const card = useRef<HTMLDivElement>(null)
  useEffect(() => { card.current?.querySelector<HTMLElement>('button')?.focus() }, [node.key])
  const at = layout.at.get(node.key)
  const thread = node.threadId === null ? undefined : state.host.threads.find(item => item.id === node.threadId)
  const activity = useMemo(() => nodeActivity(room, node.key, goes), [room, node.key, goes])
  const words = (id: string | undefined): string | null => {
    const text = id === undefined ? undefined : thread?.messages.find(message => message.id === id)?.text
    const line = text?.split('\n').find(part => part.trim() !== '')?.trim()
    return line === undefined ? null : line.length > 140 ? `${line.slice(0, 139)}…` : line
  }
  const asks = node.waits === 'question' || node.waits === 'permission' ? thread?.requests[0]?.text.split('\n').find(line => line.trim() !== '')?.trim() : undefined
  if (at === undefined) return null
  const left = layout.oneColumn ? Math.min(Math.max(8, at.x - 12), layout.width - CARD_WIDTH - 8)
    : at.mirror ? Math.min(at.x + 16, layout.width - CARD_WIDTH - 8) : Math.max(8, at.x - 16 - CARD_WIDTH)
  const top = layout.oneColumn ? at.y + 16 : Math.max(8, Math.min(at.y - 24, layout.height - 320))
  const pr = node.pullRequest
  return <div ref={card} className="watcher-picture__card" role="dialog" aria-label={`${node.title}, details`} style={{ left, top, width: CARD_WIDTH }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(true) } }}>
    <div className="watcher-picture__card-head">
      <span className="watcher-row__ring" data-tone={node.ring} aria-hidden="true" />
      <h3>{node.title}</h3>
      <button type="button" className="watcher-picture__close tt-focusable" aria-label="Close details" onClick={() => onClose(true)}><X size={14} aria-hidden="true" /></button>
    </div>
    <p className="watcher-picture__card-where">{[node.provider, node.project, node.computer].filter(Boolean).join(' · ')}
      {' · '}<span className="watcher-row__status" data-tone={node.tone}>{node.word}</span></p>
    {pr === null ? null : <p className="watcher-picture__card-pr">
      <PullRequestChip node={node} />
      <span>Pull request #{pr.number}{pr.state === 'open' && pr.checks !== undefined ? `, ${CHECKS_WORDS[pr.checks]}` : pr.state === 'merged' ? ', merged' : ''}
        {pr.step === 'go' ? '. Its turn to merge.' : pr.step === 'ready' ? '. Ready to merge, waiting for its turn.' : ''}</span>
    </p>}
    {asks ? <p className="watcher-picture__card-asks">{node.waits === 'permission' ? 'Asks permission: ' : 'Asks: '}{asks}</p> : null}
    {activity.length ? <ol className="watcher-picture__card-did" aria-label="What Watcher last did with it">
      {activity.map(item => {
        const sent = words(item.messageId), reply = words(item.replyMessageId)
        return <li key={item.id}>
          <span><b>{item.did}</b>, {item.went.toLowerCase()}{sent ? <span className="watcher-picture__words">“{sent}”</span> : null}
            {reply ? <span className="watcher-picture__words">Reply: “{reply}”</span> : null}</span>
          <time>{clockLabel(item.at)}</time>
        </li>
      })}
    </ol> : <p className="watcher-picture__card-none">Watcher has sent it nothing yet.</p>}
    {node.threadId === null ? <p className="watcher-picture__card-none">This window does not list this thread.</p>
      : <div className="watcher-picture__card-actions">
        {node.waits !== null ? <button type="button" className="watcher-answer tt-focusable" onClick={() => { onClose(false); onOpen(node.threadId!, { atRequest: true, from }) }}>
          {node.waits === 'failed' ? 'Open' : 'Open to answer'}</button> : null}
        <button type="button" className="watched-card__stop tt-focusable" onClick={() => { onClose(false); onOpen(node.threadId!, { from }) }}>Open beside Watcher</button>
      </div>}
  </div>
}

const SHAPE: Readonly<Record<BlobKind, string>> = { start: 'start', steer: 'steer', go: 'go', reply: 'reply', news: 'news', ready: 'ready', merged: 'merged', card: 'card' }

/**
 * Watcher's picture (#1339, Zach's pick on October 22, 2026: A, the constellation), the Visualize tab: Watcher in the
 * middle, the threads it watches around it in clusters by project and computer, one line each with its dot facing
 * Watcher, and a line from Watcher to each. Messages move along the lines as they happen: what Watcher sends, what a
 * thread answers or has as news, a question or permission going to You, and a pull request joining the merge queue or
 * merging. Merge turns run along the top. With reduced motion nothing travels: the line lights and a still mark appears
 * beside the thread's dot. Live only; history and replay are #1340.
 */
export function WatcherPicture({ room, state, entries, id, labelledBy, onOpen }: {
  readonly room: WatcherRoom
  readonly state: AgentState
  readonly entries: ReadonlyMap<string, OverviewEntry>
  readonly id: string
  /** The Visualize tab, which names this panel. */
  readonly labelledBy: string
  readonly onOpen: OpenThread
}): ReactNode {
  const roomState = useSampled(room.state, SAMPLE_MS)
  const agents = useSampled(state, SAMPLE_MS)
  const known = useSampled(entries, SAMPLE_MS)
  const [showSettled, setShowSettled] = useState(false)
  const { merge, now: readNow } = useMergeTurns(room.readMergeTurns, roomState)
  const idOf = useMemo(() => threadAddressIndex(agents), [agents])
  const model = useMemo<PictureModel | null>(() => roomState === null ? null
    : buildPicture({ room: roomState, state: agents, entries: known, idOf, merge, showSettled }), [roomState, agents, known, idOf, merge, showSettled])
  const goes = useMemo<ReadonlySet<string>>(() => new Set(merge?.turns.map(turn => turn.operationId) ?? []), [merge])
  const scroller = useRef<HTMLDivElement>(null)
  const size = useSize(scroller)
  const layout = useMemo(() => model === null || size.width === 0 ? null : layoutPicture(model.clusters, size.width, size.height), [model, size.width, size.height])
  const [open, setOpen] = useState<{ readonly key: string; readonly from: HTMLElement | null } | null>(null)
  const opened = open === null ? undefined : model?.nodes.get(open.key)
  const shownOpen = opened !== undefined && layout?.at.has(opened.key) ? opened : undefined

  // The messages that moved since the picture last looked go off as blobs. A send waits a moment to be told whether it
  // was a merge turn, since the receipt can reach the window before main's read of the merge turns does.
  const blobs = useRef<HTMLDivElement>(null)
  const edges = useRef(new Map<string, SVGPathElement>())
  const placed = useRef<{ layout: PictureLayout | null; model: PictureModel | null; goes: ReadonlySet<string> }>({ layout: null, model: null, goes })
  placed.current = { layout, model, goes }
  const seen = useRef<PictureSeen | null>(null)
  const held = useRef<{ message: PictureMessage; until: number }[]>([])
  const play = useCallback((message: PictureMessage) => {
    const { layout: where, model: picture } = placed.current
    const layer = blobs.current, at = where?.at.get(message.key)
    if (where == null || layer === null || at === undefined) return
    const edge = edges.current.get(message.key)
    const reduced = prefersReducedMotion()
    if (edge !== undefined) {
      edge.dataset.lit = 'true'
      window.setTimeout(() => { delete edge.dataset.lit }, reduced ? MARK_MS : LIT_MS)
    }
    const shape = document.createElement('span')
    shape.className = 'watcher-picture__shape'
    shape.dataset.kind = SHAPE[message.kind]
    if (reduced) {
      // Nothing travels: a still mark beside the dot on Watcher's side, or beside You, never over a title.
      const mark = document.createElement('span')
      mark.className = 'watcher-picture__mark'
      mark.append(shape)
      const x = message.direction === 'you' ? where.you.x + 70 : at.mirror ? at.x + 10 : at.x - 22
      const y = message.direction === 'you' ? where.you.y - 6 : at.y - 6
      mark.style.transform = `translate(${x}px, ${y}px)`
      layer.append(mark)
      window.setTimeout(() => mark.remove(), MARK_MS)
      return
    }
    const blob = document.createElement('span')
    blob.className = 'watcher-picture__blob'
    blob.append(shape)
    const tag = blobTag(message, picture?.nodes.get(message.key)?.waits)
    if (tag !== null) {
      const label = document.createElement('span')
      label.className = 'watcher-picture__tag'
      label.dataset.kind = message.kind
      label.textContent = tag
      blob.append(label)
    }
    const points = message.direction === 'out' ? edgePoints(where.owl, at, where.oneColumn)
      : message.direction === 'in' ? edgePoints(where.owl, at, where.oneColumn).reverse() : edgePoints(at, where.you, true)
    layer.append(blob)
    if (typeof blob.animate !== 'function') { blob.remove(); return }
    const travel = blob.animate(points.map(point => ({ transform: `translate(${point.x - 6}px, ${point.y - 6}px)` })), { duration: BLOB_MS, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'forwards' })
    travel.onfinish = () => { const fade = blob.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, delay: 250, fill: 'forwards' }); fade.onfinish = () => blob.remove() }
  }, [])
  const release = useCallback((force: boolean) => {
    const goesNow = placed.current.goes, ready: PictureMessage[] = []
    held.current = held.current.filter(item => {
      const go = item.message.operationId !== undefined && goesNow.has(item.message.operationId)
      if (!go && !force && Date.now() < item.until) return true
      ready.push(go ? { ...item.message, kind: 'go', pullRequest: placed.current.model?.nodes.get(item.message.key)?.pullRequest?.number } : item.message)
      return false
    })
    for (const message of ready) play(message)
  }, [play])
  useEffect(() => {
    if (roomState === null || model === null || layout === null) return
    const result = pictureMessages(seen.current, roomState, model, goes, merge !== null || room.readMergeTurns === null)
    seen.current = result.seen
    let waiting = false
    for (const message of result.messages) {
      if (message.kind === 'steer' && room.readMergeTurns !== null) { held.current.push({ message, until: Date.now() + SEND_HOLD_MS }); waiting = true }
      else play(message)
    }
    if (waiting) readNow()
    // Whatever still waits goes when its hold ends, however often the picture changes meanwhile.
    if (held.current.length === 0) return
    const timer = window.setTimeout(() => release(false), Math.max(0, Math.min(...held.current.map(item => item.until)) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [roomState, model, layout, goes, merge, play, release, readNow, room.readMergeTurns])
  // A merge read that answers while sends wait lets the merge turns among them go at once.
  useEffect(() => { release(false) }, [goes, release])
  // A new layout moves every thread: what is moving or standing still for the old one goes.
  useEffect(() => { blobs.current?.replaceChildren() }, [layout?.width, layout?.height, layout?.oneColumn])

  const closeCard = useCallback((refocus: boolean) => {
    const back = open?.from ?? null
    setOpen(null)
    if (refocus && back?.isConnected) back.focus()
  }, [open])
  const press = useCallback((key: string, from: HTMLElement) => setOpen(current => current?.key === key ? null : { key, from }), [])
  // A merge turn's chip opens that thread's card, its node brought into view.
  const pressTurn = (key: string, chip: HTMLElement): void => {
    const node = [...scroller.current?.querySelectorAll<HTMLElement>('[data-node-key]') ?? []].find(slot => slot.dataset.nodeKey === key)
      ?.querySelector<HTMLElement>('button') ?? null
    node?.scrollIntoView?.({ block: 'nearest' })
    setOpen({ key, from: node ?? chip })
  }

  if (roomState === null || model === null) return <div id={id} className="thread-workspace__transcript watcher-picture" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0} />
  const total = model.nodes.size
  return <div id={id} className="thread-workspace__transcript watcher-picture" role="tabpanel" aria-labelledby={labelledBy}>
    <div className="watcher-picture__bar">
      <span className="watcher-picture__bar-label" id={`${id}-turns`}>Merge turns</span>
      {model.turns.length ? <ol className="watcher-picture__turns" aria-labelledby={`${id}-turns`}>
        {model.turns.map((turn, index) => <li key={`${turn.key}#${turn.number}:${turn.step}`}>
          {index > 0 ? <span className="watcher-picture__then" aria-hidden="true">›</span> : null}
          <button type="button" className="watcher-picture__turn tt-focusable" data-step={turn.step} aria-label={`#${turn.number} ${STEP_WORDS[turn.step]}, ${turn.title}. Show details`}
            title={turn.title} onClick={event => pressTurn(turn.key, event.currentTarget)}>
            #{turn.number} <b>{STEP_WORDS[turn.step]}</b>
          </button>
        </li>)}
      </ol> : <span className="watcher-picture__bar-none">No pull request is ready to merge.</span>}
      {model.settled > 0 ? <button type="button" className="watcher-picture__settled tt-focusable" aria-pressed={showSettled} onClick={() => setShowSettled(value => !value)}>
        {showSettled ? 'Hide settled' : `Show ${model.settled} settled`}</button> : null}
    </div>
    <div ref={scroller} className="watcher-picture__canvas" onPointerDown={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('watcher-picture__space')) setOpen(null) }}>
      {total === 0 ? <p className="watcher-picture__empty">{watchedLead(0, 0)}</p> : layout === null ? null : <div className="watcher-picture__space" style={{ height: layout.height }}>
        <svg className="watcher-picture__lines" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.clusters.map(cluster => <rect key={cluster.key} className="watcher-picture__hull" x={cluster.x - 4} y={cluster.y} width={cluster.width + 8} height={cluster.height} rx={12} />)}
          {layout.clusters.flatMap(cluster => cluster.nodes.map(node => <path key={node.key} ref={element => { if (element) edges.current.set(node.key, element); else edges.current.delete(node.key) }}
            className="watcher-picture__edge" data-tone={model.nodes.get(node.key)?.tone} d={edgePath(layout.owl, node, layout.oneColumn)} />))}
        </svg>
        {layout.clusters.map(cluster => {
          const found = model.clusters.find(item => item.key === cluster.key)!
          return <section key={cluster.key} className="watcher-picture__cluster" aria-label={`${found.project}${found.computer ? ` on ${found.computer}` : ''}, ${found.nodes.length} ${found.nodes.length === 1 ? 'thread' : 'threads'}`}>
            <h3 className="watcher-picture__cluster-name" data-mirror={cluster.mirror || undefined} aria-hidden="true"
              style={cluster.mirror ? { right: layout.width - cluster.x - cluster.width, top: cluster.y + 6 } : { left: cluster.x + 4, top: cluster.y + 6 }}>
              <b>{found.project}</b>{found.computer ? ` · ${found.computer}` : ''}
            </h3>
            {cluster.nodes.map(placedNode => {
              const node = model.nodes.get(placedNode.key)!
              return <div key={node.key} data-node-key={node.key} className="watcher-picture__node-slot">
                <Node node={node} x={placedNode.x} y={placedNode.y} width={placedNode.width} mirror={placedNode.mirror} open={open?.key === node.key} onPress={press} />
              </div>
            })}
          </section>
        })}
        <div className="watcher-picture__owl" style={{ left: layout.owl.x, top: layout.owl.y }} aria-hidden="true"><WatcherOwl size={26} /></div>
        <p className="watcher-picture__owl-name" style={{ left: layout.owl.x, top: layout.owl.y + 32 }}>
          Watcher{model.working ? <span> · {model.working} working</span> : null}
        </p>
        <p className="watcher-picture__you" style={{ left: layout.you.x, top: layout.you.y }}>
          You{model.waiting ? <b> · {model.waiting} waiting</b> : <span> · nothing waiting</span>}
        </p>
        <div ref={blobs} className="watcher-picture__blobs" aria-hidden="true" />
        {shownOpen !== undefined ? <DetailCard node={shownOpen} room={roomState} state={agents} goes={goes} layout={layout} onClose={closeCard} onOpen={onOpen} from={open?.from ?? null} /> : null}
      </div>}
    </div>
  </div>
}
