import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { AgentState } from '../../../shared/agents'
import type { WatcherRoomState } from '../../../shared/watcherRoom'
import { clockLabel } from '../agents/threadFacts'
import { prefersReducedMotion, useReducedMotion } from '../state/reducedMotion'
import { sceneInk } from './nightScene'
import { layoutGrove, type GroveCluster, type GroveLayout, type GroveOwl } from './pictureGrove'
import { GrovePainter, type GroveOwlFrame } from './pictureGrovePainter'
import { threadAddressIndex, type WatcherRoom } from './watcherRoom'
import { surfaceOf, toRgb } from './WatcherNightScene'
import type { OpenThread, OverviewEntry } from './WatcherOverview'
import { WatcherOwl } from './WatcherOwl'
import { watchedLead } from './WatcherWatched'
import { watchResolution } from './watchResolution'
import { blobTag, buildPicture, edgePoints, nodeActivity, pictureMessages, type BlobKind, type MergeStep,
  type PictureMergeTurns, type PictureMessage, type PictureModel, type PictureNode, type PicturePullRequest, type PictureSeen } from './constellation'
import type { OwlMood } from './owlFamily'
import './nightScene.css'
import './watcherPicture.css'

/** The picture takes the window's state at most this often, so a thread streaming never redraws it per update. */
const SAMPLE_MS = 250
/** Main's merge turns are read when what they depend on changes, but no oftener than this, and this often regardless. */
const MERGE_READ_GAP_MS = 3_000
const MERGE_READ_EVERY_MS = 30_000
/**
 * The longest a send waits to be told whether it gave a merge turn before it moves as a check-in: the next read main may
 * be asked for, and a second for its answer. It goes sooner once a read asked after it was seen has answered.
 */
const SEND_HOLD_MS = MERGE_READ_GAP_MS + 1_000
const BLOB_MS = 1_100
const LIT_MS = 1_800
const MARK_MS = 4_000
const CARD_WIDTH = 320
/** A card's tallest (watcherPicture.css). */
const CARD_TALLEST = 420
/** While anything in the picture blinks, twinkles or glows, it checks this often and paints only what changed. */
const SCENE_CHECK_MS = 125

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

/** Main's merge turns, and when the read that brought them was asked for. */
interface MergeRead { readonly turns: PictureMergeTurns; readonly askedAt: number }

/**
 * Main's merge queue and merge turns, read only while the picture shows (#1339): at once, again when a send or a pull
 * request's facts change, and every thirty seconds regardless, never oftener than every three seconds. `ask` asks for the
 * next read within that limit, for a send that waits to be told whether it was a merge turn.
 */
function useMergeTurns(read: WatcherRoom['readMergeTurns'], room: WatcherRoomState | null): { readonly merge: MergeRead | null; readonly ask: () => void } {
  const [merge, setMerge] = useState<MergeRead | null>(null)
  const last = useRef(-Infinity)
  const pending = useRef<number | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false; if (pending.current !== null) window.clearTimeout(pending.current) }
  }, [])
  const ask = useCallback(() => {
    if (read === null || pending.current !== null) return
    pending.current = window.setTimeout(() => {
      pending.current = null
      const askedAt = last.current = Date.now()
      void read().then(result => { if (live.current && result.status === 'ok') setMerge({ turns: { queue: result.queue, turns: result.turns }, askedAt }) }, () => undefined)
    }, Math.max(0, last.current + MERGE_READ_GAP_MS - Date.now()))
  }, [read])
  // The signature stands for the room here: a change elsewhere in it does not read again.
  const signature = useMemo(() => room === null ? null : mergeSignature(room), [room])
  useEffect(() => { if (signature !== null) ask() }, [signature, ask])
  useEffect(() => {
    if (read === null) return
    const timer = window.setInterval(ask, MERGE_READ_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [ask, read])
  return { merge, ask }
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

/** A pull request as a chip: its number, its checks as a dot, and its merge turn unless `compact`. */
function PullRequestChip({ pr, compact = false }: { readonly pr: PicturePullRequest; readonly compact?: boolean }): ReactNode {
  return <span className="watcher-picture__pr" data-checks={pr.checks} data-step={pr.step ?? undefined} data-state={pr.state} aria-hidden="true">
    <i />#{pr.number}{pr.step === null || compact ? null : <b>{STEP_SHORT[pr.step]}</b>}
  </span>
}
/** A label narrower than this leaves a pull request's merge turn to the merge turns along the top and its card. */
const CHIP_STEP_MIN = 128

/** A pull request in a card's words. */
function pullRequestWords(pr: PicturePullRequest): string {
  const state = pr.state === 'merged' ? ', merged' : pr.state === 'closed' ? ', closed' : pr.checks === undefined ? '' : `, ${CHECKS_WORDS[pr.checks]}`
  const turn = pr.step === 'go' ? '. Its turn to merge.' : pr.step === 'ready' ? '. Ready to merge, waiting for its turn.' : ''
  return `Pull request #${pr.number}${state}${turn}`
}

/** What a node's button says: the thread, where it stands, its pull request, then what a press does. */
function nodeLabel(node: PictureNode): string {
  const pr = node.pullRequest
  const prWords = pr === null ? '' : `, pull request #${pr.number}${pr.step === null ? pr.checks === undefined ? '' : `, ${CHECKS_WORDS[pr.checks]}` : `, ${STEP_WORDS[pr.step]}`}`
  return `${node.title}: ${node.word}${prWords}${node.settled ? ', settled' : ''}. Show details`
}

/** A thread's owl, as its button: the owl on its limb, its name and where it stands under it, and its pull request. */
function Node({ node, at, open, onPress }: { readonly node: PictureNode; readonly at: GroveOwl; readonly open: boolean
  readonly onPress: (key: string, from: HTMLElement) => void }): ReactNode {
  return <button type="button" className="watcher-picture__node tt-focusable" data-settled={node.settled || undefined} data-tone={node.tone}
    style={{ left: at.box.x, top: at.box.y, width: at.box.w, height: at.box.h, paddingTop: at.label.y - at.box.y } as CSSProperties}
    aria-label={nodeLabel(node)} aria-haspopup="dialog" aria-expanded={open} title={`${node.title} · ${node.word}`} onClick={event => onPress(node.key, event.currentTarget)}>
    <span className="watcher-picture__label">
      <span className="watcher-picture__title">{node.title}</span>
      <span className="watcher-picture__state">
        <span className="watcher-row__ring" data-tone={node.ring} aria-hidden="true" />
        <span className="watcher-picture__word" data-tone={node.tone}>{node.word}</span>
        {node.pullRequest !== null ? <PullRequestChip pr={node.pullRequest} compact={at.label.w < CHIP_STEP_MIN} /> : null}
      </span>
    </span>
  </button>
}

/** How a thread's owl looks: glowing while a question, a permission or a prototype waits on the user, awake while it works. */
function moodOfNode(node: PictureNode): OwlMood {
  if (node.waits !== null && node.waits !== 'failed') return 'waiting'
  return !node.settled && (node.tone === 'working' || node.tone === 'landing') ? 'awake' : 'asleep'
}

/**
 * A thread's detail card, beside its dot: where it stands, its pull requests and merge turns, what it waits on the user
 * for, and what Watcher last did with it from Sotto's own receipts, with the words when the window holds them. Open
 * beside Watcher shows the thread itself; Open to answer goes to its waiting card.
 */
function DetailCard({ node, room, state, goes, layout, onClose, onOpen, from }: { readonly node: PictureNode; readonly room: WatcherRoomState; readonly state: AgentState
  readonly goes: ReadonlyMap<string, number>; readonly layout: GroveLayout; readonly onClose: (refocus: boolean) => void; readonly onOpen: OpenThread; readonly from: HTMLElement | null }): ReactNode {
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
  // Beside the thread's owl, on the side with more room; under it when neither side has room for the card.
  const right = at.box.x + at.box.w + 8, left0 = at.box.x - 8 - CARD_WIDTH
  const beside = right + CARD_WIDTH <= layout.width - 8 ? right : left0 >= 8 ? left0 : null
  const left = beside ?? Math.min(Math.max(8, at.x - CARD_WIDTH / 2), layout.width - CARD_WIDTH - 8)
  // A card that runs past the picture's foot makes the picture scroll, so its actions are always within reach.
  const top = beside === null ? at.box.y + at.box.h + 6 : Math.max(8, Math.min(at.box.y - 8, layout.height - CARD_TALLEST - 8))
  return <div ref={card} className="watcher-picture__card" role="dialog" aria-label={`${node.title}, details`} style={{ left, top, width: CARD_WIDTH }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(true) } }}>
    <div className="watcher-picture__card-head">
      <span className="watcher-row__ring" data-tone={node.ring} aria-hidden="true" />
      <h3>{node.title}</h3>
      <button type="button" className="watcher-picture__close tt-focusable" aria-label="Close details" onClick={() => onClose(true)}><X size={14} aria-hidden="true" /></button>
    </div>
    <p className="watcher-picture__card-where">{[node.provider, node.project, node.computer].filter(Boolean).join(' · ')}
      {' · '}<span className="watcher-row__status" data-tone={node.tone}>{node.word}</span></p>
    {node.pullRequests.length ? <ul className="watcher-picture__card-prs" aria-label="Its pull requests">
      {node.pullRequests.map(pr => <li key={pr.id}><PullRequestChip pr={pr} /><span>{pullRequestWords(pr)}</span></li>)}
    </ul> : null}
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
          {node.waits === 'failed' || node.waits === 'prototype' ? 'Open' : 'Open to answer'}</button> : null}
        <button type="button" className="watched-card__stop tt-focusable" onClick={() => { onClose(false); onOpen(node.threadId!, { from }) }}>Open beside Watcher</button>
      </div>}
  </div>
}

/**
 * The picture's night: the landscape, the trees, the moon and every owl, on two canvases under the words, drawn as the
 * room's margins are (Zach's pick on October 22, 2026, B of `prototype/watcher-visualize-owls`). Owls perch: a working
 * one blinks, one waiting on the user glows, and Watcher's own owl blinks on its post. It checks eight times a second
 * while anything could change and paints only when something did; with motion reduced, or the window hidden, it holds
 * still. The canvases are decoration: each owl's button is the thread's own, over it.
 */
function GroveScene({ layout, model }: { readonly layout: GroveLayout; readonly model: PictureModel }): ReactNode {
  const back = useRef<HTMLCanvasElement>(null)
  const front = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLElement>(null)
  const painter = useRef<GrovePainter | null>(null)
  const wake = useRef<() => void>(() => undefined)
  const reduced = useReducedMotion()
  const owls = useMemo<GroveOwlFrame[]>(() => {
    const out: GroveOwlFrame[] = []
    for (const cluster of model.clusters) for (const node of cluster.nodes) {
      const at = layout.at.get(node.key)
      if (at !== undefined) out.push({ key: node.key, x: at.x, y: at.y, mood: moodOfNode(node), settled: node.settled, order: out.length })
    }
    return out
  }, [layout, model])
  const owlsRef = useRef(owls)
  owlsRef.current = owls
  const stillRef = useRef(reduced)
  stillRef.current = reduced
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const resizeRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const land = back.current, owl = front.current, ink = probe.current, holder = land?.parentElement
    // Without layout (a test's DOM) there is nothing to draw on.
    if (land == null || owl == null || ink == null || holder == null || typeof ResizeObserver === 'undefined') return
    const pixelCanvas = document.createElement('canvas')
    pixelCanvas.width = 1; pixelCanvas.height = 1
    const pixel = pixelCanvas.getContext('2d', { willReadFrequently: true })
    if (pixel === null) return
    const scene = painter.current = new GrovePainter(land, owl)
    const origin = performance.now()
    let timer: number | null = null
    let disposed = false
    let inked = ''
    const frame = (): void => {
      timer = null
      if (disposed || document.visibilityState === 'hidden' || !scene.ready) return
      scene.draw((performance.now() - origin) / 1000, stillRef.current, owlsRef.current)
      if (!stillRef.current) timer = window.setTimeout(frame, SCENE_CHECK_MS)
    }
    wake.current = () => { if (timer !== null) window.clearTimeout(timer); frame() }
    const readInk = (): void => {
      const style = getComputedStyle(ink)
      const text = toRgb(style.color, pixel), accent = toRgb(style.backgroundColor, pixel), surface = surfaceOf(holder, pixel)
      if (text === null || accent === null || surface === null) return
      const key = JSON.stringify([text, accent, surface, style.fontFamily])
      if (key === inked) return
      inked = key
      scene.setInk(sceneInk(surface, text, accent), style.fontFamily)
      wake.current()
    }
    const resize = (): void => { scene.resize(layoutRef.current, window.devicePixelRatio || 1); inked = ''; readInk(); wake.current() }
    resize()
    const theme = new MutationObserver(readInk)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'data-theme-id'] })
    const visibility = (): void => { if (document.visibilityState !== 'hidden') wake.current() }
    document.addEventListener('visibilitychange', visibility)
    const unwatchResolution = watchResolution(resize)
    void document.fonts?.load(`10.5px ${getComputedStyle(ink).fontFamily}`).then(() => { if (!disposed) { inked = ''; readInk() } }, () => undefined)
    resizeRef.current = resize
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      theme.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      unwatchResolution()
      wake.current = () => undefined
      resizeRef.current = () => undefined
      painter.current = null
    }
  }, [])
  // Each new layout builds the landscape again; the first is built as the scene starts.
  const first = useRef(true)
  useEffect(() => { if (first.current) { first.current = false; return } resizeRef.current() }, [layout])
  useEffect(() => { wake.current() }, [owls, reduced])

  return <>
    <canvas ref={back} className="watcher-picture__scene" style={{ width: layout.width, height: layout.height }} aria-hidden="true" />
    <canvas ref={front} className="watcher-picture__scene" style={{ width: layout.width, height: layout.height }} aria-hidden="true" />
    <i ref={probe} className="watcher-scene__ink" aria-hidden="true" />
  </>
}

const SHAPE: Readonly<Record<BlobKind, string>> = { start: 'start', steer: 'steer', go: 'go', reply: 'reply', news: 'news', ready: 'ready', merged: 'merged', card: 'card' }

/** A send held back until main says whether it gave a merge turn: when it was seen, and when it goes regardless. */
interface HeldSend { readonly message: PictureMessage; readonly seenAt: number; readonly until: number }

/**
 * The picture itself, drawn from inputs already sampled, so it draws only when they change and never with each update of
 * the room or the window that the picture does not show.
 */
const Picture = memo(function Picture({ roomState, agents, known, merge, ask, canRead, id, labelledBy, onOpen }: {
  readonly roomState: WatcherRoomState
  readonly agents: AgentState
  readonly known: ReadonlyMap<string, OverviewEntry>
  readonly merge: MergeRead | null
  readonly ask: () => void
  /** Whether main can be asked for the merge turns at all; without, a send moves at once. */
  readonly canRead: boolean
  readonly id: string
  readonly labelledBy: string
  readonly onOpen: OpenThread
}): ReactNode {
  const [showSettled, setShowSettled] = useState(false)
  const idOf = useMemo(() => threadAddressIndex(agents), [agents])
  const model = useMemo<PictureModel>(() => buildPicture({ room: roomState, state: agents, entries: known, idOf, merge: merge?.turns ?? null, showSettled }),
    [roomState, agents, known, idOf, merge, showSettled])
  // Each send Watcher marked as a merge turn, with the pull request it gave its turn to.
  const goes = useMemo<ReadonlyMap<string, number>>(() => new Map(merge?.turns.turns.map(turn => [turn.operationId, turn.pullRequest] as const) ?? []), [merge])
  const scroller = useRef<HTMLDivElement>(null)
  const size = useSize(scroller)
  // Watcher's name and You are laid out at their own widths, so nothing is set beside them that they would run into.
  const nameRef = useRef<HTMLParagraphElement>(null)
  const youRef = useRef<HTMLParagraphElement>(null)
  const [labels, setLabels] = useState({ watcher: 150, you: 150 })
  useLayoutEffect(() => {
    const watcher = nameRef.current?.offsetWidth ?? 0, you = youRef.current?.offsetWidth ?? 0
    if (watcher > 0 && you > 0 && (Math.abs(watcher - labels.watcher) > 1 || Math.abs(you - labels.you) > 1)) setLabels({ watcher, you })
  })
  // The layout depends only on which threads stand in which project on which computer, so a sample that changes nothing
  // else keeps it, and the landscape is not built again. A project's threads are named in a fixed order here, as the
  // layout stands them, so one moving up its project's list as its state changes changes nothing.
  const shape = useMemo(() => JSON.stringify(model.clusters.map(cluster => ({ key: cluster.key, project: cluster.project, computer: cluster.computer,
    nodes: cluster.nodes.map(node => node.key).sort().map(key => ({ key })) }))), [model])
  const layout = useMemo(() => size.width === 0 ? null : layoutGrove(JSON.parse(shape) as GroveCluster[], size.width, size.height, labels), [shape, size.width, size.height, labels])
  const [open, setOpen] = useState<{ readonly key: string; readonly from: HTMLElement | null } | null>(null)
  const opened = open === null ? undefined : model.nodes.get(open.key)
  const shownOpen = opened !== undefined && layout?.at.has(opened.key) ? opened : undefined

  // The messages that moved since the picture last looked go off as blobs. A send waits to be told whether it was a merge
  // turn, since its receipt can reach the window before main's read of the merge turns does.
  const blobs = useRef<HTMLDivElement>(null)
  const placed = useRef<{ layout: GroveLayout | null; model: PictureModel; goes: ReadonlyMap<string, number>; askedAt: number }>({ layout, model, goes, askedAt: merge?.askedAt ?? -Infinity })
  placed.current = { layout, model, goes, askedAt: merge?.askedAt ?? -Infinity }
  const seen = useRef<PictureSeen | null>(null)
  const held = useRef<HeldSend[]>([])
  const holdTimer = useRef<number | null>(null)
  useEffect(() => () => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current) }, [])
  const play = useCallback((message: PictureMessage) => {
    const { layout: where, model: picture } = placed.current
    const layer = blobs.current, at = where?.at.get(message.key)
    if (where == null || layer === null || at === undefined) return
    // The thread's owl lights while its message moves, or while the still mark stands.
    const node = [...scroller.current?.querySelectorAll<HTMLElement>('[data-node-key]') ?? []].find(slot => slot.dataset.nodeKey === message.key)?.querySelector<HTMLElement>('button')
    const reduced = prefersReducedMotion()
    if (node != null) {
      node.dataset.lit = 'true'
      window.setTimeout(() => { delete node.dataset.lit }, reduced ? MARK_MS : LIT_MS)
    }
    const shape = document.createElement('span')
    shape.className = 'watcher-picture__shape'
    shape.dataset.kind = SHAPE[message.kind]
    if (reduced) {
      // Nothing travels: a still mark beside the owl on Watcher's side, or beside You, never over a word.
      const mark = document.createElement('span')
      mark.className = 'watcher-picture__mark'
      mark.append(shape)
      const x = message.direction === 'you' ? where.you.x + where.you.w + 6 : at.side === 'left' ? at.owl.x + at.owl.w + 2 : at.owl.x - 14
      const y = message.direction === 'you' ? where.you.y + where.you.h / 2 - 6 : at.head.y - 6
      mark.style.transform = `translate(${x}px, ${y}px)`
      layer.append(mark)
      window.setTimeout(() => mark.remove(), MARK_MS)
      return
    }
    const blob = document.createElement('span')
    blob.className = 'watcher-picture__blob'
    blob.append(shape)
    const tag = blobTag(message, picture.nodes.get(message.key)?.waits)
    if (tag !== null) {
      const label = document.createElement('span')
      label.className = 'watcher-picture__tag'
      label.dataset.kind = message.kind
      label.textContent = tag
      blob.append(label)
    }
    const points = message.direction === 'out' ? edgePoints(where.watcherAt, at.head, !where.wide)
      : message.direction === 'in' ? edgePoints(where.watcherAt, at.head, !where.wide).reverse() : edgePoints(at.head, where.youAt, true)
    layer.append(blob)
    if (typeof blob.animate !== 'function') { blob.remove(); return }
    const travel = blob.animate(points.map(point => ({ transform: `translate(${point.x - 6}px, ${point.y - 6}px)` })), { duration: BLOB_MS, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'forwards' })
    travel.onfinish = () => { const fade = blob.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, delay: 250, fill: 'forwards' }); fade.onfinish = () => blob.remove() }
  }, [])
  // Lets go every held send that was a merge turn, that a read asked after it was seen has answered for, or whose hold has
  // run out, then waits for the next hold to run out, if any is left.
  const release = useCallback(() => {
    const { goes: goesNow, askedAt } = placed.current, now = Date.now(), ready: PictureMessage[] = []
    held.current = held.current.filter(item => {
      const go = item.message.operationId !== undefined && goesNow.has(item.message.operationId)
      if (!go && askedAt < item.seenAt && now < item.until) return true
      ready.push(go ? { ...item.message, kind: 'go', pullRequest: goesNow.get(item.message.operationId!) } : item.message)
      return false
    })
    for (const message of ready) play(message)
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = held.current.length === 0 ? null
      : window.setTimeout(release, Math.max(0, Math.min(...held.current.map(item => item.until)) - now))
  }, [play])
  useEffect(() => {
    if (layout === null) return
    const result = pictureMessages(seen.current, roomState, model, goes, merge !== null || !canRead)
    seen.current = result.seen
    const now = Date.now()
    let waiting = false
    for (const message of result.messages) {
      if (message.kind === 'steer' && canRead) { held.current.push({ message, seenAt: now, until: now + SEND_HOLD_MS }); waiting = true }
      else play(message)
    }
    if (waiting) { ask(); release() }
  }, [roomState, model, layout, goes, merge, canRead, play, release, ask])
  // A merge read that answers while sends wait lets go those it has spoken for.
  useEffect(() => { if (held.current.length) release() }, [merge, release])
  // A new layout moves every thread: what is moving or standing still for the old one goes.
  useEffect(() => { blobs.current?.replaceChildren() }, [layout?.width, layout?.height, layout?.wide])

  const closeCard = useCallback((refocus: boolean) => {
    const back = open?.from ?? null
    setOpen(null)
    if (refocus && back?.isConnected) back.focus()
  }, [open])
  const press = useCallback((key: string, from: HTMLElement) => setOpen(current => current?.key === key ? null : { key, from }), [])
  // A merge turn's chip opens that thread's card, its node brought into view; a settled thread's is shown first.
  const pressTurn = (key: string, chip: HTMLElement): void => {
    if (!layout?.at.has(key)) setShowSettled(true)
    const node = [...scroller.current?.querySelectorAll<HTMLElement>('[data-node-key]') ?? []].find(slot => slot.dataset.nodeKey === key)
      ?.querySelector<HTMLElement>('button') ?? null
    node?.scrollIntoView?.({ block: 'nearest' })
    setOpen({ key, from: node ?? chip })
  }

  const total = model.nodes.size
  return <div id={id} className="thread-workspace__transcript watcher-picture" role="tabpanel" aria-labelledby={labelledBy}>
    <div className="watcher-picture__bar">
      <span className="watcher-picture__bar-label" id={`${id}-turns`}>Merge turns</span>
      {model.turns.length ? <ol className="watcher-picture__turns" aria-labelledby={`${id}-turns`}>
        {model.turns.map((turn, index) => <li key={`${turn.key}#${turn.number}:${turn.step}`}>
          {index > 0 ? <span className="watcher-picture__then" aria-hidden="true">›</span> : null}
          <button type="button" className="watcher-picture__turn tt-focusable" data-step={turn.step} aria-label={`#${turn.number} ${STEP_WORDS[turn.step]}, ${turn.title}. Show details`}
            title={turn.title} onClick={event => pressTurn(turn.key, event.currentTarget)}
            onFocus={event => event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })}>
            #{turn.number} <b>{STEP_WORDS[turn.step]}</b>
          </button>
        </li>)}
      </ol> : <span className="watcher-picture__bar-none">No pull request is ready to merge.</span>}
      {model.settled > 0 ? <button type="button" className="watcher-picture__settled tt-focusable" aria-pressed={showSettled} onClick={() => setShowSettled(value => !value)}>
        {showSettled ? 'Hide settled' : `Show ${model.settled} settled`}</button> : null}
    </div>
    <div ref={scroller} className="watcher-picture__canvas" onPointerDown={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('watcher-picture__space')) setOpen(null) }}>
      {total === 0 ? <p className="watcher-picture__empty">{watchedLead(0, 0)}</p> : layout === null ? null : <div className="watcher-picture__space" style={{ height: layout.height }}>
        <GroveScene layout={layout} model={model} />
        {layout.trees.map(tree => <p key={`${tree.computer}:${tree.x}:${tree.y}`} className="watcher-picture__computer" aria-hidden="true"
          style={{ left: tree.pill.x, top: tree.pill.y, width: tree.pill.w }}><span>{tree.computer || 'Not in this window'}</span></p>)}
        {model.clusters.map(cluster => {
          const sign = layout.signs.find(item => item.key === cluster.key)
          return <section key={cluster.key} className="watcher-picture__cluster" aria-label={`${cluster.project}${cluster.computer ? ` on ${cluster.computer}` : ''}, ${cluster.nodes.length} ${cluster.nodes.length === 1 ? 'thread' : 'threads'}`}>
            {sign !== undefined ? <h3 className="watcher-picture__cluster-name" data-align={sign.align} aria-hidden="true" title={`${cluster.project}${cluster.computer ? ` · ${cluster.computer}` : ''}`}
              style={{ left: sign.box.x, top: sign.box.y, width: sign.box.w, maxWidth: sign.box.w }}>
              <span>{cluster.project}</span>
            </h3> : null}
            {cluster.nodes.map(node => {
              const at = layout.at.get(node.key)
              return at === undefined ? null : <div key={node.key} data-node-key={node.key} className="watcher-picture__node-slot">
                <Node node={node} at={at} open={open?.key === node.key} onPress={press} />
              </div>
            })}
          </section>
        })}
        <p ref={nameRef} className="watcher-picture__owl-name" data-wide={layout.wide || undefined} style={{ left: layout.watcherName.x, top: layout.watcherName.y }}>
          {layout.wide ? null : <WatcherOwl size={14} />}Watcher{model.working ? <span> · {model.working} working</span> : null}
        </p>
        <p ref={youRef} className="watcher-picture__you" style={{ left: layout.you.x, top: layout.you.y }}>
          You{model.waiting ? <b> · {model.waiting} waiting</b> : <span> · nothing waiting</span>}
        </p>
        <div ref={blobs} className="watcher-picture__blobs" aria-hidden="true" />
        {shownOpen !== undefined ? <DetailCard node={shownOpen} room={roomState} state={agents} goes={goes} layout={layout} onClose={closeCard} onOpen={onOpen} from={open?.from ?? null} /> : null}
      </div>}
    </div>
  </div>
})

/**
 * Watcher's picture (#1339), the Visualize tab, drawn as the night scene (Zach's pick on October 22, 2026, B of
 * `prototype/watcher-visualize-owls`, after A of `prototype/watcher-picture`, the constellation): a tree for each
 * computer, a limb for each project and an owl for each thread Watcher watches, with its name and where it stands under
 * it; Watcher's owl on its post in the middle and You at its foot. Messages fly as they happen: what Watcher sends, what a
 * thread answers or has as news, a question or permission going to You, and a pull request joining the merge queue or
 * merging. Merge turns run along the top. With reduced motion nothing travels: the thread's owl is ringed and a still
 * mark appears beside it. Live only; history and replay are #1340. This part only samples what the window holds and
 * reads the merge turns; the picture draws from the samples alone.
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
  const { merge, ask } = useMergeTurns(room.readMergeTurns, roomState)
  if (roomState === null) return <div id={id} className="thread-workspace__transcript watcher-picture" role="tabpanel" aria-labelledby={labelledBy} tabIndex={0} />
  return <Picture roomState={roomState} agents={agents} known={known} merge={merge} ask={ask} canRead={room.readMergeTurns !== null}
    id={id} labelledBy={labelledBy} onOpen={onOpen} />
}
