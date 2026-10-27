import { t } from '@lingui/core/macro'

import type { AgentActivity } from '../../../shared/agentActivity'
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

export const isBrowserStep = (record: AgentActivity): boolean => browserStep(record) !== null

export interface BrowserRun {
  /** The run's first record, which stays its first while later calls join it. */
  readonly key: string
  readonly kind: BrowserRunKind
  readonly steps: readonly BrowserStep[]
  /** The agent finished its browser task (browser_finish, iphone_cloud_finish): a later call starts a new line. */
  readonly finished: boolean
}

export type ActivityItem = { readonly node: ActivityNode; readonly run?: undefined } | { readonly run: BrowserRun; readonly node?: undefined }

/**
 * A group's rows with each run of consecutive calls to Sotto's browser folded into one item. Any other row ends a run, so
 * does the agent finishing its task, and the cloud iPhone's calls make runs of their own. A call that holds work of its own
 * under it keeps its row.
 */
export function foldBrowserRuns(nodes: readonly ActivityNode[]): readonly ActivityItem[] {
  const items: ActivityItem[] = []
  let run: { key: string; kind: BrowserRunKind; steps: BrowserStep[]; finished: boolean } | null = null
  for (const node of nodes) {
    const step = node.children.length ? null : browserStep(node.record)
    if (step === null) { run = null; items.push({ node }); continue }
    if (run === null || run.finished || run.kind !== step.kind) {
      run = { key: step.record.id, kind: step.kind, steps: [], finished: false }
      items.push({ run })
    }
    run.steps.push(step)
    if (step.tool === 'browser_finish' || step.tool === 'iphone_cloud_finish') run.finished = true
  }
  return items
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
 * What one call did, starting lowercase: "clicked in the page", or "could not click in the page" when it failed. The
 * steps list makes the first letter a capital.
 */
export function browserStepWords(step: BrowserStep): string {
  const url = step.url === undefined ? '' : shownAddress(step.url), key = step.key ?? ''
  const failed = step.failed
  switch (step.verb) {
    case 'open': return url
      ? failed ? t({ message: `could not open ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `opened ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' })
      : failed ? t({ message: 'could not open a page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'opened a page', comment: 'A step in the browser line; starts lowercase.' })
    case 'phone-open': return url
      ? failed ? t({ message: `could not open ${url} on the test iPhone`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `opened ${url} on the test iPhone`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' })
      : failed ? t({ message: 'could not open a page on the test iPhone', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'opened a page on the test iPhone', comment: 'A step in the browser line; starts lowercase.' })
    case 'start': return failed ? t({ message: 'could not start a browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'started a browser task', comment: 'A step in the browser line; starts lowercase.' })
    case 'navigate': return url
      ? failed ? t({ message: `could not go to ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `went to ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' })
      : failed ? t({ message: 'could not go to another page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'went to another page', comment: 'A step in the browser line; starts lowercase.' })
    case 'click': return failed ? t({ message: 'could not click in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'clicked in the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'type': return failed ? t({ message: 'could not type into the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'typed into the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'key': return key
      ? failed ? t({ message: `could not press ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' }) : t({ message: `pressed ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' })
      : failed ? t({ message: 'could not press a key', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'pressed a key', comment: 'A step in the browser line; starts lowercase.' })
    case 'scroll': return failed ? t({ message: 'could not scroll the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'scrolled the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'tap': return failed ? t({ message: 'could not tap in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'tapped in the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'swipe': return failed ? t({ message: 'could not swipe in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'swiped in the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'inspect': return failed ? t({ message: 'could not look at the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'looked at the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'screenshot': return failed ? t({ message: 'could not take a picture of the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'took a picture of the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'viewport': return failed ? t({ message: 'could not change the page size', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'changed the page size', comment: 'A step in the browser line; starts lowercase.' })
    case 'work': return failed ? t({ message: 'could not work in the page', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'worked in the page', comment: 'A step in the browser line; starts lowercase.' })
    case 'status': return failed ? t({ message: 'could not check the browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'checked the browser task', comment: 'A step in the browser line; starts lowercase.' })
    case 'pages': return failed ? t({ message: 'could not list its pages', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'listed its pages', comment: 'A step in the browser line; starts lowercase.' })
    case 'finish': return failed ? t({ message: 'could not finish the browser task', comment: 'A step in the browser line; starts lowercase.' }) : t({ message: 'finished the browser task', comment: 'A step in the browser line; starts lowercase.' })
    case 'cloud-open': return failed ? t({ message: 'could not start a cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'started a cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-tap': return failed ? t({ message: 'could not tap the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'tapped the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-swipe': return failed ? t({ message: 'could not swipe the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'swiped the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-type': return failed ? t({ message: 'could not type on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'typed on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-key': case 'cloud-button': return key
      ? failed ? t({ message: `could not press ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' }) : t({ message: `pressed ${key}`, comment: 'A step in the browser line; starts lowercase. {key} is a key\'s name, such as Enter.' })
      : failed ? t({ message: 'could not press a button', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'pressed a button', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-url': return url
      ? failed ? t({ message: `could not open ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' }) : t({ message: `opened ${url}`, comment: 'A step in the browser line; starts lowercase. {url} is a web address.' })
      : failed ? t({ message: 'could not open a link', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'opened a link', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-inspect': return failed ? t({ message: 'could not look at the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'looked at the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-screenshot': return failed ? t({ message: 'could not take a picture of the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'took a picture of the screen', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-work': return failed ? t({ message: 'could not work on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'worked on the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-status': return failed ? t({ message: 'could not check the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'checked the cloud iPhone', comment: 'A step in the cloud iPhone line; starts lowercase.' })
    case 'cloud-finish': return failed ? t({ message: 'could not finish the cloud iPhone session', comment: 'A step in the cloud iPhone line; starts lowercase.' }) : t({ message: 'finished the cloud iPhone session', comment: 'A step in the cloud iPhone line; starts lowercase.' })
  }
}

/** A step as the opened list says it, with a capital. */
export function browserStepSentence(step: BrowserStep): string {
  const words = browserStepWords(step)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The line's words: "Browsing localhost:5173" while the run goes on, "Browsed localhost:5173" once the turn has moved on,
 * then after the dot the last step or how many there were.
 */
export function browserRunWords(run: BrowserRun, going: boolean): { readonly headline: string; readonly detail: string } {
  const host = browserRunHost(run)
  const headline = run.kind === 'cloud'
    ? going ? t({ message: 'Using the cloud iPhone', comment: 'The cloud iPhone line while the agent uses it.' }) : t({ message: 'Used the cloud iPhone', comment: 'The cloud iPhone line once the agent has moved on.' })
    : host === undefined
      ? going ? t({ message: 'Using the browser', comment: 'The browser line while the agent uses Sotto\'s browser and has opened no address.' }) : t({ message: 'Used the browser', comment: 'The browser line once the agent has moved on, when it opened no address.' })
      : going ? t({ message: `Browsing ${host}`, comment: 'The browser line while the agent uses Sotto\'s browser. {host} is the site, such as localhost:5173.' })
        : t({ message: `Browsed ${host}`, comment: 'The browser line once the agent has moved on. {host} is the site, such as localhost:5173.' })
  return { headline, detail: going ? browserStepWords(run.steps.at(-1)!) : stepsLabel(run.steps.length) }
}

/**
 * The newest step of a running turn, by its reported order: one pass, nothing copied. Null when the turn has none yet or
 * no turn is running.
 */
export function newestStepId(activities: readonly AgentActivity[] | undefined, turnId: string | null): string | null {
  if (turnId === null || activities === undefined) return null
  let newest: AgentActivity | undefined
  for (const record of activities) {
    if (record.turnId === turnId && isStep(record) && (newest === undefined || record.sequence > newest.sequence)) newest = record
  }
  return newest?.id ?? null
}
