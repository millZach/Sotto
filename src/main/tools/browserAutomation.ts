import { nativeImage, type NativeImage, type WebContents } from 'electron'
import type { BrowserAction, BrowserBounds, BrowserCapture } from '../../shared/browser'

/** Fixed operations only: callers cannot evaluate script or read cookies. */
export class BrowserAutomation {
  private enabled: Promise<void> | null = null
  private readonly errors: { kind: string; message: string }[] = []
  constructor(private readonly contents: WebContents, private readonly prepareCapture: () => () => void = () => () => undefined) {}
  private async ready(): Promise<void> {
    if (!this.contents.debugger.isAttached()) {
      this.contents.debugger.attach('1.3')
      this.enabled = null
    }
    if (!this.enabled) {
      this.contents.debugger.removeListener('message', this.onMessage)
      this.contents.debugger.on('message', this.onMessage)
      this.enabled = Promise.all([this.contents.debugger.sendCommand('Network.enable'), this.contents.debugger.sendCommand('Runtime.enable')]).then(() => undefined)
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
    const result = await this.contents.debugger.sendCommand('Accessibility.getFullAXTree') as { nodes?: { ignored?: boolean; role?: { value?: unknown }; name?: { value?: unknown }; backendDOMNodeId?: number }[] }
    const nodes = (result.nodes ?? []).filter(node => !node.ignored).slice(0, 200).map(node => ({ role: String(node.role?.value ?? '').slice(0, 100), name: String(node.name?.value ?? '').slice(0, 300), nodeId: node.backendDOMNodeId }))
    const dom = await this.contents.debugger.sendCommand('Runtime.evaluate', {
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
      return await Promise.race([this.frame(rect), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The browser page did not render in time.')), 10_000) })])
    } finally { if (timer) clearTimeout(timer); release() }
  }
  private async frame(rect?: BrowserBounds): Promise<NativeImage> {
    await this.ready()
    const layout = await this.contents.debugger.sendCommand('Page.getLayoutMetrics') as { cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number } }
    const viewport = layout.cssVisualViewport
    if (!viewport || !viewport.clientWidth || !viewport.clientHeight) throw new Error('This page has no rendered viewport.')
    const width = Math.round(rect?.width ?? viewport.clientWidth), height = Math.round(rect?.height ?? viewport.clientHeight)
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) throw new Error('This page is too large to capture.')
    if (rect && (rect.x + rect.width > viewport.clientWidth || rect.y + rect.height > viewport.clientHeight)) throw new Error('This selection extends beyond the captured page.')
    // Capture the logical viewport even when its native pane is smaller or detached.
    // Normalize DPR so screenshot coordinates and CDP input use the same CSS pixels.
    const result = await this.contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true, clip: { x: viewport.pageX + (rect?.x ?? 0), y: viewport.pageY + (rect?.y ?? 0), width, height, scale: 1 } }) as { data?: string }
    if (!result.data) throw new Error('The browser page could not be captured.')
    const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'))
    const size = image.getSize()
    return size.width === width && size.height === height ? image : image.resize({ width, height })
  }
  async elementAt(point: { x: number; y: number }): Promise<{ element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } | null> {
    await this.ready()
    const expression = `(() => { const el = document.elementFromPoint(${point.x}, ${point.y}); if (!el) return null; const r=el.getBoundingClientRect(); return { element: { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: (el.getAttribute('aria-label') || el.getAttribute('alt') || '').slice(0,500), text: (el.innerText || '').slice(0,1000), selector: el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() }, bounds: { x:r.x, y:r.y, width:r.width, height:r.height } }; })()`
    const result = await this.contents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true }) as { result?: { value?: { element: NonNullable<BrowserCapture['element']>; bounds: BrowserBounds } } }
    return result.result?.value ?? null
  }
  async capture(url: string, point?: { x: number; y: number }, region?: BrowserBounds): Promise<BrowserCapture> {
    const element = point ? (await this.elementAt(point))?.element ?? null : null
    const rect = region ? Object.fromEntries(Object.entries(region).map(([key, value]) => [key, Math.round(value)])) as BrowserBounds : undefined
    const snapshot = await this.snapshot(rect)
    const size = snapshot.getSize()
    if (snapshot.isEmpty()) throw new Error('The page has not rendered yet.')
    const image = snapshot.toDataURL()
    if (image.length > 16_000_000) throw new Error('The page capture is too large.')
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
  async target(action: Extract<BrowserAction, { type: 'click' | 'type' }>): Promise<string> {
    await this.ready()
    let backendNodeId: number | undefined
    if (action.type === 'click') {
      const located = await this.contents.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(action.x), y: Math.round(action.y), includeUserAgentShadowDOM: true }) as { backendNodeId?: number }
      backendNodeId = located.backendNodeId
    } else {
      const focused = await this.contents.debugger.sendCommand('Runtime.evaluate', { expression: 'document.activeElement', objectGroup: 'sotto-browser-target' }) as { result?: { objectId?: string } }
      if (!focused.result?.objectId) throw new Error('No focused input.')
      try {
        const described = await this.contents.debugger.sendCommand('DOM.describeNode', { objectId: focused.result.objectId }) as { node?: { backendNodeId?: number } }
        backendNodeId = described.node?.backendNodeId
      } finally { await this.contents.debugger.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'sotto-browser-target' }) }
    }
    if (!backendNodeId) throw new Error('No browser target.')
    const result = await this.contents.debugger.sendCommand('DOM.describeNode', { backendNodeId, depth: 1, pierce: true }) as { node?: { nodeName?: string; attributes?: string[]; shadowRoots?: { shadowRootType?: string }[] } }
    if (action.type === 'type') {
      const node = result.node
      const attributes = new Map<string, string>()
      for (let index = 0; index < (node?.attributes?.length ?? 0); index += 2) attributes.set(node!.attributes![index]!, node!.attributes![index + 1] ?? '')
      const nativeInput = node?.nodeName === 'TEXTAREA' || (node?.nodeName === 'INPUT' && ['text', 'search', 'email', 'number', 'tel', 'url', 'password'].includes(attributes.get('type') ?? 'text'))
      const editable = ['true', 'plaintext-only', ''].includes(attributes.get('contenteditable') ?? 'false')
      // Top-level activeElement can be an iframe or a closed-shadow host while
      // insertText targets an unseen focused descendant. Do not approve that proxy.
      if ((!nativeInput && !editable) || node?.shadowRoots?.some(root => root.shadowRootType !== 'user-agent')) throw new Error('Focus a direct text field before requesting browser typing.')
    }
    return JSON.stringify(result.node).slice(0, 16_000)
  }
  async thumbnail(capturedImage?: string): Promise<string | null> {
    const snapshot = capturedImage ? nativeImage.createFromDataURL(capturedImage) : await this.snapshot()
    if (snapshot.isEmpty()) return null
    return `data:image/jpeg;base64,${snapshot.resize({ width: 320 }).toJPEG(65).toString('base64')}`
  }
  async input(action: Extract<BrowserAction, { type: 'click' | 'type' | 'scroll' | 'viewport' }>, guard: () => void): Promise<void> {
    await this.ready()
    guard()
    if (action.type === 'click') {
      await this.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(action.x), y: Math.round(action.y), button: 'left', clickCount: 1 })
      // Press/release is one operation. Always release when Pause arrives mid-click.
      await this.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(action.x), y: Math.round(action.y), button: 'left', clickCount: 1 })
    } else if (action.type === 'type') await this.contents.debugger.sendCommand('Input.insertText', { text: action.text })
    else if (action.type === 'scroll') await this.contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY })
    else await this.contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: action.width, height: action.height, deviceScaleFactor: 1, mobile: false })
  }
  async resetViewport(): Promise<void> {
    await this.ready()
    await this.contents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
  }
  clear(): void { this.errors.length = 0 }
  dispose(): void {
    this.clear()
    if (this.contents.isDestroyed()) return
    this.contents.debugger?.removeListener('message', this.onMessage)
    if (this.contents.debugger?.isAttached()) this.contents.debugger.detach()
  }
}