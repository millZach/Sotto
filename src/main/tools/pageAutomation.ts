import type { BrowserAction, BrowserBounds, BrowserCapture } from '../../shared/browser'
import { ToolFailure, fail } from './common'

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

export type PageInput = Extract<BrowserAction, { type: 'click' | 'type' | 'scroll' | 'viewport' | 'tap' | 'swipe' | 'key' }>
/** What a `key` action sends: the key's code, and the character a press types for the keys that type one. */
const KEYS: Record<Extract<BrowserAction, { type: 'key' }>['key'], { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' }, Backspace: { code: 8 }, Tab: { code: 9 }, Escape: { code: 27 },
  ArrowUp: { code: 38 }, ArrowDown: { code: 40 }, ArrowLeft: { code: 37 }, ArrowRight: { code: 39 },
}
/** A swipe is this many touch moves between its two points: enough for a list to read it as a fling. */
const SWIPE_STEPS = 10
/** How long one point-mode command may take before the page counts as not answering. */
const POINT_DEADLINE = 5_000

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
/** The words an element's markup holds, without its tags, scripts or styles. */
function markupText(html: string): string {
  return html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/giu, ' ').replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, '\'').replace(/&amp;/gu, '&')
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
  private viewport: { width: number; height: number } | null = null
  private readonly errors: { kind: string; message: string }[] = []
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
      if (this.touch) commands.push(
        this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
        this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }),
      )
      if (this.viewport) commands.push(this.send('Emulation.setDeviceMetricsOverride', { ...this.viewport, deviceScaleFactor: 1, mobile: false }))
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
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
      const args = params.args as { value?: unknown; description?: string }[] | undefined
      message = args?.map(arg => typeof arg.value === 'string' ? arg.value : arg.description ?? '').join(' ') ?? 'The page reported an error.'
    }
    if (method === 'Overlay.nodeHighlightRequested' && this.pointing && typeof params.nodeId === 'number') this.hover(params.nodeId)
    if (method === 'Overlay.inspectNodeRequested' && this.pointing && typeof params.backendNodeId === 'number') {
      const handlers = this.pointing
      this.pointing = null; this.hovered = null; this.hoverRequest++
      handlers.pick({ backendNodeId: params.backendNodeId })
    }
    if (message) {
      this.errors.push({ kind: method.startsWith('Network.') ? 'network' : 'console', message: message.slice(0, 2000) })
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
    return { element: { ...described.element, text: markupText(html.slice(0, 200_000)).slice(0, 1000) }, box }
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
    const role = String(accessible?.role?.value ?? attributes.get('role') ?? '').slice(0, 100)
    // eslint-disable-next-line no-control-regex -- Untrusted page words shown in Sotto's own chrome.
    const name = String(accessible?.name?.value || attributes.get('aria-label') || attributes.get('alt') || '').replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 500)
    const id = attributes.get('id')
    return { element: { tag, role: ['generic', 'none', 'presentation'].includes(role) ? '' : role, name, text: '', selector: id ? `#${cssIdentifier(id)}` : tag } }
  }
  async inspect(): Promise<string> {
    await this.ready()
    const result = await this.send('Accessibility.getFullAXTree') as { nodes?: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number }[] }
    const nodes = (result.nodes ?? []).filter(node => !node.ignored).slice(0, 200).map(node => ({ role: String(node.role?.value ?? '').slice(0, 100), name: String(node.name?.value ?? '').slice(0, 300), nodeId: node.backendDOMNodeId }))
    const dom = await this.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3')).slice(0,100).map(el => { const r=el.getBoundingClientRect(); return { tag:el.tagName.toLowerCase(), role:el.getAttribute('role')||'', name:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').slice(0,200), x:r.x,y:r.y,width:r.width,height:r.height, disabled:!!el.disabled }; })`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    const output = JSON.stringify({ url: this.page.url(), nodes, elements: dom.result?.value ?? [], errors: this.errors, truncated: (result.nodes?.length ?? 0) > 200 })
    return output.length <= 200_000 ? output : JSON.stringify({ url: this.page.url(), nodes: nodes.slice(0, 100), errors: this.errors.slice(-10), truncated: true })
  }
  /**
   * One picture of the page as Chromium drew it, within the snapshot deadline. `rect` is in the visual viewport's CSS
   * pixels. PNG at full size by default; a JPEG at a smaller `scale` is what a host makes its smaller pictures from,
   * since it has no image library of its own.
   */
  protected async snapshot(rect?: BrowserBounds, encoding: PageEncoding = { format: 'png', scale: 1 }): Promise<PageFrame> {
    const release = this.prepareCapture()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Giving up ends the attachment too, so the abandoned capture's commands cannot cut into the next action.
      return await Promise.race([this.frame(rect, encoding), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.reset(); reject(new ToolFailure('unavailable', 'The page did not draw in time. Inspect it before trying again.')) }, 10_000) })])
    } finally { if (timer) clearTimeout(timer); release() }
  }
  /** The part of the page on screen, in CSS pixels, and how far down the document it sits; a screenshot is this. */
  private async visibleViewport(): Promise<{ pageX: number; pageY: number; clientWidth: number; clientHeight: number }> {
    const layout = await this.send('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }
    const viewport = layout.cssVisualViewport
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) return fail('unavailable', 'This page has not drawn yet. Wait for it to load, then try again.')
    return viewport
  }
  private async frame(rect: BrowserBounds | undefined, encoding: PageEncoding): Promise<PageFrame> {
    await this.ready()
    const viewport = await this.visibleViewport()
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
    const expression = `(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); if (!el) return null; const r=el.getBoundingClientRect(); return { element: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0,500), text: (el.innerText || '').slice(0,1000), selector: el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() }, bounds: { x:r.x, y:r.y, width:r.width, height:r.height } }; })()`
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: { element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } } }
    return result.result?.value ?? null
  }
  async capture(url: string, point?: { x: number; y: number }, region?: BrowserBounds): Promise<BrowserCapture> {
    const element = point ? (await this.elementAt(point))?.element ?? null : null
    const rect = region ? Object.fromEntries(Object.entries(region).map(([key, value]) => [key, Math.round(value)])) as BrowserBounds : undefined
    const snapshot = this.picture(await this.snapshot(rect))
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
  async target(action: Extract<BrowserAction, { type: 'click' | 'type' | 'tap' | 'key' }>): Promise<string> {
    await this.ready()
    let backendNodeId: number | undefined
    if (action.type === 'click' || action.type === 'tap') {
      backendNodeId = await this.nodeAt(action)
    } else {
      const focused = await this.send('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'sotto-browser-target' }) as { result?: { objectId?: string } }
      if (!focused.result?.objectId) return fail('blocked', 'Nothing on the page has focus. Click a text field, then type.')
      const objectId = focused.result.objectId
      const described = await this.cleaningUp(() => this.send('DOM.describeNode', { objectId }), () => this.send('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-target' })) as { node?: { backendNodeId?: number } }
      backendNodeId = described.node?.backendNodeId
    }
    if (!backendNodeId) return fail('blocked', 'Nothing on the page is at that point. Inspect the page and use its coordinates.')
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
    }
    return JSON.stringify(result.node).slice(0, 16_000)
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
  async input(action: PageInput, guard: () => void): Promise<void> {
    await this.ready()
    guard()
    const release = this.prepareCapture()
    try {
      await this.dispatch(action)
      if (action.type === 'scroll' || action.type === 'swipe' || action.type === 'tap') await this.settled()
    } finally { release() }
  }
  /**
   * Two frames, or half a second if the page draws none, as a headless page may not. Best effort: a tap that starts
   * a navigation takes the page's context with it, and the action itself has already happened.
   */
  private async settled(): Promise<void> {
    await this.send('Runtime.evaluate', { expression: SETTLE_EXPRESSION, awaitPromise: true }).catch(() => undefined)
  }
  private async dispatch(action: PageInput): Promise<void> {
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> => this.send(method, params)
    if (action.type === 'tap') {
      // Start and end are one operation, as a click's press and release are.
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(action.x), y: Math.round(action.y) }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else if (action.type === 'swipe') {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(action.x), y: Math.round(action.y) }] })
      await this.cleaningUp(async () => {
        for (let step = 1; step <= SWIPE_STEPS; step++) {
          const x = action.x + (action.toX - action.x) * step / SWIPE_STEPS, y = action.y + (action.toY - action.y) * step / SWIPE_STEPS
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x), y: Math.round(y) }] })
        }
      }, () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }))
    } else if (action.type === 'key') {
      const key = KEYS[action.key]
      const event = { key: action.key, code: action.key, windowsVirtualKeyCode: key.code, nativeVirtualKeyCode: key.code }
      await send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...event, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    } else if (action.type === 'click') {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(action.x), y: Math.round(action.y), button: 'left', clickCount: 1 })
      // Press/release is one operation. Always release when Pause arrives mid-click.
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(action.x), y: Math.round(action.y), button: 'left', clickCount: 1 })
    } else if (action.type === 'type') await this.send('Input.insertText', { text: action.text })
    else if (action.type === 'scroll') await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY })
    else {
      await this.send('Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false })
      this.viewport = { width: action.width, height: action.height }
    }
  }
  async resetViewport(): Promise<void> {
    await this.ready()
    await this.send('Emulation.clearDeviceMetricsOverride')
    this.viewport = null
  }
  clear(): void { this.errors.length = 0 }
  dispose(): void {
    this.clear()
    this.pointSession++
    this.pointing = null; this.hovered = null; this.hoverRequest++
    if (this.page.isGone()) return
    this.page.offEvent(this.onMessage)
    if (this.page.isAttached()) this.page.detach()
  }
}