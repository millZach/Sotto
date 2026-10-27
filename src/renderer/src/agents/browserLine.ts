import { t } from '@lingui/core/macro'

import type { AgentActivity } from '../../../shared/agentActivity'
import type { AgentMessage } from '../../../shared/agents'
import { sottoBrowserToolOfTitle, type SottoBrowserTool } from '../../../shared/sottoBrowserTools'
import { activityInput, isStep, stepsLabel, type ActivityNode } from './threadActivityView'

/**
 * The browser line (ADR-0154; Owl only): a run of a turn's calls to Sotto's own browser tools, read as one line in the
 * thread instead of a row per call. Provider neutral: it reads each record's title, its input where the client reported
 * one, and else the task Sotto's browser answered with, which Codex reports as the call's output.
 */

/** Sotto's browser, or the cloud iPhone (ADR-0047), which has a line of its own. */
export type BrowserRunKind = 'browser' | 'cloud'

/** What one call did, in a word the line and its steps put into plain English. */
export type BrowserVerb =
  | 'open' | 'phone-open' | 'start' | 'navigate' | 'click' | 'type' | 'key' | 'scroll' | 'tap' | 'swipe' | 'inspect' | 'screenshot'
  | 'viewport' | 'work' | 'status' | 'pages' | 'finish'
  | 'cloud-open' | 'cloud-tap' | 'cloud-swipe' | 'cloud-type' | 'cloud-key' | 'cloud-button' | 'cloud-url' | 'cloud-inspect'
  | 'cloud-screenshot' | 'cloud-work' | 'cloud-status' | 'cloud-finish'

export interface BrowserStep {
  readonly record: AgentActivity
  readonly tool: SottoBrowserTool
  readonly kind: BrowserRunKind
  readonly verb: BrowserVerb
  /** The address a call opened or went to; only these name the line's host. */
  readonly url?: string | undefined
  /** The key or hardware button a call pressed, as the tool names it (Enter, Home). */
  readonly key?: string | undefined
  readonly failed: boolean
}

type Frame = Record<string, unknown>
const frame = (value: unknown): Frame => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Frame : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

const PAGE_ACTIONS: Readonly<Record<string, BrowserVerb>> = {
  navigate: 'navigate', click: 'click', type: 'type', key: 'key', scroll: 'scroll', tap: 'tap', swipe: 'swipe',
  inspect: 'inspect', screenshot: 'screenshot', viewport: 'viewport',
}
const CLOUD_ACTIONS: Readonly<Record<string, BrowserVerb>> = {
  tap: 'cloud-tap', swipe: 'cloud-swipe', type: 'cloud-type', key: 'cloud-key', button: 'cloud-button', openUrl: 'cloud-url',
  inspect: 'cloud-inspect', screenshot: 'cloud-screenshot',
}
const TOOL_VERBS: Readonly<Partial<Record<SottoBrowserTool, BrowserVerb>>> = {
  browser_open: 'open', iphone_open: 'phone-open', browser_start: 'start', browser_status: 'status', browser_pages: 'pages',
  browser_finish: 'finish', iphone_cloud_open: 'cloud-open', iphone_cloud_status: 'cloud-status', iphone_cloud_finish: 'cloud-finish',
}

/**
 * The browser's own answer to a call without reported input (Codex keeps no arguments): the task, whose newest step names
 * the action Sotto's browser took and the page it was on. Anything else, or output cut short, says nothing.
 */
function answeredStep(record: AgentActivity): Frame | undefined {
  const output = record.output?.trim()
  if (!output?.startsWith('{') || !output.endsWith('}')) return undefined
  try {
    const steps = frame(frame(JSON.parse(output)).task).steps
    return Array.isArray(steps) ? frame(steps.at(-1)) : undefined
  } catch { return undefined }
}

function stepOf(record: AgentActivity): BrowserStep | null {
  if (record.kind !== 'tool') return null
  const tool = sottoBrowserToolOfTitle(record.title)
  if (tool === undefined) return null
  const kind: BrowserRunKind = tool.startsWith('iphone_cloud_') ? 'cloud' : 'browser'
  const failed = record.status === 'failed'
  const input = activityInput(record)
  const reported = input === null && (tool === 'browser_open' || tool === 'iphone_open' || tool === 'browser_action') ? answeredStep(record) : undefined
  if (tool === 'browser_action' || tool === 'iphone_cloud_action') {
    const action = frame(input?.action)
    const type = text(action.type) ?? text(reported?.action) ?? ''
    const verbs = kind === 'cloud' ? CLOUD_ACTIONS : PAGE_ACTIONS
    const verb = Object.hasOwn(verbs, type) ? verbs[type]! : kind === 'cloud' ? 'cloud-work' : 'work'
    const opens = verb === 'navigate' || verb === 'cloud-url'
    return { record, tool, kind, verb, failed,
      ...(opens ? { url: text(action.url) ?? text(reported?.url) } : {}),
      ...(verb === 'key' || verb === 'cloud-key' || verb === 'cloud-button' ? { key: text(action.key) ?? text(action.button) } : {}) }
  }
  return { record, tool, kind, verb: TOOL_VERBS[tool]!, failed,
    ...(tool === 'browser_open' || tool === 'iphone_open' ? { url: text(input?.url) ?? text(reported?.url) } : {}) }
}

// Records are shared across updates, so each one is read once, however often the transcript draws it.
const steps = new WeakMap<AgentActivity, BrowserStep | null>()

/** The call to Sotto's own browser this record is, or null for any other record. */
export function browserStep(record: AgentActivity): BrowserStep | null {
  let step = steps.get(record)
  if (step === undefined) steps.set(record, step = stepOf(record))
  return step
}

export interface BrowserRun {
  /** The run's first record, which stays its first while later calls join it: the line sits where that call happened. */
  readonly key: string
  readonly kind: BrowserRunKind
  /** Every call of its kind in the turn, in the order they were reported, with other work in between left out. */
  readonly steps: readonly BrowserStep[]
  /** The agent's newest call finished its task (browser_finish, iphone_cloud_finish). */
  readonly finished: boolean
}

/** One turn's browser lines: at most one for Sotto's browser and one for the cloud iPhone. */
export interface TurnBrowserLines {
  readonly runs: readonly BrowserRun[]
  /** Each record a line stands for, with that line. A record found here draws no row of its own. */
  readonly folded: ReadonlyMap<string, BrowserRun>
  /** The turn's newest step of any kind, by reported order. */
  readonly newest?: AgentActivity | undefined
}

const NO_LINES: TurnBrowserLines = { runs: [], folded: new Map() }

/**
 * Every turn's browser lines, in one pass over the records (ADR-0154): a turn's calls to Sotto's browser make one line,
 * wherever other work falls between them, and its calls to the cloud iPhone another. A call that holds work of its own, or
 * that sits under another record (a subagent's call), keeps its row where it is, so nothing reported is hidden. The caller
 * keeps the answer for as long as the records are the same array. Given the answer before, a turn whose lines read the
 * same records keeps the very same object, so whatever draws it can tell nothing changed without looking inside.
 */
export function browserLinesByTurn(activities: readonly AgentActivity[] | undefined, previous?: ReadonlyMap<string, TurnBrowserLines>): ReadonlyMap<string, TurnBrowserLines> {
  const turns = new Map<string, { runs: Map<BrowserRunKind, BrowserStep[]>; newest?: AgentActivity }>()
  if (activities === undefined || activities.length === 0) return new Map()
  const ids = new Set<string>(), parents = new Set<string>()
  for (const record of activities) {
    ids.add(record.id)
    if (record.parentId !== undefined && record.parentId !== record.id) parents.add(record.parentId)
  }
  for (const record of activities) {
    if (!isStep(record)) continue
    let turn = turns.get(record.turnId)
    if (turn === undefined) turns.set(record.turnId, turn = { runs: new Map() })
    if (turn.newest === undefined || record.sequence > turn.newest.sequence) turn.newest = record
    const step = browserStep(record)
    if (step === null || parents.has(record.id) || (record.parentId !== undefined && record.parentId !== record.id && ids.has(record.parentId))) continue
    const run = turn.runs.get(step.kind)
    if (run === undefined) turn.runs.set(step.kind, [step])
    else run.push(step)
  }
  const lines = new Map<string, TurnBrowserLines>()
  for (const [turnId, turn] of turns) {
    if (turn.runs.size === 0) { lines.set(turnId, { ...NO_LINES, newest: turn.newest }); continue }
    const folded = new Map<string, BrowserRun>()
    const runs = [...turn.runs.entries()].map(([kind, steps]) => {
      steps.sort((a, b) => a.record.sequence - b.record.sequence)
      const last = steps.at(-1)!.tool
      const run: BrowserRun = { key: steps[0]!.record.id, kind, steps, finished: last === 'browser_finish' || last === 'iphone_cloud_finish' }
      for (const step of steps) folded.set(step.record.id, run)
      return run
    })
    lines.set(turnId, { runs, folded, newest: turn.newest })
  }
  if (previous !== undefined) for (const [turnId, turn] of lines) {
    const before = previous.get(turnId)
    if (before !== undefined && sameLines(before, turn)) lines.set(turnId, before)
  }
  return lines
}

/** Two answers for one turn that read the same records, in the same order. */
function sameLines(a: TurnBrowserLines, b: TurnBrowserLines): boolean {
  if (a.newest !== b.newest || a.runs.length !== b.runs.length) return false
  return a.runs.every((run, index) => {
    const other = b.runs[index]!
    return run.kind === other.kind && run.steps.length === other.steps.length && run.steps.every((step, at) => step.record === other.steps[at]!.record)
  })
}

/** The lines a group draws: each line whose first call is one of the group's records, in the group's order. */
export function linesStartingIn(records: readonly AgentActivity[], lines: TurnBrowserLines): readonly BrowserRun[] {
  if (lines.folded.size === 0) return []
  const runs: BrowserRun[] = []
  for (const record of records) {
    const run = lines.folded.get(record.id)
    if (run?.key === record.id) runs.push(run)
  }
  return runs
}

/** One turn's lines as a group draws them, with the line still going when the turn is the running one. */
export interface TurnLinesView {
  readonly lines: TurnBrowserLines
  readonly goingKey: string | null
}
const NO_VIEW: TurnLinesView = { lines: NO_LINES, goingKey: null }

/**
 * Every turn's browser lines for one transcript, read a turn at a time. Each turn's view keeps its identity until its own
 * lines or its going line change, so a group subscribed to its turn is not drawn again when another turn's records change
 * (AGENTS.md: update work does not grow with the history on screen). The records are read again only when they are a new
 * array; a message alone moves only the running turn's going line.
 */
export class BrowserLinesStore {
  private activities: readonly AgentActivity[] | undefined
  private byTurn: ReadonlyMap<string, TurnBrowserLines> = new Map()
  private readonly views = new Map<string, TurnLinesView>()
  private live: string | null = null
  /** Who draws each turn: told only when that turn's view changes, so telling does not grow with the history on screen. */
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly subscribers = new Map<string, (listener: () => void) => () => void>()

  /** How to hear of one turn's view, the same function each time for a turn, as `useSyncExternalStore` wants. */
  subscriberFor(turnId: string): (listener: () => void) => () => void {
    let subscribe = this.subscribers.get(turnId)
    if (subscribe === undefined) {
      subscribe = listener => {
        let turn = this.listeners.get(turnId)
        if (turn === undefined) this.listeners.set(turnId, turn = new Set())
        turn.add(listener)
        return () => {
          turn.delete(listener)
          if (turn.size === 0 && this.listeners.get(turnId) === turn) { this.listeners.delete(turnId); this.subscribers.delete(turnId) }
        }
      }
      this.subscribers.set(turnId, subscribe)
    }
    return subscribe
  }

  readonly view = (turnId: string): TurnLinesView => this.views.get(turnId) ?? NO_VIEW

  /** Takes the transcript's records, its running turn and its messages, and tells only the turns whose view changed. */
  update(activities: readonly AgentActivity[] | undefined, liveTurn: string | null, messages: readonly AgentMessage[]): void {
    const changed: string[] = []
    const put = (turnId: string, lines: TurnBrowserLines, goingKey: string | null): void => {
      const before = this.views.get(turnId)
      if (before !== undefined && before.lines === lines && before.goingKey === goingKey) return
      this.views.set(turnId, { lines, goingKey })
      changed.push(turnId)
    }
    if (activities !== this.activities) {
      this.activities = activities
      this.byTurn = browserLinesByTurn(activities, this.byTurn)
      for (const turnId of [...this.views.keys()]) if (!this.byTurn.has(turnId)) { this.views.delete(turnId); changed.push(turnId) }
      for (const [turnId, lines] of this.byTurn) put(turnId, lines, turnId === liveTurn ? goingRunKey(lines, messages) : null)
    } else {
      // Only the running turn's going line can have moved: the turn that was running, and the one that is.
      if (this.live !== null && this.live !== liveTurn) { const lines = this.byTurn.get(this.live); if (lines) put(this.live, lines, null) }
      if (liveTurn !== null) { const lines = this.byTurn.get(liveTurn); if (lines) put(liveTurn, lines, goingRunKey(lines, messages)) }
    }
    this.live = liveTurn
    for (const turnId of changed) {
      const turn = this.listeners.get(turnId)
      if (turn !== undefined) for (const listener of [...turn]) listener()
    }
  }
}

export const turnBrowserLines = (lines: ReadonlyMap<string, TurnBrowserLines> | undefined, turnId: string): TurnBrowserLines => lines?.get(turnId) ?? NO_LINES

export type ActivityItem = { readonly node: ActivityNode; readonly run?: undefined } | { readonly run: BrowserRun; readonly node?: undefined }

/**
 * A group's rows with its turn's browser lines in place: a line where its first call happened, and no row for any call it
 * stands for. Rows the turn's lines do not stand for are drawn as before.
 */
export function foldBrowserRuns(nodes: readonly ActivityNode[], lines: TurnBrowserLines): readonly ActivityItem[] {
  if (lines.folded.size === 0) return nodes.map(node => ({ node }))
  const items: ActivityItem[] = []
  for (const node of nodes) {
    const run = lines.folded.get(node.record.id)
    if (run === undefined) items.push({ node })
    else if (run.key === node.record.id) items.push({ run })
  }
  return items
}

/**
 * The line still going in the running turn, by its first record: the one whose call is the turn's newest step, unless the
 * agent finished its task or has written a reply since that call. Null when none is.
 */
export function goingRunKey(lines: TurnBrowserLines, messages: readonly AgentMessage[]): string | null {
  const newest = lines.newest
  const run = newest === undefined ? undefined : lines.folded.get(newest.id)
  if (run === undefined || run.finished) return null
  const anchor = newest!.afterMessageId
  if (anchor !== undefined) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.id === anchor) break
      if (message.role === 'assistant') return null
    }
  }
  return run.key
}

const hostOf = (url: string): string | undefined => {
  try { return new URL(url).host || undefined } catch { return undefined }
}

/** The line's host: where the run's newest open or navigation went, such as localhost:5173. */
export function browserRunHost(run: BrowserRun): string | undefined {
  for (let index = run.steps.length - 1; index >= 0; index--) {
    const host = run.steps[index]!.url === undefined ? undefined : hostOf(run.steps[index]!.url!)
    if (host !== undefined) return host
  }
  return undefined
}

/** An address as a step says it: its host and path, without the scheme or anything after the path. */
function shownAddress(url: string): string {
  try {
    const parsed = new URL(url)
    if (!parsed.host) return url
    return parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`
  } catch { return url }
}

/**
 * Translated words with at most one address or key name in them. The address stays left to right in its own element
 * inside a sentence of any direction (ADR-0123), so the words keep a mark where it goes rather than the address itself.
 */
export interface BrowserWords {
  /** The translated words, with `PLACE` where the address or key goes. */
  readonly text: string
  /** The address or key name, as written. */
  readonly place?: string | undefined
}
export const PLACE = '\u0000'

const placed = (text: string, place?: string): BrowserWords => place === undefined ? { text } : { text, place }

/** The words as one string, the address in its place: for a name assistive tech reads. */
export const plainWords = (words: BrowserWords): string => words.place === undefined ? words.text : words.text.replace(PLACE, words.place)

/** The words starting with a capital, as a step in the opened list does. */
export function sentenceWords(words: BrowserWords): BrowserWords {
  const first = words.text.charAt(0)
  return first === PLACE ? words : { ...words, text: first.toUpperCase() + words.text.slice(1) }
}

/**
 * What one call did, starting lowercase: "clicked in the page", or "could not click in the page" when it failed. The
 * steps list makes the first letter a capital.
 */
export function browserStepWords(step: BrowserStep): BrowserWords {
  const failed = step.failed
  const url = PLACE, key = PLACE
  const address = step.url === undefined ? undefined : shownAddress(step.url)
  switch (step.verb) {
    // Opening an address reads the same on the browser and the cloud iPhone; without one, it says what was opened.
    case 'open': case 'cloud-url': return address !== undefined
      ? placed(failed ? t({ message: `could not open ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `opened ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }), address)
      : step.verb === 'open'
        ? placed(failed ? t({ message: 'could not open a page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'opened a page', comment: 'A step in the browser line; starts lowercase.' }))
        : placed(failed ? t({ message: 'could not open a link', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'opened a link', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'phone-open': return address !== undefined
      ? placed(failed ? t({ message: `could not open ${url} on the test iPhone`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `opened ${url} on the test iPhone`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }), address)
      : placed(failed ? t({ message: 'could not open a page on the test iPhone', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'opened a page on the test iPhone', comment: 'A step in the browser line; starts lowercase.' }))
    case 'start': return placed(failed ? t({ message: 'could not start a browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'started a browser task', comment: 'A step in the browser line; starts lowercase.' }))
    case 'navigate': return address !== undefined
      ? placed(failed ? t({ message: `could not go to ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `went to ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }), address)
      : placed(failed ? t({ message: 'could not go to another page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'went to another page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'click': return placed(failed ? t({ message: 'could not click in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'clicked in the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'type': return placed(failed ? t({ message: 'could not type into the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'typed into the page', comment: 'A step in the browser line; starts lowercase.' }))
    // A named key reads the same on the page and the cloud iPhone, and so does a hardware button.
    case 'key': case 'cloud-key': case 'cloud-button': return step.key !== undefined
      ? placed(failed ? t({ message: `could not press ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' }) : t({ message: `pressed ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' }), step.key)
      : step.verb === 'cloud-button'
        ? placed(failed ? t({ message: 'could not press a button', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'pressed a button', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
        : placed(failed ? t({ message: 'could not press a key', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'pressed a key', comment: 'A step in the browser line; starts lowercase.' }))
    case 'scroll': return placed(failed ? t({ message: 'could not scroll the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'scrolled the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'tap': return placed(failed ? t({ message: 'could not tap in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'tapped in the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'swipe': return placed(failed ? t({ message: 'could not swipe in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'swiped in the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'inspect': return placed(failed ? t({ message: 'could not look at the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'looked at the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'screenshot': return placed(failed ? t({ message: 'could not take a picture of the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'took a picture of the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'viewport': return placed(failed ? t({ message: 'could not change the page size', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'changed the page size', comment: 'A step in the browser line; starts lowercase.' }))
    case 'work': return placed(failed ? t({ message: 'could not work in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'worked in the page', comment: 'A step in the browser line; starts lowercase.' }))
    case 'status': return placed(failed ? t({ message: 'could not check the browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'checked the browser task', comment: 'A step in the browser line; starts lowercase.' }))
    case 'pages': return placed(failed ? t({ message: 'could not list its pages', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'listed its pages', comment: 'A step in the browser line; starts lowercase.' }))
    case 'finish': return placed(failed ? t({ message: 'could not finish the browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'finished the browser task', comment: 'A step in the browser line; starts lowercase.' }))
    case 'cloud-open': return placed(failed ? t({ message: 'could not start a cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'started a cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-tap': return placed(failed ? t({ message: 'could not tap the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'tapped the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-swipe': return placed(failed ? t({ message: 'could not swipe the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'swiped the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-type': return placed(failed ? t({ message: 'could not type on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'typed on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-inspect': return placed(failed ? t({ message: 'could not look at the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'looked at the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-screenshot': return placed(failed ? t({ message: 'could not take a picture of the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'took a picture of the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-work': return placed(failed ? t({ message: 'could not work on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'worked on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-status': return placed(failed ? t({ message: 'could not check the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'checked the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
    case 'cloud-finish': return placed(failed ? t({ message: 'could not finish the cloud iPhone session', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'finished the cloud iPhone session', comment: 'A step in the cloud iPhone line; starts lowercase.' }))
  }
}

/**
 * The line's words: "Browsing localhost:5173" while the run goes on, "Browsed localhost:5173" once the turn has moved on,
 * then after the dot the last step or how many there were.
 */
export function browserRunWords(run: BrowserRun, going: boolean): { readonly headline: BrowserWords; readonly detail: BrowserWords } {
  const address = browserRunHost(run)
  const host = PLACE
  const headline = run.kind === 'cloud'
    ? placed(going ? t({ message: 'Using the cloud iPhone', comment: 'The cloud iPhone line while the agent uses it.' }) : t({ message: 'Used the cloud iPhone', comment: 'The cloud iPhone line once the agent has moved on.' }))
    : address === undefined
      ? placed(going ? t({ message: 'Using the browser', comment: 'The browser line while the agent uses Sotto\'s browser and has opened no address.' }) : t({ message: 'Used the browser', comment: 'The browser line once the agent has moved on, when it opened no address.' }))
      : placed(going ? t({ message: `Browsing ${host}`, comment: 'The browser line while the agent uses Sotto\'s browser. {host} is the site, such as localhost:5173.' })
        : t({ message: `Browsed ${host}`, comment: 'The browser line once the agent has moved on. {host} is the site, such as localhost:5173.' }), address)
  return { headline, detail: going ? browserStepWords(run.steps.at(-1)!) : placed(stepsLabel(run.steps.length)) }
}

/** What a press on the line does, with the line's own words, for assistive tech. */
export function browserLineName(run: BrowserRun, open: boolean, line: string): string {
  return run.kind === 'cloud'
    ? open ? t({ message: `Hide cloud iPhone steps: ${line}`, comment: 'The cloud iPhone line\'s button when its steps show. {line} is what the line says.' })
      : t({ message: `Show cloud iPhone steps: ${line}`, comment: 'The cloud iPhone line\'s button when its steps are folded. {line} is what the line says.' })
    : open ? t({ message: `Hide browser steps: ${line}`, comment: 'The browser line\'s button when its steps show. {line} is what the line says, such as Browsing localhost:5173 · clicked in the page.' })
      : t({ message: `Show browser steps: ${line}`, comment: 'The browser line\'s button when its steps are folded. {line} is what the line says, such as Browsing localhost:5173 · clicked in the page.' })
}
