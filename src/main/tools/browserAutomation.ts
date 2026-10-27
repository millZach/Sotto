import { nativeImage, type NativeImage, type WebContents } from 'electron'
import type { BrowserAction, BrowserBounds, BrowserCapture } from '../../shared/browser'
import { ToolFailure, fail } from './common'

type Input = Extract<BrowserAction, { type: 'click' | 'type' | 'scroll' | 'viewport' | 'tap' | 'swipe' | 'key' }>
/** What a `key` action sends: the key's code, and the character a press types for the keys that type one. */
const KEYS: Record<Extract<BrowserAction, { type: 'key' }>['key'], { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' }, Backspace: { code: 8 }, Tab: { code: 9 }, Escape: { code: 27 },
  ArrowUp: { code: 38 }, ArrowDown: { code: 40 }, ArrowLeft: { code: 37 }, ArrowRight: { code: 39 },
}
/** A swipe is this many touch moves between its two points: enough for a list to read it as a fling. */
const SWIPE_STEPS = 10

/**
 * How long one debugger command may take. Chromium answers a wheel, touch or capture only once the page draws a
 * frame, so a page that cannot draw would otherwise hold its action, and the service's place for it, until someone
 * showed it again. A command past this fails in words instead, and the action's page lock goes with it.
 */
export const BROWSER_COMMAND_DEADLINE_MS = 20_000

/** Fixed operations only: callers cannot evaluate script or read cookies. */
export class BrowserAutomation {
  private enabled: Promise<void> | null = null
  /** Which debugger attachment is current. A command left from an earlier one cannot reset this one. */
  private session = 0
  private readonly errors: { kind: string; message: string }[] = []
  /**
   * `touch` is the test iPhone's (ADR-0045): while attached, the page sees a touch screen and the mouse taps it.
   * `prepareCapture` lends the page a surface to draw into while it is off screen, and returns its release.
   */
  constructor(private readonly contents: WebContents, private readonly prepareCapture: () => () => void = () => () => undefined, private readonly touch = false) {}
  /**
   * Ends this debugger attachment: Electron rejects whatever is still waiting on it, and the next action attaches
   * afresh rather than queueing behind a page that never answered.
   */
  private reset(): void {
    this.session++
    this.enabled = null
    if (this.contents.isDestroyed() || !this.contents.debugger.isAttached()) return
    try { this.contents.debugger.detach() } catch { /* Already detached. */ }
  }
  /** One debugger command, bounded by the deadline. Past it, the attachment it was sent on ends. */
  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const session = this.session
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ToolFailure('unavailable', 'The page did not answer in time. Inspect it before trying again.')), BROWSER_COMMAND_DEADLINE_MS) })
    try { return await Promise.race([this.contents.debugger.sendCommand(method, params), late]) }
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
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3')
      this.enabled = null
    }
    if (!this.enabled) {
      this.contents.debugger.removeListener('message', this.onMessage)
      this.contents.debugger.on('message', this.onMessage)
      const commands = [this.send('Network.enable'), this.send('Runtime.enable')]
      if (this.touch) commands.push(
        this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }),
        this.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }),
      )
      const enabling = Promise.all(commands).then(() => undefined)
      // A setup that failed is not kept: the next action tries it again rather than failing on the old answer.
      enabling.catch(() => { if (this.enabled === enabling) this.enabled = null })
      this.enabled = enabling
    }
    await this.enabled
  }
  private readonly onMessage = (_event: unknown, method: string, params: Record<string, unknown>): void => {
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
    if (message) {
      this.errors.push({ kind: method.startsWith('Network.') ? 'network' : 'console', message: message.slice(0, 2000) })
      if (this.errors.length > 40) this.errors.shift()
    }
  }
  observe(): void { void this.ready().catch(() => undefined) }
  async inspect(): Promise<string> {
    await this.ready()
    const result = await this.send('Accessibility.getFullAXTree') as { nodes?: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number }[] }
    const nodes = (result.nodes ?? []).filter(node => !node.ignored).slice(0, 200).map(node => ({ role: String(node.role?.value ?? '').slice(0, 100), name: String(node.name?.value ?? '').slice(0, 300), nodeId: node.backendDOMNodeId }))
    const dom = await this.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3')).slice(0,100).map(el => { const r=el.getBoundingClientRect(); return { tag:el.tagName.toLowerCase(), role:el.getAttribute('role')||'', name:(el.getAttribute('aria-label')||el.innerText||el.getAttribute('placeholder')||'').slice(0,200), x:r.x,y:r.y,width:r.width,height:r.height, disabled:!!el.disabled }; })`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    const output = JSON.stringify({ url: this.contents.getURL(), nodes, elements: dom.result?.value ?? [], errors: this.errors, truncated: (result.nodes?.length ?? 0) > 200 })
    return output.length <= 200_000 ? output : JSON.stringify({ url: this.contents.getURL(), nodes: nodes.slice(0, 100), errors: this.errors.slice(-10), truncated: true })
  }
  private async snapshot(rect?: BrowserBounds): Promise<NativeImage> {
    const release = this.prepareCapture()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Giving up ends the attachment too, so the abandoned capture's commands cannot cut into the next action.
      return await Promise.race([this.frame(rect), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { this.reset(); reject(new ToolFailure('unavailable', 'The page did not draw in time. Inspect it before trying again.')) }, 10_000) })])
    } finally { if (timer) clearTimeout(timer); release() }
  }
  private async frame(rect?: BrowserBounds): Promise<NativeImage> {
    await this.ready()
    const layout = await this.send('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }
    const viewport = layout.cssVisualViewport
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) return fail('unavailable', 'This page has not drawn yet. Wait for it to load, then try again.')
    const width = Math.round(rect?.width ?? viewport.clientWidth), height = Math.round(rect?.height ?? viewport.clientHeight)
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return fail('too-large', 'This page is too large to capture. Set a smaller viewport, then try again.')
    if (rect && (rect.x + rect.width > viewport.clientWidth || rect.y + rect.height > viewport.clientHeight)) return fail('blocked', 'This selection extends beyond the captured page.')
    // Capture the logical viewport even when its native pane is smaller or detached.
    // Normalize DPR so screenshot coordinates and CDP input use the same CSS pixels.
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: viewport.pageX + (rect?.x ?? 0), y: viewport.pageY + (rect?.y ?? 0), width, height, scale: 1 } }) as { data?: string }
    if (!result.data) return fail('unavailable', 'The page could not be captured. Try again.')
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
    const size = image.getSize()
    return size.width === width && size.height === height ? image : image.resize({ width, height })
  }
  async elementAt(point: { x: number; y: number }): Promise<{ element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } | null> {
    await this.ready()
    const expression = `(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); if (!el) return null; const r=el.getBoundingClientRect(); return { element: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0,500), text: (el.innerText || '').slice(0,1000), selector: el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() }, bounds: { x:r.x, y:r.y, width:r.width, height:r.height } }; })()`
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: { element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } } }
    return result.result?.value ?? null
  }
  async capture(url: string, point?: { x: number; y: number }, region?: BrowserBounds): Promise<BrowserCapture> {
    const element = point ? (await this.elementAt(point))?.element ?? null : null
    const rect = region ? Object.fromEntries(Object.entries(region).map(([key, value]) => [key, Math.round(value)])) as BrowserBounds : undefined
    const snapshot = await this.snapshot(rect)
    const size = snapshot.getSize()
    if (snapshot.isEmpty()) return fail('unavailable', 'This page has not drawn yet. Wait for it to load, then try again.')
    const image = snapshot.toDataURL()
    if (image.length > 16_000_000) return fail('too-large', 'This page is too large to capture. Set a smaller viewport, then try again.')
    return { image, url, width: size.width, height: size.height, element }
  }
  evidence(capturedImage: string): { image: string; width: number; height: number } | null {
    const snapshot = nativeImage.createFromDataURL(capturedImage)
    if (snapshot.isEmpty()) return null
    const size = snapshot.getSize()
    let reduced = snapshot.resize({ width: Math.min(1280, size.width) })
    let image = `data:image/jpeg;base64,${reduced.toJPEG(70).toString('base64')}`
    if (image.length > 2_000_000) {
      reduced = snapshot.resize({ width: Math.min(640, size.width) })
      image = `data:image/jpeg;base64,${reduced.toJPEG(55).toString('base64')}`
    }
    return image.length <= 2_000_000 ? { image, width: size.width, height: size.height } : null
  }
  /** What a click, tap, typed entry or key press would reach: the node at its point, or the focused node. */
  async target(action: Extract<BrowserAction, { type: 'click' | 'type' | 'tap' | 'key' }>): Promise<string> {
    await this.ready()
    let backendNodeId: number | undefined
    if (action.type === 'click' || action.type === 'tap') {
      const located = await this.send('DOM.getNodeForLocation', { x: Math.round(action.x), y: Math.round(action.y), includeUserAgentShadowDOM: true }) as { backendNodeId?: number }
      backendNodeId = located.backendNodeId
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
  async thumbnail(capturedImage?: string): Promise<string | null> {
    const snapshot = capturedImage ? nativeImage.createFromDataURL(capturedImage) : await this.snapshot()
    if (snapshot.isEmpty()) return null
    return `data:image/jpeg;base64,${snapshot.resize({ width: 320 }).toJPEG(65).toString('base64')}`
  }
  /**
   * Chromium answers a wheel or touch event only once the page draws a frame, and a page that is not on screen
   * draws none, so input borrows the surface a capture borrows. Without it a scroll, tap or swipe on a hidden page
   * waited until someone showed the page.
   */
  async input(action: Input, guard: () => void): Promise<void> {
    await this.ready()
    guard()
    const release = this.prepareCapture()
    try { await this.dispatch(action) } finally { release() }
  }
  private async dispatch(action: Input): Promise<void> {
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
    else await this.send('Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false })
  }
  async resetViewport(): Promise<void> {
    await this.ready()
    await this.send('Emulation.clearDeviceMetricsOverride')
  }
  clear(): void { this.errors.length = 0 }
  dispose(): void {
    this.clear()
    if (this.contents.isDestroyed()) return
    this.contents.debugger?.removeListener('message', this.onMessage)
    if (this.contents.debugger?.isAttached()) this.contents.debugger.detach()
  }
}