import { presetSize, type BrowserAction, type BrowserAppearance, type BrowserBounds, type BrowserCapture, type BrowserDialog, type BrowserTargetFields } from '../../shared/browser'
import { ToolFailure, fail } from './common'
import { SNAPSHOT_TEXT, fieldContents, formatSnapshot, keyEvents, modifierMask, type AXNode } from './pageSnapshot'
import { MASK, maskSecrets, secretMatcher, type SecretMatcher } from './secretMask'

/**
 * The page's debugger, as a page automation drives it: Electron's own on the desktop, a DevTools session over a pipe
 * on a host (ADR-0198). Commands and events are the Chrome DevTools Protocol's.
 */
export interface PageDebugger {
  /** The page is gone for good: no command will reach it again. */
  isGone(): boolean
  /** The page's address as the debugger last knew it. */
  url(): string
  isAttached(): boolean
  attach(): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  onEvent(listener: PageEventListener): void
  offEvent(listener: PageEventListener): void
}
export type PageEventListener = (method: string, params: Record<string, unknown>) => void
/** How a picture is taken: PNG at full size, or a JPEG at a quality and a scale. */
export type PageEncoding = { readonly format: 'png'; readonly scale: 1 } | { readonly format: 'jpeg'; readonly quality: number; readonly scale: number }
/** A picture Chromium returned, base64, at the size it was asked for. */
export interface PageFrame { readonly data: string; readonly format: 'png' | 'jpeg'; readonly width: number; readonly height: number }
/**
 * The pictures a browser task keeps as evidence: a JPEG at most 1280 wide, or at most 640 if that one is over the
 * limit. The desktop makes them from the capture; a host asks Chromium for them.
 */
export const EVIDENCE_PICTURES = [{ width: 1280, quality: 70 }, { width: 640, quality: 55 }] as const
export const EVIDENCE_LIMIT = 2_000_000
export interface PageEvidence { readonly image: string; readonly width: number; readonly height: number }
export interface PagePicture { readonly empty: boolean; readonly width: number; readonly height: number; readonly dataUrl: string }

export type PageInput = Extract<BrowserAction, { type: 'click' | 'type' | 'scroll' | 'viewport' | 'tap' | 'swipe' | 'key' | 'hover' | 'select' | 'drag' }>
/** The actions that reach one element, or the page's open dialog or file chooser, so what they reach is recorded when asked and checked when run. */
export type TargetedAction = Extract<BrowserAction, { type: 'click' | 'type' | 'tap' | 'key' | 'select' | 'drag' | 'upload' | 'dialog' }>
export const isTargeted = (action: BrowserAction): action is TargetedAction => ['click', 'type', 'tap', 'key', 'select', 'drag', 'upload', 'dialog'].includes(action.type)
/** How much of a dialog's words Sotto shows. */
const DIALOG_WORDS = 2000
/** A dialog's untrusted words as Sotto shows them: no control or direction-changing characters. */
// eslint-disable-next-line no-control-regex -- Untrusted page words shown in Sotto's own chrome.
const pageWords = (value: string): string => value.replace(/[\x00-\x09\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, ' ')
/** How much of a console message and of an error the agent is told. */
const CONSOLE_WORDS = 500, ERROR_WORDS = 2000
/** How much of an element's name and words a pick, a comment on the page or inspect says. */
const ELEMENT_NAME = 500, ELEMENT_TEXT = 1000, INSPECT_NAME = 300, INSPECT_ELEMENT_NAME = 200
/** The most of an element's markup read for its words. */
const ELEMENT_MARKUP = 200_000
/** Run on an element: scrolls its nearest scrolling container, or the page, and returns how far that moved. */
const SCROLL_ELEMENT = `function(dx, dy) {
  const root = document.scrollingElement || document.documentElement
  const scrolls = element => { const style = getComputedStyle(element); return (/(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight) || (/(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth) }
  let element = this.nodeType === 1 ? this : this.parentElement
  while (element && element !== document.body && element !== root && !scrolls(element)) element = element.parentElement
  const target = element && element !== document.body && element !== root ? element : root
  const left = target.scrollLeft, top = target.scrollTop
  target.scrollBy({ left: dx, top: dy, behavior: 'instant' })
  return { x: target.scrollLeft - left, y: target.scrollTop - top, page: target === root }
}`
/** How long a click waits for the file chooser it may have opened (ADR-0220). */
const CHOOSER_GRACE_MS = 300
/** How much an evaluated value may say back (ADR-0220). */
export const EVALUATE_LIMIT = 64 * 1024
/** How many console messages a page keeps for its snapshot. */
const CONSOLE_KEPT = 100
/** A drag moves through this many points, so a page's pointer handlers see it travel. */
const DRAG_STEPS = 8
/** How often `wait_for` looks again. */
const WAIT_POLL_MS = 100
/** A swipe is this many touch moves between its two points: enough for a list to read it as a fling. */
const SWIPE_STEPS = 10
/** How long one point-mode command may take before the page counts as not answering. */
const POINT_DEADLINE = 5_000
/** The most a snapshot says back, under the task output's 200,000 characters (ADR-0220). */
export const SNAPSHOT_TOTAL = 180_000
/** The agent's cursor (ADR-0222): an arrow with its tip at the point, in CSS pixels, as a quad for Chromium's overlay. */
export const CURSOR_ARROW = [0, 0, 0, 17, 4.5, 12.5, 12, 12] as const
/** How long the cursor stays after an action, and how long a click's ring shows. */
export const CURSOR_LINGER_MS = 1_200
const CURSOR_RING_MS = 220
/** The glide to a new point: this many steps, this far apart. Reduced motion jumps. */
const CURSOR_STEPS = 6
const CURSOR_STEP_MS = 16
/** The agent's cursor colour and whether it may glide, from the window's theme and motion setting (ADR-0222). */
export interface CursorStyle { readonly color: { r: number; g: number; b: number }; readonly reducedMotion: boolean }

/** What point mode reports: the element under the pointer, by its tag and accessible name, and the one clicked. */
export interface PointHandlers {
  hover(element: { tag: string; name: string }): void
  pick(target: PointTarget): void
}
/** What was picked: the node the overlay reported for a click, or the page's focused element for Enter. */
export type PointTarget = { backendNodeId: number } | 'focused'
export interface PointedElement { readonly element: NonNullable<BrowserCapture['element']>; readonly box: BrowserBounds | null }

/** An id as a CSS identifier, escaped as `CSS.escape` would, so it becomes a selector without running script in the page. */
export function cssIdentifier(value: string): string {
  return [...value].map((character, index) => {
    const code = character.codePointAt(0)!
    if (code === 0) return '�'
    if ((code >= 1 && code <= 31) || code === 127 || (/[0-9]/u.test(character) && (index === 0 || (index === 1 && value[0] === '-')))) return `\\${code.toString(16)} `
    if (index === 0 && character === '-' && value.length === 1) return '\\-'
    return /[a-zA-Z0-9_\-\u0080-￿]/u.test(character) ? character : `\\${character}`
  }).join('')
}
/**
 * Whether a CSS selector compares part of an attribute's value (`^=`, `$=`, `*=`, `~=`, `|=`), which could test a value
 * a character at a time. It is looked for as written and with comments left out, since the operator's two halves may
 * have one between them, and what looks like a comment may be inside a string. Errs toward yes.
 */
export function comparesPartOfAttribute(selector: string): boolean {
  const operator = /[~|^$*]\s*=/u
  return operator.test(selector) || operator.test(selector.replace(/\/\*[\s\S]*?(?:\*\/|$)/gu, ''))
}
/** A web address's origin, as `https://example.com:8443`, or nothing for one that has none. */
function originOf(url: string): string {
  try { const origin = new URL(url).origin; return origin === 'null' ? '' : origin } catch { return '' }
}
/** Keys that move the caret. Held with Shift, each extends a selection. */
const CARET_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
/** The keys a field holding a typed secret still takes: they submit it, move the focus or move the caret, and none edits it. */
const NON_EDITING_KEYS: ReadonlySet<string> = new Set([...CARET_KEYS, 'Enter', 'Tab', 'Escape'])
/** How long after one tap the next waits while a document holds a typed secret, so the two never make a double tap. */
export const DOUBLE_TAP_GAP_MS = 500
/**
 * What of an action would select, copy, cut or carry text, in words for its refusal, or null for one that does none of
 * these. None goes to a document that holds a typed secret (ADR-0219): a site's "show password" turns the secret into
 * text, a copy or cut puts it on the clipboard, which a shell can read, and on Linux a selection is itself a copy, which a
 * middle click pastes anywhere. The keys are every platform's, whichever Sotto runs on: Control or Command with A, C or X;
 * Control+Insert and Shift+Delete; and Shift with a key that moves the caret. A double or triple click selects a word or
 * a line, a click with Shift extends a selection, a middle click pastes the selection on Linux, and a drag selects text
 * or carries what is selected.
 */
export function movesText(action: TargetedAction | PageInput): string | null {
  if (action.type === 'key') {
    const key = action.key.length === 1 ? action.key.toLowerCase() : action.key, held = action.modifiers ?? []
    const command = held.includes('Control') || held.includes('Meta')
    if ((command && (key === 'a' || key === 'c' || key === 'x')) || (held.includes('Control') && key === 'Insert') || (held.includes('Shift') && key === 'Delete')) return 'a key that selects, copies or cuts'
    if (held.includes('Shift') && CARET_KEYS.has(key)) return 'Shift with a key that moves the caret'
  } else if (action.type === 'click') {
    if ((action.clickCount ?? 1) > 1) return 'a double or triple click'
    if (action.modifiers?.includes('Shift')) return 'a click with Shift'
    if (action.button === 'middle') return 'a middle click'
  } else if (action.type === 'drag') return 'a drag'
  return null
}
/**
 * Run on an element: the text an edit there would change, followed into open shadow roots and same-origin frames as
 * the focus is. Read only in Sotto, never said back.
 */
const FIELD_TEXT = `function() {
  let element = this
  for (let depth = 0; element && depth < 32; depth++) {
    let inner = element.shadowRoot ? element.shadowRoot.activeElement : null
    if (!inner) { try { inner = element.contentDocument ? element.contentDocument.activeElement : null } catch { inner = null } }
    if (!inner || inner === element) break
    element = inner
  }
  if (!element) return ''
  return typeof element.value === 'string' ? element.value : element.isContentEditable ? element.innerText : ''
}`
/** What a refusal ends with once a secret request's value was taken (ADR-0219): the reference is used up. */
export const SECRET_SPENT = 'this secretRef is used. Ask for it again with request_secret.'
/** An error's own words as a sentence, for a refusal that goes on to say the reference is spent. */
function sentenceOf(error: unknown): string {
  const words = (error instanceof Error && error.message.trim()) || 'The typing stopped.'
  return /[.!?]$/u.test(words) ? words : `${words}.`
}

/** An attribute's value from CDP's flat list of names and values, walked in pairs. */
export function attributeOf(attributes: readonly string[] | undefined, name: string): string | undefined {
  for (let index = 0; index + 1 < (attributes?.length ?? 0); index += 2) if (attributes![index]!.toLowerCase() === name) return attributes![index + 1]
  return undefined
}
/**
 * The words an element's markup holds, without its tags, scripts or styles. `mask` is given them once tags and entities
 * are gone and before runs of spaces close up, so a secret written with `&amp;` or two spaces is found.
 */
function markupText(html: string, mask: (words: string) => string = words => words): string {
  return mask(html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, '\'').replace(/&amp;/gu, '&'))
    .replace(/\s+/gu, ' ').trim()
}

/**
 * How long one debugger command may take. Chromium answers a wheel, touch or capture only once the page draws a
 * frame, so a page that cannot draw would otherwise hold its action, and the service's place for it, until someone
 * showed it again. A command past this fails in words instead, and the action's page lock goes with it.
 */
export const BROWSER_COMMAND_DEADLINE_MS = 20_000
/** Resolves once the page has drawn two frames, or after half a second if it draws none. A fixed expression. */
const SETTLE_EXPRESSION = 'new Promise(done => { const timer = setTimeout(done, 500); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); done() })) })'

/**
 * Fixed operations only: callers cannot evaluate script or read cookies. The commands are the DevTools Protocol's, so
 * the desktop's browser and a host's (ADR-0198) share them; each says how it keeps a picture.
 */
export abstract class PageAutomation {
  private enabled: Promise<void> | null = null
  /** Set while point mode is on: the overlay's hover and click go here. */
  private pointing: PointHandlers | null = null
  private hovered: number | null = null
  private hoverRequest = 0
  /** Counts point starts and stops, so a start that finishes after a stop knows it is stale. */
  private pointSession = 0
  /** Which debugger attachment is current. A command left from an earlier one cannot reset this one. */
  private session = 0
  /** The viewport the agent set, if any. Chromium drops it with the attachment, so a fresh one sets it again. */
  private viewport: { width: number; height: number; mobile: boolean } | null = null
  /**
   * The page's zoom (ADR-0222). Chromium lays out a desktop viewport override in device pixels at the page's zoom, so a
   * width set at 175% would be 175% too narrow in CSS pixels; the override is sent multiplied by it, and the agent's
   * size stays the one it asked for. A mobile preset is not zoomed.
   */
  private zoom = 1
  /** The agent's cursor (ADR-0222), when the window gave its style; null draws none. */
  cursor: CursorStyle | null = null
  private cursorAt: { x: number; y: number } | null = null
  private cursorShown = false
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  /** Which attachment has the DOM and Overlay domains on for the cursor. */
  private cursorSession = -1
  /** What the page's console and network reported, each read `overread` past what is said of it (`told`). */
  private readonly errors: { kind: string; message: string }[] = []
  /**
   * Secrets typed into this page from a secret request (ADR-0219), each with the matcher that finds it once `masked`
   * has made it, held only in memory while the page is open, so whatever the page says back (its words, errors, an
   * evaluated value) reaches the agent with each one masked. Once one is here, `evaluate` stays off for the page's life
   * (`evaluate`), and `wait_for` and selectors cannot test it (`waitFor`, `checkedSelector`).
   */
  private readonly typedSecrets = new Map<string, SecretMatcher | null | undefined>()
  /**
   * A secret was typed into the document loaded now, so a picture of the page could show it (ADR-0222, decision 12).
   * Only a cross-document navigation that commits clears it: a hash change, a load that never commits, Stop sharing or
   * a new attachment leave the field, and its value, where it was.
   */
  private secretInDocument = false
  /** When the agent's last tap ended, so one straight after it waits (`DOUBLE_TAP_GAP_MS`). */
  private tappedAt = 0
  /**
   * The agent ran its own script in the document loaded now (`evaluate`), so a listener it left could read whatever is
   * typed into the page and hide it anywhere, in any encoding no mask matches. No secret is typed into this document;
   * only a cross-document navigation that commits clears it (ADR-0222, decision 12).
   */
  private scriptedDocument = false
  /** The agent has run its own script in some document of this page, which the back-forward cache could give back. */
  private scriptedEver = false
  /**
   * The full catalog (ADR-0220): the page's dialogs, file chooser and load events reach Sotto through the Page domain,
   * which the pane can then answer. Off, the Page domain stays off and dialogs stay Electron's, as before.
   */
  parity = false
  /** The page is in one of the user's browser profiles (ADR-0221), where an agent cannot open a page of its own. */
  inProfile = false
  /** Told when the page's dialog or file chooser opens or closes, so its owner publishes the page again. */
  onChange: (() => void) | null = null
  /** Refs from the latest snapshot to the DOM nodes they name; a navigation or a handoff forgets them. */
  private refs = new Map<string, number>()
  /** The page's console messages, each read `overread` past what is said of it (`told`). */
  private readonly consoleLog: { level: string; text: string }[] = []
  /** The dialog the page has open, its words as the page gave them, read `overread` past what is said (`dialogWords`). */
  private dialogOpen: (BrowserDialog & { readonly seq: number }) | null = null
  private dialogSeq = 0
  private readonly dialogWaiters = new Set<() => void>()
  /** A file chooser an agent's click opened, waiting for `upload` (ADR-0220). */
  private chooser: { readonly backendNodeId: number; readonly multiple: boolean; readonly seq: number } | null = null
  private interceptUntil = 0
  private appearance: BrowserAppearance | null = null
  private loadedAt = { domContent: 0, load: 0 }
  private screencast: ((data: string) => void) | null = null
  private dragData: unknown = null
  /**
   * `touch` is the test iPhone's (ADR-0045): while attached, the page sees a touch screen and the mouse taps it.
   * `prepareCapture` lends the page a surface to draw into while it is off screen, and returns its release.
   */
  constructor(private readonly page: PageDebugger, private readonly prepareCapture: () => () => void = () => () => undefined, private readonly touch = false) {}
  /**
   * Ends this debugger attachment: Electron rejects whatever is still waiting on it, and the next action attaches
   * afresh rather than queueing behind a page that never answered.
   */
  private reset(): void {
    this.session++
    this.enabled = null
    if (this.page.isGone() || !this.page.isAttached()) return
    try { this.page.detach() } catch { /* Already detached. */ }
  }
  /** One debugger command, bounded by the deadline. Past it, the attachment it was sent on ends. */
  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const session = this.session
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ToolFailure('unavailable', 'The page did not answer in time. Inspect it before trying again.')), BROWSER_COMMAND_DEADLINE_MS) })
    try { return await Promise.race([this.page.sendCommand(method, params), late]) }
    catch (error) {
      if (error instanceof ToolFailure && session === this.session) this.reset()
      throw error
    } finally { clearTimeout(timer) }
  }
  /** Cleans up after `work` either way; a cleanup that fails speaks only when the work itself did not. */
  private async cleaningUp<T>(work: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> {
    let result: T
    try { result = await work() } catch (error) { await cleanup().catch(() => undefined); throw error }
    await cleanup()
    return result
  }
  private async ready(): Promise<void> {
    if (!this.page.isAttached()) {
      this.page.attach()
      this.enabled = null
    }
    if (!this.enabled) {
      this.page.offEvent(this.onMessage)
      this.page.onEvent(this.onMessage)
      const commands = [this.send('Network.enable'), this.send('Runtime.enable')]
      if (this.parity) commands.push(this.send('Page.enable'))
      if (this.appearance) commands.push(this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: this.appearance }] }))
      if (this.touch) commands.push(
        this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
        this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }),
      )
      if (this.viewport) commands.push(this.send('Emulation.setDeviceMetricsOverride', this.metrics(this.viewport)))
      const enabling = Promise.all(commands).then(() => undefined)
      // A setup that failed is not kept: the next action tries it again rather than failing on the old answer.
      enabling.catch(() => { if (this.enabled === enabling) this.enabled = null })
      this.enabled = enabling
    }
    await this.enabled
  }
  private readonly onMessage = (method: string, params: Record<string, unknown>): void => {
    let message: string | undefined
    if (method === 'Network.loadingFailed') message = typeof params.errorText === 'string' ? params.errorText : 'A network request failed.'
    if (method === 'Network.responseReceived') {
      const response = params.response as { status?: number; url?: string } | undefined
      if (response && (response.status ?? 0) >= 400) {
        let address = ''
        try { const url = new URL(response.url ?? ''); address = `${url.origin}${url.pathname}` } catch { /* Omit malformed addresses. */ }
        message = `${response.status} ${address}`
      }
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      message = details?.exception?.description ?? details?.text ?? 'A page script failed.'
    }
    if (method === 'Runtime.consoleAPICalled') {
      const args = params.args as { value?: unknown; description?: string }[] | undefined
      const words = args?.map(arg => typeof arg.value === 'string' ? arg.value : arg.value !== undefined ? JSON.stringify(arg.value) : arg.description ?? '').join(' ') ?? ''
      this.consoleLog.push({ level: String(params.type ?? 'log'), text: words.slice(0, CONSOLE_WORDS + this.overread) })
      if (this.consoleLog.length > CONSOLE_KEPT) this.consoleLog.shift()
      if (params.type === 'error') message = words || 'The page reported an error.'
    }
    this.onPageEvent(method, params)
    if (method === 'Overlay.nodeHighlightRequested' && this.pointing && typeof params.nodeId === 'number') this.hover(params.nodeId)
    if (method === 'Overlay.inspectNodeRequested' && this.pointing && typeof params.backendNodeId === 'number') {
      const handlers = this.pointing
      this.pointing = null; this.hovered = null; this.hoverRequest++
      handlers.pick({ backendNodeId: params.backendNodeId })
    }
    if (message) {
      this.errors.push({ kind: method.startsWith('Network.') ? 'network' : 'console', message: message.slice(0, ERROR_WORDS + this.overread) })
      if (this.errors.length > 40) this.errors.shift()
    }
  }
  observe(): void { void this.ready().catch(() => undefined) }
  /** A command that gives up after POINT_DEADLINE, so a page that stops answering cannot hold point mode open. */
  private bounded<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The browser page did not answer in time.')), POINT_DEADLINE) })
    return Promise.race([this.page.sendCommand(method, params) as Promise<T>, deadline]).finally(() => { if (timer) clearTimeout(timer) })
  }
  /**
   * Point at something (ADR-0154): Chromium's own inspect overlay tints the element under the pointer in `color` and
   * labels it, and a click reports that element instead of reaching the page. No script goes into the page. The first
   * click ends it, so `handlers.pick` is called at most once. An `unpoint` while this is still setting up wins: the
   * session it started is stale, and a stale start turns the overlay back off.
   */
  async point(color: { r: number; g: number; b: number }, handlers: PointHandlers): Promise<void> {
    const session = ++this.pointSession
    this.pointing = handlers; this.hovered = null
    const stale = (): boolean => session !== this.pointSession
    const fill = (a: number) => ({ ...color, a })
    try {
      await this.ready()
      if (stale()) return
      await this.bounded('DOM.enable')
      // The overlay names a hovered node by its DOM id, which needs the document given to this client first.
      await this.bounded('DOM.getDocument', { depth: 0 })
      await this.bounded('Overlay.enable')
      if (stale()) return
      await this.bounded('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {
        showInfo: true, showAccessibilityInfo: true, showExtensionLines: false, showStyles: false, showRulers: false,
        contentColor: fill(0.3), paddingColor: fill(0.4), borderColor: fill(0.7), marginColor: fill(0.15),
      } })
      // Stopped while the overlay was being turned on: it is turned off again, after the command that turned it on.
      if (stale()) await this.bounded('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => undefined)
    } catch (error) {
      if (!stale()) this.pointing = null
      throw error
    }
  }
  /** Point mode off: the overlay stops, clicks reach the page again, and a start still setting up is stale. */
  async unpoint(): Promise<void> {
    this.pointSession++
    this.pointing = null; this.hovered = null; this.hoverRequest++
    if (this.page.isGone() || !this.page.isAttached()) return
    await this.bounded('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }).catch(() => undefined)
    await this.bounded('Overlay.hideHighlight').catch(() => undefined)
  }
  /**
   * Enter pressed in the page while pointing: the element the keyboard is on is picked, as a click picks the one
   * under the pointer. False when point mode is off, so the page keeps its Enter.
   */
  pickFocused(): boolean {
    const handlers = this.pointing
    if (!handlers) return false
    this.pointing = null; this.hovered = null; this.hoverRequest++
    handlers.pick('focused')
    return true
  }
  private hover(nodeId: number): void {
    if (nodeId === this.hovered) return
    this.hovered = nodeId
    const request = ++this.hoverRequest, handlers = this.pointing
    void this.describe({ nodeId }).then(described => {
      if (request === this.hoverRequest && handlers && this.pointing === handlers && described) handlers.hover({ tag: described.element.tag, name: described.element.name })
    }, () => undefined)
  }
  /** The node the keyboard is on: the page's focused element, found through the protocol. */
  private async focusedNode(): Promise<number | null> {
    const focused = await this.bounded<{ result?: { objectId?: string; subtype?: string } }>('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'sotto-browser-point' })
    if (!focused.result?.objectId || focused.result.subtype === 'null') return null
    try {
      const described = await this.bounded<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId: focused.result.objectId })
      return described.node?.backendNodeId ?? null
    } finally { await this.bounded('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-point' }).catch(() => undefined) }
  }
  /** The element picked: its tag, role, accessible name, words, a selector and where it sits on screen. */
  async pointed(target: PointTarget): Promise<PointedElement | null> {
    const backendNodeId = target === 'focused' ? await this.focusedNode() : target.backendNodeId
    if (backendNodeId === null) return null
    const described = await this.describe({ backendNodeId })
    if (!described) return null
    const box = await this.bounded<{ model?: { border?: number[] } }>('DOM.getBoxModel', { backendNodeId }).then(result => {
      const quad = result.model?.border
      if (!quad || quad.length < 8) return null
      const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!], ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
      const x = Math.min(...xs), y = Math.min(...ys)
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
    }, () => null)
    const html = await this.bounded<{ outerHTML?: string }>('DOM.getOuterHTML', { backendNodeId }).then(result => result.outerHTML ?? '', () => '')
    // Markup cut short has its words cut back from that end by as much as a secret takes written out, as the part
    // of one the cut left is there; they are masked before they are tidied and again before they are cut (`told`).
    const cut = html.length > ELEMENT_MARKUP + this.overread
    const words = markupText(cut ? html.slice(0, ELEMENT_MARKUP + this.overread) : html, text => this.masked(text))
    return { element: { ...described.element, text: this.told(cut ? words.slice(0, Math.max(0, words.length - this.overread)) : words, ELEMENT_TEXT) }, box }
  }
  private async describe(node: { nodeId: number } | { backendNodeId: number }): Promise<Omit<PointedElement, 'box'> | null> {
    const described = await this.bounded<{ node?: { nodeName?: string; localName?: string; nodeType?: number; attributes?: string[] } }>('DOM.describeNode', node)
    const found = described.node
    if (!found || found.nodeType !== 1) return null
    const tag = (found.localName || found.nodeName || '').toLowerCase().slice(0, 100)
    const attributes = new Map<string, string>()
    for (let index = 0; index + 1 < (found.attributes?.length ?? 0); index += 2) attributes.set(found.attributes![index]!, found.attributes![index + 1]!)
    const tree = await this.bounded<{ nodes?: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown } }[] }>('Accessibility.getPartialAXTree', { ...node, fetchRelatives: false }).catch(() => ({ nodes: [] }))
    const accessible = tree.nodes?.[0]
    // A pick goes into the user's message to the agent, so its words are masked as the agent's own reads are: before
    // they are tidied or cut, and again after.
    const role = this.told(String(accessible?.role?.value ?? attributes.get('role') ?? ''), 100)
    // eslint-disable-next-line no-control-regex -- Untrusted page words shown in Sotto's own chrome.
    const name = this.masked(this.masked(String(accessible?.name?.value || attributes.get('aria-label') || attributes.get('alt') || '')).replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, ELEMENT_NAME))
    const id = attributes.get('id')
    return { element: { tag, role: ['generic', 'none', 'presentation'].includes(role) ? '' : role, name, text: '', selector: id ? `#${cssIdentifier(this.masked(id))}` : tag } }
  }
  /** The Page domain's news for the full catalog: dialogs, the file chooser, loads and recorded frames. */
  private onPageEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Page.javascriptDialogOpening') {
      const type = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(String(params.type)) ? String(params.type) as BrowserDialog['type'] : 'alert'
      const words = (value: unknown): string => String(value ?? '').slice(0, DIALOG_WORDS + this.overread)
      this.dialogOpen = { type, message: words(params.message), ...(type === 'prompt' ? { defaultPrompt: words(params.defaultPrompt) } : {}), seq: ++this.dialogSeq }
      for (const waiter of [...this.dialogWaiters]) waiter()
      this.onChange?.()
    } else if (method === 'Page.javascriptDialogClosed') {
      this.dialogOpen = null
      // What waited for the dialog to close: the system's file chooser given back, and a cursor left up taken off.
      if (this.interceptUntil !== 0 && !this.chooser) void this.stopIntercepting()
      if (this.cursorShown) this.lingerCursor()
      this.onChange?.()
    } else if (method === 'Page.fileChooserOpened' && typeof params.backendNodeId === 'number') {
      this.chooser = { backendNodeId: params.backendNodeId, multiple: params.mode === 'selectMultiple', seq: ++this.dialogSeq }
      for (const waiter of [...this.dialogWaiters]) waiter()
      this.onChange?.()
    } else if (method === 'Page.frameNavigated') {
      // Only the main frame's commit is a new document. One the back-forward cache gives back is the document that was,
      // with its script and its fields.
      if ((params.frame as { parentId?: unknown } | undefined)?.parentId) return
      if (params.type === 'BackForwardCacheRestore') this.documentRestored()
      else this.documentCommitted()
    } else if (method === 'Page.domContentEventFired') this.loadedAt.domContent = Date.now()
    else if (method === 'Page.loadEventFired') this.loadedAt.load = Date.now()
    else if (method === 'Page.screencastFrame' && typeof params.data === 'string') {
      void this.page.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined)
      this.screencast?.(params.data)
    } else if (method === 'Input.dragIntercepted') this.dragData = params.data ?? null
  }
  /** The dialog the page has open, as the window and the agent see it, or null. */
  dialog(): BrowserDialog | null {
    if (!this.dialogOpen) return null
    const dialog = this.dialogOpen
    // The page's words go to the pane: a secret the page echoes is masked there as everywhere (ADR-0219).
    return { type: dialog.type, message: this.dialogWords(dialog.message), ...(dialog.defaultPrompt !== undefined ? { defaultPrompt: this.dialogWords(dialog.defaultPrompt) } : {}) }
  }
  /**
   * A dialog's words as the pane and the agent are told them: masked, then cut at `DIALOG_WORDS` and tidied
   * (`pageWords`), then masked again, since a secret the page wrote with a tab in it reads as the secret once the tab
   * is a space.
   */
  private dialogWords(words: string): string { return this.masked(pageWords(this.told(words, DIALOG_WORDS))) }
  /** Whether the page's DOMContentLoaded came at or after `at`, as a navigation's readiness wait asks. */
  domContentSince(at: number): boolean { return this.loadedAt.domContent >= at }
  /** Whether an agent's file chooser waits for `upload`. */
  choosing(): boolean { return this.chooser !== null }
  /** The colour scheme the page is told it has, or null for the computer's. */
  colorScheme(): BrowserAppearance | null { return this.appearance }
  async inspect(): Promise<string> {
    await this.ready()
    const result = await this.send('Accessibility.getFullAXTree') as { nodes?: AXNode[] }
    // What a field holds is not read out while the page holds a typed secret (`fieldContents`).
    const hidden = this.secretInDocument ? fieldContents(result.nodes ?? []) : new Set<string>()
    // Each name is masked before it is cut, and read far enough past the cut to be masked whole (`told`).
    const nodes = (result.nodes ?? []).filter(node => !node.ignored && !hidden.has(node.nodeId)).slice(0, 200).map(node => ({ role: String(node.role?.value ?? '').slice(0, 100), name: this.told(String(node.name?.value ?? ''), INSPECT_NAME), nodeId: node.backendDOMNodeId }))
    const dom = await this.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3')).slice(0,100).map(el => { const r=el.getBoundingClientRect(); return { tag:el.tagName.toLowerCase(), role:el.getAttribute('role')||'', name:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').slice(0,${INSPECT_ELEMENT_NAME + this.overread}), x:r.x,y:r.y,width:r.width,height:r.height, disabled:!!el.disabled }; })`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    const listed: unknown = dom.result?.value
    const elements = Array.isArray(listed) ? listed.map((element: unknown) => element && typeof element === 'object' ? { ...element, name: this.told(String((element as { name?: unknown }).name ?? ''), INSPECT_ELEMENT_NAME) } : element) : []
    const errors = this.errors.map(entry => ({ kind: entry.kind, message: this.told(entry.message, ERROR_WORDS) }))
    const output = JSON.stringify({ url: this.page.url(), nodes, elements, errors, truncated: (result.nodes?.length ?? 0) > 200 })
    return this.masked(output.length <= 200_000 ? output : JSON.stringify({ url: this.page.url(), nodes: nodes.slice(0, 100), errors: errors.slice(-10), truncated: true }))
  }
  /**
   * `text` with every secret typed into this page masked: as written, as JSON writes it, and however an address or a form
   * sent by GET escapes it (`maskSecrets`), so a sign-in form that puts the password in its address does not hand it on.
   * The page's own origin is left whole wherever it is written, since it is the site the page is shared for: a PIN that
   * is also the page's port, as 5173 on localhost:5173, masks the rest of an address and not the port. A secret shorter
   * than three characters is not masked, as one that short is as likely the page's own words; its page's rules hold all
   * the same. This never throws: should finding a secret ever fail, the whole text is the mask, and nothing of the
   * failure, which could hold the secret, goes on.
   */
  masked(text: string, origin?: string): string {
    if (!this.typedSecrets.size) return text
    try { return maskSecrets(text, this.matchers(), origin ?? this.origin()) } catch { return MASK }
  }
  /**
   * The page's words as the agent is told them, at most `max` characters: masked before they are cut, and a secret the
   * cut would split masked whole, so no cut leaves the start of one. Words the page itself cuts are read `overread`
   * past `max` for this. Never throws, as `masked`.
   */
  told(text: string, max: number): string {
    if (!this.typedSecrets.size) return text.slice(0, max)
    try { return maskSecrets(text, this.matchers(), this.origin(), max) } catch { return MASK }
  }
  /**
   * How much further than a cap the page's words are read while a secret is typed here, so a secret that starts before
   * the cap is read whole and masked (`told`). The longest a secret is written is fifteen characters to each of its
   * own: a character of three UTF-8 bytes, each escaped twice as `%25` and two hex digits.
   */
  private get overread(): number {
    let longest = 0
    for (const secret of this.typedSecrets.keys()) longest = Math.max(longest, secret.length)
    return longest * 15
  }
  /** The matcher for each secret typed here, each made once. */
  private matchers(): (SecretMatcher | null)[] {
    const matchers: (SecretMatcher | null)[] = []
    for (const [secret, known] of this.typedSecrets) {
      const matcher = known === undefined ? secretMatcher(secret) : known
      if (known === undefined) this.typedSecrets.set(secret, matcher)
      matchers.push(matcher)
    }
    return matchers
  }
  /** The page's own origin, which masking leaves whole, or nothing once the page is gone. */
  private origin(): string { return this.page.isGone() ? '' : originOf(this.page.url()) }
  /** An address as the agent and the window are told it: masked as the page's words are, with its own origin left whole. */
  maskedUrl(url: string): string { return this.masked(url, originOf(url)) }
  /**
   * The page as an agent reads it in the full catalog (ADR-0220): its address and title, the accessibility tree with a
   * ref on each element, the words on screen, and what its console and network said. Refs replace the last snapshot's.
   */
  async snapshotText(): Promise<string> {
    this.noDialog()
    await this.ready()
    const result = await this.send('Accessibility.getFullAXTree') as { nodes?: AXNode[] }
    // While the document holds a typed secret, what its fields hold is left out (`fieldContents`). Each name and value
    // is masked before it is put on one line and cut, as the whole snapshot is after.
    const formatted = formatSnapshot(result.nodes ?? [], undefined, this.secretInDocument, words => this.masked(words))
    this.refs = formatted.refs
    const read = await this.send('Runtime.evaluate', { expression: `({ title: document.title, text: document.body ? document.body.innerText.slice(0, ${SNAPSHOT_TEXT + this.overread}) : '', state: document.readyState })`, returnByValue: true }) as { result?: { value?: { title?: string; text?: string; state?: string } } }
    const page = read.result?.value ?? {}
    const sections = [
      `URL: ${this.page.url()}`, `Title: ${page.title ?? ''}`, `Ready state: ${page.state ?? 'unknown'}`,
      ...(this.dialogOpen ? [`Open dialog: ${this.dialogOpen.type}${this.secretInDocument ? '' : ` ${JSON.stringify(this.dialogWords(this.dialogOpen.message))}`}`] : []),
      ...(this.chooser ? ['A file chooser is open: answer it with upload and no target.'] : []),
      '', '## Accessibility tree (act on an element by its ref)', formatted.tree || '(empty)', ...(formatted.truncated ? ['(The tree is longer; scroll or use a selector for the rest.)'] : []),
      '', '## Visible text', this.told(String(page.text ?? ''), SNAPSHOT_TEXT),
      '', '## Console (latest last)', ...(this.consoleLog.length ? this.consoleLog.slice(-50).map(entry => `[${entry.level}] ${this.told(entry.text, CONSOLE_WORDS)}`) : ['(none)']),
      '', '## Errors (console and network)', ...(this.errors.length ? this.errors.map(entry => `[${entry.kind}] ${this.told(entry.message, ERROR_WORDS)}`) : ['(none)']),
    ]
    const said = this.masked(sections.join('\n'))
    return said.length > SNAPSHOT_TOTAL ? `${said.slice(0, SNAPSHOT_TOTAL)}\n(The snapshot was cut at ${SNAPSHOT_TOTAL} characters. Use wait_for, a selector or scroll for the rest.)` : said
  }
  /** A JavaScript expression run in the page (ADR-0220), its value said back as JSON, cut at `EVALUATE_LIMIT` and masked. */
  async evaluate(expression: string, awaitPromise = false): Promise<string> {
    this.noDialog()
    // Not only while the secret's document is open: its history and referrer keep an address a form sent it in, and a
    // site can write it back into a later document (a sign-in form filled again), so a script could read it back there.
    if (this.typedSecrets.size) return fail('blocked', `A secret you saved was typed into this page, so evaluate is off on it until it closes: its history keeps the addresses it went to, and a site can write the secret back into a later document. Use snapshot, click and type${this.inProfile ? '' : ', or open a new page'}.`)
    await this.ready()
    // From here the script may run, so no secret goes into this document: anything it left listening could take it.
    this.scriptedDocument = this.scriptedEver = true
    const result = await this.raceDialog(this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true })) as { result?: { type?: string; value?: unknown; description?: string; unserializableValue?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } } | 'dialog'
    if (result === 'dialog') return this.masked(`The page opened a ${this.dialogOpen?.type ?? 'dialog'} ${this.secretInDocument ? '' : `${JSON.stringify(this.dialogWords(this.dialogOpen?.message ?? ''))} `}while evaluating. Answer it with the dialog action.`)
    if (result.exceptionDetails) return this.masked(`Threw: ${(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'An error').slice(0, 4000)}`)
    const value = result.result
    const said = value?.type === 'undefined' ? 'undefined' : value?.unserializableValue ?? (value && 'value' in value ? JSON.stringify(value.value) ?? 'undefined' : value?.description ?? 'undefined')
    return this.masked(said.length > EVALUATE_LIMIT ? `${said.slice(0, EVALUATE_LIMIT)}… (cut at ${EVALUATE_LIMIT} characters)` : said)
  }
  /**
   * Waits for an element, words or an address (ADR-0220), looking every 100 ms until `timeoutMs`. Says how long it took,
   * or fails in words when it never came. On a page a secret was typed into, words and addresses are compared with it
   * masked, as the agent reads them, so a wait cannot test the secret a character at a time, and words are looked for
   * only in the visible text a snapshot carries.
   */
  async waitFor(action: Extract<BrowserAction, { type: 'wait_for' }>, guard: () => void): Promise<string> {
    this.noDialog()
    if (action.selector !== undefined) this.checkedSelector(action.selector)
    await this.ready()
    const timeout = action.timeoutMs ?? 5000, started = Date.now(), visible = (action.state ?? 'visible') === 'visible'
    const VISIBLE = 'function() { const element = this.nodeType === 1 ? this : this.parentElement; if (!element || !element.isConnected) return false; const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== \'hidden\' && style.display !== \'none\' }'
    const check = async (): Promise<boolean> => {
      if (action.urlIncludes !== undefined) {
        const href = await this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }) as { result?: { value?: unknown } }
        return this.masked(String(href.result?.value ?? this.page.url())).includes(action.urlIncludes) === visible
      }
      // Only the visible text a snapshot carries is read, `SNAPSHOT_TEXT` and the overread, not the whole of a long page
      // every 100 ms.
      if (action.text !== undefined && this.typedSecrets.size) {
        const words = await this.send('Runtime.evaluate', { expression: `document.body ? document.body.innerText.slice(0, ${SNAPSHOT_TEXT + this.overread}) : ''`, returnByValue: true }) as { result?: { value?: unknown } }
        return this.told(String(words.result?.value ?? ''), SNAPSHOT_TEXT).includes(action.text) === visible
      }
      if (action.text !== undefined) {
        const found = await this.send('Runtime.evaluate', { expression: `!!document.body && document.body.innerText.includes(${JSON.stringify(action.text)})`, returnByValue: true }) as { result?: { value?: unknown } }
        return (found.result?.value === true) === visible
      }
      let objectId: string | undefined
      if (action.ref !== undefined) {
        const backendNodeId = this.refs.get(action.ref)
        if (backendNodeId === undefined) return fail('blocked', `${action.ref} is not in your latest snapshot. Take a snapshot and use its refs.`)
        const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 'sotto-browser-wait' }).catch(() => ({})) as { object?: { objectId?: string } }
        objectId = resolved.object?.objectId
      } else {
        const found = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(action.selector)})`, objectGroup: 'sotto-browser-wait' }) as { result?: { objectId?: string }; exceptionDetails?: unknown }
        if (found.exceptionDetails) return fail('invalid-request', 'That selector is not valid CSS.')
        objectId = found.result?.objectId
      }
      try {
        if (!objectId) return !visible
        const shown = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: VISIBLE, returnByValue: true }) as { result?: { value?: unknown } }
        return (shown.result?.value === true) === visible
      } finally { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-wait' }).catch(() => undefined) }
    }
    for (;;) {
      guard()
      // A navigation mid-check loses the page's context; the next look tries again in the new one.
      const met = await check().catch((error: unknown) => { if (error instanceof ToolFailure && error.code !== 'unavailable') throw error; return false })
      if (met) return `Seen after ${Date.now() - started} ms.`
      if (this.dialogOpen) return fail('blocked', `The page opened a ${this.dialogOpen.type} dialog while waiting. Answer it with the dialog action.`)
      if (Date.now() - started >= timeout) return fail('blocked', `Not ${visible ? 'seen' : 'gone'} within ${timeout} ms. Take a snapshot to see the page as it is.`)
      await new Promise(resolve => setTimeout(resolve, WAIT_POLL_MS))
    }
  }
  /** Answers the page's open dialog: OK or Cancel, with a prompt's text (ADR-0220). */
  async answerDialog(accept: boolean, promptText?: string): Promise<BrowserDialog> {
    const open = this.dialogOpen
    if (!open) return fail('blocked', 'No dialog is open on this page.')
    await this.ready()
    await this.send('Page.handleJavaScriptDialog', { accept, ...(promptText !== undefined && open.type === 'prompt' ? { promptText } : {}) })
    if (this.dialogOpen === open) this.dialogOpen = null
    this.onChange?.()
    return { type: open.type, message: this.dialogWords(open.message), ...(open.defaultPrompt !== undefined ? { defaultPrompt: this.dialogWords(open.defaultPrompt) } : {}) }
  }
  /** What the agent asked about, so the answer reaches only that dialog or chooser. */
  private pendingKey(kind: 'dialog' | 'chooser'): string {
    if (kind === 'dialog') return this.dialogOpen ? `dialog:${this.dialogOpen.seq}` : fail('blocked', 'No dialog is open on this page.')
    return this.chooser ? `chooser:${this.chooser.seq}` : fail('blocked', 'No file chooser is open. Name the file input by ref or selector, or click it first.')
  }
  /** The page's colour scheme (ADR-0220): light, dark, no preference, or null for the computer's again. */
  async emulateAppearance(scheme: BrowserAppearance | null): Promise<void> {
    await this.ready()
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme ?? '' }] })
    this.appearance = scheme
  }
  /**
   * Gives a file input files from this computer (ADR-0220): the input named, or the file chooser an agent's click
   * opened. `paths` are already checked to be the thread's; none clears the input, which is how a chooser is cancelled.
   */
  async upload(target: BrowserTargetFields, paths: readonly string[], guard: () => void): Promise<string> {
    this.noDialog()
    await this.ready()
    guard()
    let backendNodeId: number
    if (target.x === undefined && target.ref === undefined && target.selector === undefined) {
      const chooser = this.chooser ?? fail('blocked', 'No file chooser is open. Name the file input by ref or selector.')
      if (!chooser.multiple && paths.length > 1) return fail('blocked', 'This file chooser takes one file.')
      backendNodeId = chooser.backendNodeId
      this.chooser = null
      this.interceptUntil = 0
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined)
      this.onChange?.()
    } else {
      backendNodeId = await this.nodeOf(target)
      const node = await this.send('DOM.describeNode', { backendNodeId }) as { node?: { nodeName?: string; attributes?: string[] } }
      // CDP gives attributes as one flat list of names and values: a value can be the word "type" too.
      if (node.node?.nodeName !== 'INPUT' || attributeOf(node.node.attributes, 'type')?.toLowerCase() !== 'file') return fail('blocked', 'That element is not a file input. Snapshot the page and name an <input type="file">.')
    }
    await this.send('DOM.setFileInputFiles', { files: [...paths], backendNodeId })
    return paths.length ? `Gave the input ${paths.length} file${paths.length === 1 ? '' : 's'}.` : 'Cleared the file input.'
  }
  /**
   * Pictures of the page as it draws, for a recording (ADR-0220). Chromium sends one each time the page changes, each a
   * JPEG at most 1280 pixels on a side; they stop with `stopScreencast` or the page.
   */
  async startScreencast(onFrame: (data: string) => void): Promise<void> {
    this.noDialog()
    // A page can show what its password field holds (a "show password" button), so no recording starts on one that holds a secret.
    if (this.secretInDocument) return fail('blocked', 'This page holds a secret you saved, so it is not recorded until it loads another document. Use snapshot, whose words are masked.')
    await this.ready()
    this.screencast = onFrame
    // A recording that did not start leaves the page not recording, so it does not refuse a secret for one.
    try { await this.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 }) } catch (error) {
      if (this.screencast === onFrame) this.screencast = null
      throw error
    }
  }
  async stopScreencast(): Promise<void> {
    if (!this.screencast) return
    this.screencast = null
    if (this.page.isGone() || !this.page.isAttached()) return
    await this.send('Page.stopScreencast').catch(() => undefined)
  }
  /** Most actions cannot run while the page has a dialog open; it holds the page's script until answered. */
  private noDialog(): void {
    if (!this.dialogOpen) return
    // The page's words are masked, and left out while the document holds a secret, since its script could copy the value into them.
    const words = this.secretInDocument ? '' : `: ${JSON.stringify(this.dialogWords(this.dialogOpen.message).slice(0, 300))}`
    fail('blocked', `The page has a ${this.dialogOpen.type} dialog open${words}. Answer it with the dialog action first.`)
  }
  /** A command that a dialog opening interrupts: the page waits for the dialog, so the command returns once it is answered. */
  private async raceDialog<T>(command: Promise<T>): Promise<T | 'dialog'> {
    if (!this.parity) return command
    let waiter: (() => void) | undefined
    const opened = new Promise<'dialog'>(resolve => { waiter = () => resolve('dialog'); this.dialogWaiters.add(waiter) })
    command.catch(() => undefined)
    try { return await Promise.race([command, opened]) } finally { this.dialogWaiters.delete(waiter!) }
  }
  /**
   * `selector`, unless it compares part of an attribute (`^=`, `*=` and the like) on a page a secret was typed into: a
   * site that copies the field's value into an attribute, as some forms do, would answer it a character at a time.
   */
  private checkedSelector(selector: string): string {
    if (this.typedSecrets.size && comparesPartOfAttribute(selector)) fail('blocked', 'A secret you saved was typed into this page, so a selector here cannot match part of an attribute (^=, $=, *=, ~= or |=), which could spell the secret out. Use a ref from snapshot, or a whole value as in [name="email"].')
    return selector
  }
  /** The DOM node a ref or a selector names (ADR-0220), or a refusal that says what to do instead. */
  private async nodeOf(target: BrowserTargetFields): Promise<number> {
    if (target.ref !== undefined) {
      const backendNodeId = this.refs.get(target.ref)
      if (backendNodeId === undefined) return fail('blocked', `${target.ref} is not in your latest snapshot. Take a snapshot and use its refs.`)
      return backendNodeId
    }
    if (target.selector === undefined) return fail('invalid-request', 'Name the element by ref or selector.')
    const found = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(this.checkedSelector(target.selector))})`, objectGroup: 'sotto-browser-node' }) as { result?: { objectId?: string; subtype?: string }; exceptionDetails?: unknown }
    try {
      if (found.exceptionDetails) return fail('invalid-request', 'That selector is not valid CSS.')
      if (!found.result?.objectId || found.result.subtype === 'null') return fail('blocked', 'Nothing on the page matches that selector. Take a snapshot to see what is there.')
      const described = await this.send('DOM.describeNode', { objectId: found.result.objectId }) as { node?: { backendNodeId?: number } }
      return described.node?.backendNodeId ?? fail('blocked', 'Nothing on the page matches that selector.')
    } finally { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-node' }).catch(() => undefined) }
  }
  /**
   * Where input for an element lands: its middle, scrolled into view, checked to be the element itself (or a label for
   * it) and not something drawn over it.
   */
  private async pointOfNode(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    const quads = await this.send('DOM.getContentQuads', { backendNodeId }).catch(() => ({ quads: [] })) as { quads?: number[][] }
    const quad = quads.quads?.find(entry => entry.length >= 8 && Math.abs((entry[2]! - entry[0]!) * (entry[5]! - entry[1]!)) >= 1)
    if (!quad) return fail('blocked', 'That element takes no space on the page, so nothing can reach it. Take a snapshot and choose another.')
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    const viewport = await this.visibleViewport()
    if (x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight) return fail('blocked', 'That element is outside the visible page even after scrolling. Scroll its container, then try again.')
    const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 'sotto-browser-hit' }) as { object?: { objectId?: string } }
    try {
      const objectId = resolved.object?.objectId ?? fail('blocked', 'That element is gone. Take a snapshot and try again.')
      const hit = await this.send('Runtime.callFunctionOn', { objectId, returnByValue: true, arguments: [{ value: x }, { value: y }],
        functionDeclaration: 'function(x, y) { const root = this.getRootNode(); const at = (root && root.elementFromPoint ? root : document).elementFromPoint(x, y); if (!at) return false; if (at === this || (this.contains && this.contains(at))) return true; const label = at.closest && at.closest(\'label\'); return !!label && label.control === this }' }) as { result?: { value?: unknown } }
      if (hit.result?.value !== true) return fail('blocked', 'Something else is drawn over that element at its middle. Take a screenshot, then close what covers it or use another target.')
    } finally { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-hit' }).catch(() => undefined) }
    return { x: Math.round(x), y: Math.round(y) }
  }
  /** The point an action names, directly or through its element. */
  private async pointOf(target: BrowserTargetFields): Promise<{ x: number; y: number }> {
    if (target.x !== undefined && target.y !== undefined) return { x: target.x, y: target.y }
    return this.pointOfNode(await this.nodeOf(target))
  }
  /**
   * Types a secret request's value into a password field (ADR-0219): the one a ref or selector names, focused first, or
   * the focused one. The field was checked when the action was asked for, and again here: right before the value goes,
   * the page's focused element must be that password field and its document at `origin`, the site the value is for, or
   * nothing is typed. `take` gives the value only then, so a refusal before it spends nothing (the reference stays for
   * another try), and the page is looked at once more after it, since the value comes from the engine and the page may
   * have moved meanwhile. Nothing is typed into a document the agent ran its own script in, or while the page records. `clear`
   * replaces what the field held. The value is remembered only to mask it in what the page says back, and forgotten
   * with the page.
   */
  async typeSecret(take: () => Promise<string | null>, guard: () => void, target: BrowserTargetFields = {}, clear = false, origin?: string): Promise<void> {
    this.noDialog()
    this.secretMayGo()
    await this.ready()
    guard()
    const named = target.ref !== undefined || target.selector !== undefined ? await this.nodeOf(target) : null
    if (named !== null) {
      await this.passwordField(named)
      await this.send('DOM.focus', { backendNodeId: named })
    }
    const field = await this.focusedPassword(named)
    // Typed beside a secret already there, this one could split it where the caret was, and neither half is masked.
    if (!clear && await this.fieldHoldsSecret(field)) return fail('blocked', 'This password field already holds a secret you saved. Type this secretRef with clear: true, which replaces it.')
    if (clear) await this.selectAll()
    guard()
    // The last look: a page script could have moved the focus while the field was being focused or cleared, and the
    // document could have been replaced by one at another site.
    if (await this.focusedPassword(field) !== field) return fail('blocked', 'The password field lost focus. Nothing was typed.')
    if (origin !== undefined && await this.documentOrigin() !== origin) return fail('blocked', `This page is no longer on ${origin}, the site this secret is for. Nothing was typed.`)
    this.secretMayGo()
    guard()
    const value = await take() ?? fail('blocked', 'This secretRef is unknown, used or expired. Ask for it again with request_secret.')
    // The value crossed to the engine and back: the page had that long to move the focus or load another site. From
    // here the reference is spent, so whatever stops the typing says so, a check's own words first.
    try {
      guard()
      this.secretMayGo()
      if (await this.focusedPassword(field).catch(() => null) !== field) fail('blocked', 'The password field lost focus.')
      if (origin !== undefined && await this.documentOrigin() !== origin) fail('blocked', `This page is no longer on ${origin}, the site this secret is for.`)
      guard()
    } catch (error) { return fail(error instanceof ToolFailure ? error.code : 'blocked', `${sentenceOf(error)} Nothing was typed, and ${SECRET_SPENT}`) }
    // Its matcher is made when something is first masked, where a failure masks everything rather than going on.
    if (!this.typedSecrets.has(value)) this.typedSecrets.set(value, undefined)
    this.secretInDocument = true
    try { await this.send('Input.insertText', { text: value }) } catch (error) {
      // Whether the page took any of it is not known, so the document is still taken to hold it.
      return fail(error instanceof ToolFailure ? error.code : 'unavailable', `${sentenceOf(error)} The secret may not have been typed, and ${SECRET_SPENT}`)
    }
  }
  /** Refuses a secret where something of the agent's could catch it: a document it ran script in, or a recording. */
  private secretMayGo(): void {
    if (this.scriptedDocument) fail('blocked', 'You ran a script in this page, and it could still be listening, so a secret is not typed into it. Load the sign-in page again with navigate, then type it without evaluating first.')
    if (this.screencast) fail('blocked', 'This page is recording, and a recording could show the secret. Stop it with record_stop, then type it.')
  }
  /** The origin of the main frame's document as the page itself has it. `location` cannot be redefined by page script. */
  private async documentOrigin(): Promise<string | null> {
    const found = await this.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }) as { result?: { value?: unknown } }
    return typeof found.result?.value === 'string' ? found.result.value : null
  }
  /** Refuses a node that is not an `<input type="password">` the page masks. */
  private async passwordField(backendNodeId: number): Promise<void> {
    const described = await this.send('DOM.describeNode', { backendNodeId, depth: 1, pierce: true }) as { node?: { nodeName?: string; attributes?: string[]; shadowRoots?: { shadowRootType?: string }[] } }
    const node = described.node
    if (node?.nodeName !== 'INPUT' || attributeOf(node.attributes, 'type')?.toLowerCase() !== 'password' || node.shadowRoots?.some(root => root.shadowRootType !== 'user-agent')) {
      return fail('blocked', 'A secretRef is typed only into a password field, which the page masks. Name a password field, or click one, then type it.')
    }
  }
  /** The page's focused element, which must be a password field, and `expected` when one is given. Nothing is typed otherwise. */
  private async focusedPassword(expected: number | null): Promise<number> {
    const focused = await this.send('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'sotto-browser-secret' }) as { result?: { objectId?: string; subtype?: string } }
    const objectId = focused.result?.objectId
    if (!objectId || focused.result?.subtype === 'null') return fail('blocked', 'Nothing on the page has focus. Nothing was typed.')
    const described = await this.cleaningUp(() => this.send('DOM.describeNode', { objectId }), () => this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-secret' })) as { node?: { backendNodeId?: number } }
    const backendNodeId = described.node?.backendNodeId ?? fail('blocked', 'Nothing on the page has focus. Nothing was typed.')
    if (expected !== null && backendNodeId !== expected) return fail('blocked', 'The password field named did not take the focus. Nothing was typed.')
    await this.passwordField(backendNodeId)
    return backendNodeId
  }
  /**
   * A new document committed in the main frame: the one that held a typed secret is gone (ADR-0220, decision 6), and so
   * is any script the agent ran in it.
   */
  documentCommitted(): void {
    this.secretInDocument = false
    this.scriptedDocument = false
  }
  /**
   * The back-forward cache gave back an earlier document, script and field values as they were. Which one is not known
   * here, so it is taken as one the agent scripted, if it scripted any, and one a secret was typed into, if one was.
   */
  documentRestored(): void {
    if (this.scriptedEver) this.scriptedDocument = true
    if (this.typedSecrets.size) this.secretInDocument = true
  }
  /** Whether the document loaded now holds a secret typed from a secret request, so no picture of it goes to the agent. */
  holdsSecret(): boolean { return this.secretInDocument }
  /** Refuses, while the document holds a typed secret, an action that would select, copy, cut or carry text (`movesText`). */
  private textStays(action: TargetedAction | PageInput): void {
    const what = this.secretInDocument ? movesText(action) : null
    if (what) fail('blocked', `This page holds a secret you saved, so ${what} is refused until it loads another document: it could select, copy or carry the secret where you can read it. Click once, and press keys without Shift, Control or Command.`)
  }
  /**
   * Refuses an edit to a field that holds a typed secret, for the page's life: typing into it, or any key but one that
   * submits it or moves the focus or the caret. What an edit left could be part of the secret, which no mask finds, for
   * a form to send in its address or a later snapshot to read. Typing a secretRef with `clear` replaces the whole of it,
   * so that goes. `backendNodeId` is the field the edit reaches, or none for the focused one.
   */
  private async noSecretEdit(action: TargetedAction | PageInput, backendNodeId?: number): Promise<void> {
    const edits = action.type === 'key' ? !NON_EDITING_KEYS.has(action.key) : action.type === 'type' && !(action.secretRef && action.clear)
    if (edits && await this.fieldHoldsSecret(backendNodeId)) fail('blocked', 'The field this reaches holds a secret you saved, so nothing is typed into it and no key edits it: what was left could be part of the secret, which no mask finds. Enter, Tab, Escape and the keys that move the caret still work. To type a secret into it again, use a secretRef with clear: true.')
  }
  /**
   * Whether the field `backendNodeId` names, or the focused one, holds a secret typed into this page, in the text an edit
   * there would change. The text is read here and never said back. One Sotto cannot check, as masking it failed, counts
   * as holding one.
   */
  private async fieldHoldsSecret(backendNodeId?: number): Promise<boolean> {
    if (!this.typedSecrets.size) return false
    let text: unknown
    if (backendNodeId === undefined) {
      const read = await this.send('Runtime.evaluate', { expression: `(${FIELD_TEXT}).call(document.activeElement || document.body)`, returnByValue: true }) as { result?: { value?: unknown } }
      text = read.result?.value
    } else {
      const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 'sotto-browser-field' }) as { object?: { objectId?: string } }
      const objectId = resolved.object?.objectId
      text = objectId ? await this.cleaningUp(async () => {
        const read = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: FIELD_TEXT, returnByValue: true }) as { result?: { value?: unknown } }
        return read.result?.value
      }, () => this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-field' })) : ''
    }
    return typeof text === 'string' && text !== '' && this.masked(text, '') !== text
  }
  /**
   * One picture of the page as Chromium drew it, within the snapshot deadline. `rect` is in the visual viewport's CSS
   * pixels. PNG at full size by default; a JPEG at a smaller `scale` is what a host makes its smaller pictures from,
   * since it has no image library of its own.
   */
  protected async snapshot(rect?: BrowserBounds, encoding: PageEncoding = { format: 'png', scale: 1 }, fullPage = false): Promise<PageFrame> {
    const release = this.prepareCapture()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Giving up ends the attachment too, so the abandoned capture's commands cannot cut into the next action.
      return await Promise.race([this.frame(rect, encoding, fullPage), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.reset(); reject(new ToolFailure('unavailable', 'The page did not draw in time. Inspect it before trying again.')) }, 10_000) })])
    } finally { if (timer) clearTimeout(timer); release() }
  }
  /** The part of the page on screen, in CSS pixels, and how far down the document it sits; a screenshot is this. */
  private async visibleViewport(): Promise<{ pageX: number; pageY: number; clientWidth: number; clientHeight: number }> {
    const layout = await this.send('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }
    const viewport = layout.cssVisualViewport
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) return fail('unavailable', 'This page has not drawn yet. Wait for it to load, then try again.')
    return viewport
  }
  private async frame(rect: BrowserBounds | undefined, encoding: PageEncoding, fullPage = false): Promise<PageFrame> {
    await this.ready()
    // The agent's cursor is Sotto's, not the page's: no picture of the page shows it (ADR-0222). It comes back after,
    // as the picture each action ends with would otherwise take it away as soon as it arrived.
    const showing = this.cursorShown ? this.cursorAt : null
    await this.hideCursor()
    try { return await this.drawn(rect, encoding, fullPage) } finally {
      if (showing && this.cursorAt === showing && this.cursorOn()) await this.drawCursor(showing).then(() => this.lingerCursor(), () => undefined)
    }
  }
  private async drawn(rect: BrowserBounds | undefined, encoding: PageEncoding, fullPage: boolean): Promise<PageFrame> {
    const viewport = await this.visibleViewport()
    if (fullPage) {
      // The whole document from its top, up to 8192 pixels tall, as wide as the page shows it.
      const layout = await this.send('Page.getLayoutMetrics') as { cssContentSize?: { width: number; height: number } }
      const width = Math.round(viewport.clientWidth), height = Math.min(8192, Math.round(layout.cssContentSize?.height ?? viewport.clientHeight))
      const whole = await this.send('Page.captureScreenshot', { format: encoding.format, fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: encoding.scale } }) as { data?: string }
      if (!whole.data) return fail('unavailable', 'The page could not be captured. Try again.')
      return { data: whole.data, format: encoding.format, width: Math.round(width * encoding.scale), height: Math.round(height * encoding.scale) }
    }
    const width = Math.round(rect?.width ?? viewport.clientWidth), height = Math.round(rect?.height ?? viewport.clientHeight)
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return fail('too-large', 'This page is too large to capture. Set a smaller viewport, then try again.')
    if (rect && (rect.x + rect.width > viewport.clientWidth || rect.y + rect.height > viewport.clientHeight)) return fail('blocked', 'This selection extends beyond the captured page.')
    // Capture the logical viewport even when its native pane is smaller or detached.
    // Normalize DPR so screenshot coordinates and CDP input use the same CSS pixels.
    const result = await this.send('Page.captureScreenshot', { format: encoding.format, ...(encoding.format === 'jpeg' ? { quality: encoding.quality } : {}), fromSurface: true, captureBeyondViewport: true, clip: { x: viewport.pageX + (rect?.x ?? 0), y: viewport.pageY + (rect?.y ?? 0), width, height, scale: encoding.scale } }) as { data?: string }
    if (!result.data) return fail('unavailable', 'The page could not be captured. Try again.')
    return { data: result.data, format: encoding.format, width: Math.round(width * encoding.scale), height: Math.round(height * encoding.scale) }
  }
  /** A picture as the caller keeps it: whether it holds anything, its size, and its data URL. */
  protected abstract picture(frame: PageFrame): PagePicture
  /** The smaller pictures a task keeps of an agent's screenshot (`EVIDENCE_PICTURES`), or null when none fits. */
  abstract evidence(capture: BrowserCapture): PageEvidence | null | Promise<PageEvidence | null>
  /** A small JPEG of the page for its task, from `image` when the caller has one. */
  abstract thumbnail(image?: string): Promise<string | null>
  async elementAt(point: { x: number; y: number }): Promise<{ element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } | null> {
    await this.ready()
    const expression = `(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); if (!el) return null; const r=el.getBoundingClientRect(); return { element: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0,${ELEMENT_NAME + this.overread}), text: (el.innerText || '').slice(0,${ELEMENT_TEXT + this.overread}), id: el.id || '' }, bounds: { x:r.x, y:r.y, width:r.width, height:r.height } }; })()`
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: { element: Record<'tag' | 'role' | 'name' | 'text' | 'id', unknown>; bounds: BrowserBounds } } }
    const found = result.result?.value
    if (!found) return null
    // A comment on the page goes into the user's message to the agent, so the element's words are masked before they
    // are cut, as the agent's own reads are, and its id before it is written as a selector.
    const { element } = found, tag = String(element.tag ?? ''), id = String(element.id ?? '')
    return { element: { tag, role: this.masked(String(element.role ?? '')), name: this.told(String(element.name ?? ''), ELEMENT_NAME), text: this.told(String(element.text ?? ''), ELEMENT_TEXT), selector: id ? `#${cssIdentifier(this.masked(id))}` : tag }, bounds: found.bounds }
  }
  async capture(url: string, point?: { x: number; y: number }, region?: BrowserBounds, fullPage = false): Promise<BrowserCapture> {
    this.noDialog()
    const element = point ? (await this.elementAt(point))?.element ?? null : null
    const rect = region ? Object.fromEntries(Object.entries(region).map(([key, value]) => [key, Math.round(value)])) as BrowserBounds : undefined
    const snapshot = this.picture(await this.snapshot(rect, undefined, fullPage))
    if (snapshot.empty) return fail('unavailable', 'This page has not drawn yet. Wait for it to load, then try again.')
    const image = snapshot.dataUrl
    if (image.length > 16_000_000) return fail('too-large', 'This page is too large to capture. Set a smaller viewport, then try again.')
    return { image, url, width: snapshot.width, height: snapshot.height, element }
  }
  /**
   * The node a click or tap at a point in the screenshot lands on. The point is in the visible viewport, as screenshots
   * and input are, but Chromium hit-tests `DOM.getNodeForLocation` in the document, so the point moves by how far the
   * page has scrolled. Without that, every click on a scrolled page tested a node above the one it would press, and one
   * above the visible area came back as a protocol error the agent could only read as the tool breaking. The point is
   * rounded as `dispatch` rounds it, so what is checked is what is sent. Chromium takes only whole pixels here, so on a
   * page zoomed away from 1, whose scroll can be fractional, the check can name the neighbour of an element at its edge.
   */
  private async nodeAt(point: { x: number; y: number }): Promise<number | undefined> {
    const viewport = await this.visibleViewport()
    const width = Math.round(viewport.clientWidth), height = Math.round(viewport.clientHeight)
    const x = Math.round(point.x), y = Math.round(point.y)
    if (x >= width || y >= height) return fail('blocked', `That point is outside the page's visible area, which is ${width} by ${height}. Take a screenshot and use its coordinates.`)
    const located = await this.send('DOM.getNodeForLocation', { x: Math.round(viewport.pageX + x), y: Math.round(viewport.pageY + y), includeUserAgentShadowDOM: true })
      .catch((error: unknown) => error instanceof Error && /no node found/iu.test(error.message) ? fail('blocked', 'Nothing on the page is at that point. Take a screenshot and use its coordinates.') : Promise.reject(error)) as { backendNodeId?: number }
    return located.backendNodeId
  }
  /** What a click, tap, typed entry or key press would reach: the node at its point, or the focused node. */
  async target(action: TargetedAction): Promise<string> {
    if (action.type === 'dialog') return this.pendingKey('dialog')
    this.noDialog()
    this.textStays(action)
    await this.ready()
    if (action.type === 'upload' && action.x === undefined && action.ref === undefined && action.selector === undefined) return this.pendingKey('chooser')
    if (action.type === 'drag') return `${await this.describeTarget(action.from)} -> ${await this.describeTarget(action.to)}`
    if (action.type === 'select' || action.type === 'upload') return this.describeTarget(action)
    let backendNodeId: number | undefined
    if ((action.type === 'click' || action.type === 'type') && (action.ref !== undefined || action.selector !== undefined)) {
      backendNodeId = await this.nodeOf(action)
    } else if (action.type === 'click' || action.type === 'tap') {
      backendNodeId = await this.nodeAt({ x: action.x!, y: action.y! })
    } else {
      const focused = await this.send('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'sotto-browser-target' }) as { result?: { objectId?: string } }
      if (!focused.result?.objectId) return fail('blocked', 'Nothing on the page has focus. Click a text field, then type.')
      const objectId = focused.result.objectId
      const described = await this.cleaningUp(() => this.send('DOM.describeNode', { objectId }), () => this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-target' })) as { node?: { backendNodeId?: number } }
      backendNodeId = described.node?.backendNodeId
    }
    if (!backendNodeId) return fail('blocked', 'Nothing on the page is at that point. Inspect the page and use its coordinates.')
    // Refused before the user is asked, as it would be when it ran.
    if (action.type === 'key' || action.type === 'type') await this.noSecretEdit(action, backendNodeId)
    const result = await this.send('DOM.describeNode', { backendNodeId, depth: 1, pierce: true }) as { node?: { nodeName?: string; attributes?: string[]; shadowRoots?: { shadowRootType?: string }[] } }
    if (action.type === 'type') {
      const node = result.node
      const attributes = new Map<string, string>()
      for (let index = 0; index < (node?.attributes?.length ?? 0); index += 2) attributes.set(node!.attributes![index]!, node!.attributes![index + 1] ?? '')
      const nativeInput = node?.nodeName === 'TEXTAREA' || (node?.nodeName === 'INPUT' && ['text', 'search', 'email', 'number', 'tel', 'url', 'password'].includes(attributes.get('type') ?? 'text'))
      const editable = ['true', 'plaintext-only', ''].includes(attributes.get('contenteditable') ?? 'false')
      // Top-level activeElement can be an iframe or a closed-shadow host while
      // insertText targets an unseen focused descendant. Do not approve that proxy.
      if ((!nativeInput && !editable) || node?.shadowRoots?.some(root => root.shadowRootType !== 'user-agent')) return fail('blocked', 'Typing goes only into a plain text field with focus, and the focused element is not one (it may be a frame or a closed custom element). Click a plain text field, then type.')
      // A secret goes only where the page masks it, so no screenshot shows it to the agent (ADR-0219).
      if (action.secretRef && (node?.nodeName !== 'INPUT' || attributes.get('type') !== 'password')) return fail('blocked', 'A secretRef is typed only into a password field, which the page masks. Click a password field, then type it.')
      // Refused before the user is asked, as it would be when it ran.
      if (action.secretRef) this.secretMayGo()
    }
    return JSON.stringify(result.node).slice(0, 16_000)
  }
  /** A target as the approval records it: the node at a point, or the node a ref or selector names. */
  private async describeTarget(target: BrowserTargetFields): Promise<string> {
    const backendNodeId = target.x !== undefined && target.y !== undefined ? await this.nodeAt({ x: target.x, y: target.y }) : await this.nodeOf(target)
    if (!backendNodeId) return fail('blocked', 'Nothing on the page is at that point. Take a snapshot and use its refs.')
    const result = await this.send('DOM.describeNode', { backendNodeId, depth: 0 }) as { node?: unknown }
    return JSON.stringify(result.node).slice(0, 8000)
  }
  /**
   * Chromium answers a wheel or touch event only once the page draws a frame, and a page that is not on screen
   * draws none, so input borrows the surface a capture borrows. Without it a scroll, tap or swipe on a hidden page
   * waited until someone showed the page.
   *
   * Chromium acknowledges a wheel or touch event before the page has moved, so a scroll, swipe or tap waits, still
   * holding the surface, until the page has drawn twice. Without it a click straight after a scroll was checked
   * against where the page had been and pressed what scrolled into that place.
   */
  async input(action: PageInput, guard: () => void): Promise<string | undefined> {
    this.noDialog()
    this.textStays(action)
    await this.ready()
    // The focus may have moved since the action was asked for, so the field it reaches is looked at again.
    if (action.type === 'key' || action.type === 'type') await this.noSecretEdit(action, action.type === 'type' && (action.ref !== undefined || action.selector !== undefined) ? await this.nodeOf(action) : undefined)
    if (action.type === 'tap' && this.secretInDocument) {
      const wait = this.tappedAt + DOUBLE_TAP_GAP_MS - Date.now()
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    }
    guard()
    const release = this.prepareCapture()
    let intercepting = false
    try {
      // An agent's click or key may open a file chooser; it is held for `upload` instead of shown (ADR-0220).
      if (this.parity && (action.type === 'click' || action.type === 'tap' || (action.type === 'key' && (action.key === 'Enter' || action.key === 'Space' || action.key === ' ')))) {
        this.interceptUntil = Date.now() + 60_000
        intercepting = true
        await this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined)
      }
      const outcome = await this.raceDialog(this.dispatch(action))
      const opened = (): string | undefined => this.dialogOpen
        ? `The page opened a ${this.dialogOpen.type} dialog${this.secretInDocument ? '' : `: ${JSON.stringify(this.dialogWords(this.dialogOpen.message))}`}. Answer it with the dialog action.`
        : this.chooser ? 'The page opened a file chooser. Answer it with upload and the files, or paths: [] to cancel.' : undefined
      if (outcome === 'dialog' && opened()) return opened()
      if (action.type === 'scroll' || action.type === 'swipe' || action.type === 'tap' || action.type === 'hover' || action.type === 'drag') await this.raceDialog(this.settled())
      // The chooser's news comes a moment after the click that opened it.
      if (intercepting && !opened()) await this.raceDialog(new Promise(resolve => setTimeout(resolve, CHOOSER_GRACE_MS)))
      if (opened()) return opened()
      return typeof outcome === 'string' ? outcome : undefined
    } finally {
      // Unless a chooser waits for `upload`, the user's own clicks open the system's again, whatever ended the action:
      // a failure or Pause included. A dialog the action opened holds the page, and a command sent now would wait in
      // front of its answer, so the chooser is given back once the dialog closes.
      if (intercepting && !this.chooser && !this.dialogOpen) await this.stopIntercepting()
      release()
    }
  }
  private async stopIntercepting(): Promise<void> {
    this.interceptUntil = 0
    if (this.page.isGone() || !this.page.isAttached()) return
    await this.page.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined)
  }
  /**
   * Two frames, or half a second if the page draws none, as a headless page may not. Best effort: a tap that starts
   * a navigation takes the page's context with it, and the action itself has already happened.
   */
  private async settled(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: SETTLE_EXPRESSION, awaitPromise: true }).catch(() => undefined)
  }
  private async dispatch(action: PageInput): Promise<string | undefined> {
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => this.send(method, params)
    if (action.type === 'tap') {
      await this.moveCursor({ x: action.x, y: action.y })
      // Start and end are one operation, as a click's press and release are.
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(action.x), y: Math.round(action.y) }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      this.tappedAt = Date.now()
      this.markClick({ x: action.x, y: action.y })
    } else if (action.type === 'swipe') {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(action.x), y: Math.round(action.y) }] })
      await this.cleaningUp(async () => {
        for (let step = 1; step <= SWIPE_STEPS; step++) {
          const x = action.x + (action.toX - action.x) * step / SWIPE_STEPS, y = action.y + (action.toY - action.y) * step / SWIPE_STEPS
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x), y: Math.round(y) }] })
        }
      }, () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }))
    } else if (action.type === 'key') {
      for (const event of keyEvents(action.key, action.modifiers ?? [])) await send('Input.dispatchKeyEvent', event)
    } else if (action.type === 'click') {
      const { x, y } = await this.pointOf(action)
      await this.moveCursor({ x, y })
      const button = action.button ?? 'left', held = action.modifiers?.length ? { modifiers: modifierMask(action.modifiers) } : {}
      // The full catalog moves the pointer there first, so the page sees it arrive as a person's would.
      if (this.parity) await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), ...held })
      for (let count = 1; count <= (action.clickCount ?? 1); count++) {
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button, clickCount: count, ...held })
        // Press/release is one operation. Always release when Pause arrives mid-click.
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button, clickCount: count, ...held })
      }
      this.markClick({ x, y })
    } else if (action.type === 'hover') {
      const { x, y } = await this.pointOf(action)
      await this.moveCursor({ x, y })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y) })
    } else if (action.type === 'type') {
      if (action.text === undefined) return fail('blocked', 'Pass the text to type.')
      if (action.ref !== undefined || action.selector !== undefined) await this.send('DOM.focus', { backendNodeId: await this.nodeOf(action) })
      if (action.clear) await this.selectAll()
      if (action.text === '' && action.clear) for (const event of keyEvents('Delete')) await this.send('Input.dispatchKeyEvent', event)
      else await this.send('Input.insertText', { text: action.text })
    } else if (action.type === 'scroll') {
      // An element named by ref or selector scrolls its own container directly. A wheel is routed by where the page
      // is drawn, and a page the player draws smaller than its viewport drops a wheel outside what it draws.
      if (action.ref !== undefined || action.selector !== undefined) return this.scrollElement(await this.nodeOf(action), action.deltaX, action.deltaY)
      let point: { x: number; y: number }
      if (action.x !== undefined && action.y !== undefined) point = { x: action.x, y: action.y }
      else { const viewport = await this.visibleViewport(); point = { x: Math.round(viewport.clientWidth / 2), y: Math.round(viewport.clientHeight / 2) } }
      if (action.x !== undefined) await this.moveCursor(point)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: action.deltaX, deltaY: action.deltaY })
    } else if (action.type === 'select') {
      const node = action.x !== undefined && action.y !== undefined ? await this.nodeAt({ x: action.x, y: action.y }) : await this.nodeOf(action)
      if (action.x !== undefined && action.y !== undefined) await this.moveCursor({ x: action.x, y: action.y })
      return this.selectValues(node ?? fail('blocked', 'Nothing on the page is at that point.'), action.values)
    } else if (action.type === 'drag') {
      const from = await this.pointOf(action.from), to = await this.pointOf(action.to)
      await this.moveCursor(from)
      try { return await this.drag(from, to) } finally { this.placeCursor(to) }
    } else if (action.fill) {
      await this.send('Emulation.clearDeviceMetricsOverride')
      this.viewport = null
    } else {
      const size = action.preset ? presetSize(action.preset, action.orientation) : { width: action.width!, height: action.height!, mobile: false }
      const viewport = { width: size.width, height: size.height, mobile: size.mobile }
      await this.send('Emulation.setDeviceMetricsOverride', this.metrics(viewport))
      this.viewport = viewport
    }
    return undefined
  }
  /** Selects everything in the focused field, so what is typed next replaces it. */
  private async selectAll(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: '(() => { const element = document.activeElement; if (element && typeof element.select === \'function\') { element.select(); return } if (element && element.isContentEditable) { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range) } })()' })
  }
  /** Chooses options in a native `<select>` by value or label, and tells the page as a person's choice would. */
  private async selectValues(backendNodeId: number, values: readonly string[]): Promise<string> {
    const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 'sotto-browser-select' }) as { object?: { objectId?: string } }
    try {
      const objectId = resolved.object?.objectId ?? fail('blocked', 'That element is gone. Take a snapshot and try again.')
      const result = await this.send('Runtime.callFunctionOn', { objectId, returnByValue: true, arguments: [{ value: values }],
        functionDeclaration: 'function(values) { if (this.tagName !== \'SELECT\') return { error: \'not-select\' }; const options = Array.from(this.options); const chosen = []; for (const value of values) { const option = options.find(entry => entry.value === value) || options.find(entry => entry.label === value || entry.textContent.trim() === value); if (!option) return { error: \'missing\', value }; if (option.disabled) return { error: \'disabled\', value }; chosen.push(option) } if (!this.multiple && chosen.length > 1) return { error: \'single\' }; for (const option of options) option.selected = chosen.includes(option); this.dispatchEvent(new Event(\'input\', { bubbles: true })); this.dispatchEvent(new Event(\'change\', { bubbles: true })); return { selected: chosen.map(option => option.label || option.value) } }' }) as { result?: { value?: { error?: string; value?: string; selected?: string[] } } }
      const answer = result.result?.value
      if (answer?.error === 'not-select') return fail('blocked', 'That element is not a <select>. For a custom menu, click it and then click the option.')
      if (answer?.error === 'missing') return fail('blocked', `This menu has no option ${JSON.stringify(answer.value)}. Snapshot the page to see its options.`)
      if (answer?.error === 'disabled') return fail('blocked', `The option ${JSON.stringify(answer.value)} is disabled.`)
      if (answer?.error === 'single') return fail('blocked', 'This menu takes one choice.')
      return `Selected ${JSON.stringify(answer?.selected ?? [])}.`
    } finally { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-select' }).catch(() => undefined) }
  }
  /**
   * Drags from one point to another as a mouse does: press, travel, release. An HTML drag the page starts is caught
   * (`Input.setInterceptDrags`) and dropped on the target, since Chromium's own drag loop does not run for protocol input.
   */
  private async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<string> {
    this.dragData = null
    await this.send('Input.setInterceptDrags', { enabled: true }).catch(() => undefined)
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from.x), y: Math.round(from.y) })
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(from.x), y: Math.round(from.y), button: 'left', clickCount: 1 })
      await this.cleaningUp(async () => {
        for (let step = 1; step <= DRAG_STEPS; step++) {
          const x = from.x + (to.x - from.x) * step / DRAG_STEPS, y = from.y + (to.y - from.y) * step / DRAG_STEPS
          await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1 })
        }
        if (this.dragData) {
          const drop = { x: Math.round(to.x), y: Math.round(to.y), data: this.dragData }
          for (const type of ['dragEnter', 'dragOver', 'drop']) await this.send('Input.dispatchDragEvent', { type, ...drop })
        }
      }, () => this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(to.x), y: Math.round(to.y), button: 'left', clickCount: 1 }))
      return this.dragData ? 'Dragged and dropped (an HTML drag).' : 'Dragged.'
    } finally {
      this.dragData = null
      await this.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
    }
  }
  /** Scrolls the nearest container of an element that can scroll, or the page when none can, and says how far it moved. */
  private async scrollElement(backendNodeId: number, deltaX: number, deltaY: number): Promise<string> {
    const resolved = await this.send('DOM.resolveNode', { backendNodeId, objectGroup: 'sotto-browser-scroll' }) as { object?: { objectId?: string } }
    try {
      const objectId = resolved.object?.objectId ?? fail('blocked', 'That element is gone. Take a snapshot and try again.')
      const result = await this.send('Runtime.callFunctionOn', { objectId, returnByValue: true, arguments: [{ value: deltaX }, { value: deltaY }], functionDeclaration: SCROLL_ELEMENT }) as { result?: { value?: unknown } }
      const moved = result.result?.value as { x?: unknown; y?: unknown; page?: unknown } | undefined
      const x = Number(moved?.x) || 0, y = Number(moved?.y) || 0
      const where = moved?.page === true ? 'the page' : 'its container'
      return x === 0 && y === 0 ? `Nothing moved: ${where} cannot scroll further that way.` : `Scrolled ${where} by ${Math.round(x)}, ${Math.round(y)}.`
    } finally { await this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-scroll' }).catch(() => undefined) }
  }
  /** Forgets the last snapshot's refs: the user took the page over, so its elements may have moved (ADR-0220). */
  forgetRefs(): void { this.refs = new Map() }
  /** The override Chromium is sent for a viewport, so the page lays out at the agent's size in CSS pixels at any zoom. */
  private metrics(viewport: { width: number; height: number; mobile: boolean }): Record<string, unknown> {
    const scale = viewport.mobile ? 1 : this.zoom
    return { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), deviceScaleFactor: 1, mobile: viewport.mobile }
  }
  /** The page's zoom changed (ADR-0222): an agent's desktop viewport is sent again at it, so it keeps its CSS size. */
  setZoom(zoom: number): void {
    if (!Number.isFinite(zoom) || zoom <= 0 || Math.abs(zoom - this.zoom) < 0.001) return
    this.zoom = zoom
    const viewport = this.viewport
    if (!viewport || viewport.mobile || !this.enabled || this.page.isGone() || !this.page.isAttached()) return
    void this.send('Emulation.setDeviceMetricsOverride', this.metrics(viewport)).catch(() => undefined)
  }
  /**
   * The agent's cursor goes to `point` (ADR-0222): Chromium's overlay draws an arrow there, so no script goes into the
   * page, and recordings show it as the page draws it. It glides there in a few steps, or jumps with reduced motion.
   * Nothing is drawn without a style from the window, while pointing, or with the full catalog off; a failure to draw
   * never fails the action.
   */
  private async moveCursor(point: { x: number; y: number }): Promise<void> {
    if (!this.cursorOn()) return
    try {
      await this.cursorReady()
      const from = this.cursorAt
      const steps = from && !this.cursor!.reducedMotion && this.cursorShown ? CURSOR_STEPS : 1
      for (let step = 1; step <= steps; step++) {
        const x = from && steps > 1 ? from.x + (point.x - from.x) * step / steps : point.x
        const y = from && steps > 1 ? from.y + (point.y - from.y) * step / steps : point.y
        await this.drawCursor({ x, y })
        if (step < steps) await new Promise(resolve => setTimeout(resolve, CURSOR_STEP_MS))
      }
      this.cursorAt = point
      this.lingerCursor()
    } catch { /* The cursor is decoration. */ }
  }
  /** The cursor is put at `point` without gliding, as after a drag, whose own steps moved it. */
  private placeCursor(point: { x: number; y: number }): void {
    if (!this.cursorOn()) return
    this.cursorAt = point
    void this.cursorReady().then(() => this.drawCursor(point)).then(() => this.lingerCursor(), () => undefined)
  }
  /** A click's ring at `point`, for a moment, then the arrow again. Not drawn as motion: it shows and goes. */
  private markClick(point: { x: number; y: number }): void {
    if (!this.cursorOn()) return
    const color = this.cursor!.color
    void this.page.sendCommand('Overlay.highlightRect', { x: Math.round(point.x - 10), y: Math.round(point.y - 10), width: 20, height: 20, color: { ...color, a: 0.25 }, outlineColor: { ...color, a: 0.95 } })
      .then(() => { this.cursorShown = true; this.lingerCursor() }, () => undefined)
    setTimeout(() => { if (this.cursorShown && this.cursorAt && this.cursorOn()) void this.drawCursor(this.cursorAt).catch(() => undefined) }, CURSOR_RING_MS)
  }
  // Nothing is drawn while the page's dialog is open: the page cannot draw then, and the overlay's commands would wait
  // in front of the dialog's answer.
  private cursorOn(): boolean { return this.parity && this.cursor !== null && this.pointing === null && this.dialogOpen === null && !this.page.isGone() && this.page.isAttached() }
  private async cursorReady(): Promise<void> {
    if (this.cursorSession === this.session) return
    const session = this.session
    await this.send('DOM.enable')
    await this.send('Overlay.enable')
    this.cursorSession = session
  }
  private async drawCursor(point: { x: number; y: number }): Promise<void> {
    const color = this.cursor?.color ?? { r: 37, g: 99, b: 235 }
    const quad = CURSOR_ARROW.map((value, index) => Math.round((index % 2 === 0 ? point.x : point.y) + value))
    // Shown before it is sent: a picture asked for meanwhile then hides it after it is drawn, as commands keep order.
    this.cursorShown = true
    await this.page.sendCommand('Overlay.highlightQuad', { quad, color: { ...color, a: 0.95 }, outlineColor: { r: 255, g: 255, b: 255, a: 1 } })
  }
  /** The cursor goes a moment after the last action. */
  private lingerCursor(): void {
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => { this.cursorTimer = null; void this.hideCursor() }, CURSOR_LINGER_MS)
  }
  /** The cursor off, as before an agent's screenshot, which never shows it. */
  async hideCursor(): Promise<void> {
    if (!this.cursorShown) return
    this.cursorShown = false
    if (this.cursorTimer) { clearTimeout(this.cursorTimer); this.cursorTimer = null }
    if (this.page.isGone() || !this.page.isAttached() || this.pointing) return
    // With a dialog open the page draws nothing new; the cursor is taken off once it is answered.
    if (this.dialogOpen) { this.cursorShown = true; return }
    await this.page.sendCommand('Overlay.hideHighlight').catch(() => undefined)
  }
  async resetViewport(): Promise<void> {
    await this.ready()
    await this.send('Emulation.clearDeviceMetricsOverride')
    this.viewport = null
  }
  /**
   * A navigation started: the old document's errors, console, refs and any chooser go with it, and the system's file
   * chooser is the user's again. Whether a secret is in the document is left to `documentCommitted`.
   */
  clear(): void {
    this.errors.length = 0; this.consoleLog.length = 0
    this.refs = new Map()
    const intercepting = this.interceptUntil !== 0 || this.chooser !== null
    if (this.chooser) { this.chooser = null; this.onChange?.() }
    if (intercepting) void this.stopIntercepting()
    this.cursorAt = null
    if (this.cursorShown) void this.hideCursor()
  }
  dispose(): void {
    // Typed secrets stay masked until the page itself closes: the field still holds them after its sharing ends, and so
    // does the document, so evaluate stays off when the page is shared again.
    this.clear()
    if (this.cursorTimer) { clearTimeout(this.cursorTimer); this.cursorTimer = null }
    this.cursorShown = false
    this.screencast = null
    this.dialogOpen = null
    this.pointSession++
    this.pointing = null; this.hovered = null; this.hoverRequest++
    if (this.page.isGone()) return
    this.page.offEvent(this.onMessage)
    // The listener is gone, so the next action sets up afresh and listens again, attached or not.
    this.enabled = null
    if (this.page.isAttached()) this.page.detach()
  }
}