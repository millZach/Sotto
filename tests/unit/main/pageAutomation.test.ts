// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { attributeOf, CURSOR_ARROW, PageAutomation, SNAPSHOT_TOTAL, type PageDebugger, type PageEventListener, type PageFrame, type PagePicture } from '../../../src/main/tools/pageAutomation'

type Handler = (method: string, params: Record<string, unknown>) => unknown

/** A page's debugger that answers from `handle` and records every command, as Chromium's would arrive. */
class FakePage implements PageDebugger {
  readonly sent: { method: string; params: Record<string, unknown> }[] = []
  private listener: PageEventListener | null = null
  attached = false
  gone = false
  constructor(public handle: Handler = () => ({})) {}
  isGone(): boolean { return this.gone }
  url(): string { return 'https://shop.example/checkout' }
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    return this.handle(method, params)
  }
  onEvent(listener: PageEventListener): void { this.listener = listener }
  offEvent(): void { this.listener = null }
  emit(method: string, params: Record<string, unknown>): void { this.listener?.(method, params) }
  methods(): string[] { return this.sent.map(entry => entry.method) }
  calls(method: string): Record<string, unknown>[] { return this.sent.filter(entry => entry.method === method).map(entry => entry.params) }
}

class TestAutomation extends PageAutomation {
  protected picture(frame: PageFrame): PagePicture { return { empty: false, width: frame.width, height: frame.height, dataUrl: `data:image/png;base64,${frame.data}` } }
  evidence(): null { return null }
  async thumbnail(): Promise<string | null> { return null }
}

const made: TestAutomation[] = []
afterEach(() => { for (const automation of made.splice(0)) automation.dispose() })

/** The commands a page answers for these tests: a 1280 by 800 view, a password field at 7 and a text field at 9. */
function page(focus: { node: number } = { node: 7 }): FakePage {
  return new FakePage((method, params) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 }, cssContentSize: { width: 1280, height: 2000 } }
    if (method === 'Page.captureScreenshot') return { data: 'YQ==' }
    if (method === 'Runtime.evaluate' && params.expression === 'document.activeElement') return { result: { objectId: 'active' } }
    if (method === 'Runtime.evaluate' && String(params.expression).startsWith('document.querySelector("#password")')) return { result: { objectId: 'password' } }
    if (method === 'Runtime.evaluate' && String(params.expression).startsWith('document.querySelector("#name")')) return { result: { objectId: 'name' } }
    if (method === 'DOM.describeNode' && params.objectId === 'active') return { node: { backendNodeId: focus.node } }
    if (method === 'DOM.describeNode' && params.objectId === 'password') return { node: { backendNodeId: 7 } }
    if (method === 'DOM.describeNode' && params.objectId === 'name') return { node: { backendNodeId: 9 } }
    if (method === 'DOM.describeNode' && params.backendNodeId === 7) return { node: { backendNodeId: 7, nodeName: 'INPUT', attributes: ['id', 'password', 'type', 'password'] } }
    if (method === 'DOM.describeNode' && params.backendNodeId === 9) return { node: { backendNodeId: 9, nodeName: 'INPUT', attributes: ['id', 'name', 'type', 'text'] } }
    if (method === 'DOM.focus') { focus.node = params.backendNodeId as number; return {} }
    return {}
  })
}

function automation(fake: FakePage, options: { parity?: boolean; cursor?: boolean; reducedMotion?: boolean } = {}): TestAutomation {
  const created = new TestAutomation(fake)
  created.parity = options.parity ?? true
  if (options.cursor) created.cursor = { color: { r: 10, g: 20, b: 30 }, reducedMotion: options.reducedMotion ?? false }
  made.push(created)
  return created
}
const go = (): void => undefined

describe('page zoom keeps the agent in CSS pixels (ADR-0222)', () => {
  it('sends a desktop viewport at the zoom, so the page lays out at the size the agent asked for', async () => {
    const fake = page(), automation_ = automation(fake)
    automation_.setZoom(1.75)
    await automation_.input({ type: 'viewport', width: 1280, height: 800 }, go)
    expect(fake.calls('Emulation.setDeviceMetricsOverride').at(-1)).toEqual({ width: 2240, height: 1400, deviceScaleFactor: 1, mobile: false })
    // The user zooms out: the override is sent again at the new zoom.
    automation_.setZoom(0.5)
    expect(fake.calls('Emulation.setDeviceMetricsOverride').at(-1)).toEqual({ width: 640, height: 400, deviceScaleFactor: 1, mobile: false })
    // The same zoom again sends nothing.
    const count = fake.calls('Emulation.setDeviceMetricsOverride').length
    automation_.setZoom(0.5)
    expect(fake.calls('Emulation.setDeviceMetricsOverride')).toHaveLength(count)
  })

  it('leaves a phone preset at its own size, since a mobile override ignores page zoom', async () => {
    const fake = page(), automation_ = automation(fake)
    automation_.setZoom(1.75)
    await automation_.input({ type: 'viewport', preset: 'iphone-se' }, go)
    expect(fake.calls('Emulation.setDeviceMetricsOverride').at(-1)).toEqual({ width: 375, height: 667, deviceScaleFactor: 1, mobile: true })
    const count = fake.calls('Emulation.setDeviceMetricsOverride').length
    automation_.setZoom(1)
    expect(fake.calls('Emulation.setDeviceMetricsOverride')).toHaveLength(count)
  })

  it('sends the override at the zoom again on a new attachment', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.input({ type: 'viewport', width: 1000, height: 600 }, go)
    automation_.setZoom(1.5)
    fake.attached = false
    await automation_.inspect()
    expect(fake.calls('Emulation.setDeviceMetricsOverride').at(-1)).toEqual({ width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  })

  it('refuses a zoom that is not a number above zero', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.input({ type: 'viewport', width: 1000, height: 600 }, go)
    for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) automation_.setZoom(zoom)
    expect(fake.calls('Emulation.setDeviceMetricsOverride')).toHaveLength(1)
  })
})

describe('the agent\'s cursor (ADR-0222)', () => {
  const arrowAt = (x: number, y: number): number[] => CURSOR_ARROW.map((value, index) => Math.round((index % 2 === 0 ? x : y) + value))

  it('draws an arrow at a click\'s point and a ring for the click, through the overlay and not the page', async () => {
    const fake = page(), automation_ = automation(fake, { cursor: true, reducedMotion: true })
    await automation_.input({ type: 'click', x: 200, y: 120 }, go)
    // The arrow, then the ring for a moment, then the arrow again in the same place.
    const quads = fake.calls('Overlay.highlightQuad')
    expect(new Set(quads.map(params => JSON.stringify(params.quad)))).toEqual(new Set([JSON.stringify(arrowAt(200, 120))]))
    expect(quads[0]).toEqual({ quad: arrowAt(200, 120), color: { r: 10, g: 20, b: 30, a: 0.95 }, outlineColor: { r: 255, g: 255, b: 255, a: 1 } })
    expect(fake.calls('Overlay.highlightRect')[0]).toMatchObject({ x: 190, y: 110, width: 20, height: 20 })
    expect(fake.methods()).toContain('Overlay.enable')
    // The arrow is drawn before the press, so it is where the click lands.
    expect(fake.methods().indexOf('Overlay.highlightQuad')).toBeLessThan(fake.methods().indexOf('Input.dispatchMouseEvent'))
    // Nothing of Sotto's goes into the page's own script.
    expect(fake.calls('Runtime.evaluate').some(params => /cursor/iu.test(String(params.expression)))).toBe(false)
  })

  it('glides from the last point in a few steps, and jumps with reduced motion', async () => {
    const glide = page(), gliding = automation(glide, { cursor: true })
    await gliding.input({ type: 'hover', x: 100, y: 100 }, go)
    await gliding.input({ type: 'hover', x: 400, y: 300 }, go)
    const quads = glide.calls('Overlay.highlightQuad').map(params => params.quad)
    expect(quads.length).toBeGreaterThan(2)
    expect(quads.at(-1)).toEqual(arrowAt(400, 300))
    const jump = page(), jumping = automation(jump, { cursor: true, reducedMotion: true })
    await jumping.input({ type: 'hover', x: 100, y: 100 }, go)
    await jumping.input({ type: 'hover', x: 400, y: 300 }, go)
    expect(jump.calls('Overlay.highlightQuad').map(params => params.quad)).toEqual([arrowAt(100, 100), arrowAt(400, 300)])
  })

  it('takes the cursor off for any picture of the page, so the picture is the page alone, then puts it back', async () => {
    const fake = page(), automation_ = automation(fake, { cursor: true, reducedMotion: true })
    await automation_.input({ type: 'hover', x: 50, y: 60 }, go)
    await automation_.capture('https://shop.example/checkout')
    const methods = fake.methods()
    const hidden = methods.lastIndexOf('Overlay.hideHighlight'), shot = methods.lastIndexOf('Page.captureScreenshot')
    expect(methods.slice(0, hidden)).toContain('Overlay.highlightQuad')
    expect(hidden).toBeLessThan(shot)
    expect(methods.slice(hidden, shot)).not.toContain('Overlay.highlightQuad')
    // The picture each action ends with must not take the cursor away as soon as it arrives.
    expect(methods.slice(shot)).toContain('Overlay.highlightQuad')
    expect(fake.calls('Overlay.highlightQuad').at(-1)?.quad).toEqual(arrowAt(50, 60))
    // After a navigation the cursor has no place, so a picture leaves it off.
    automation_.clear()
    await automation_.capture('https://shop.example/next')
    expect(fake.methods().slice(fake.methods().lastIndexOf('Page.captureScreenshot'))).not.toContain('Overlay.highlightQuad')
  })

  it('draws nothing without the window\'s style, with the full catalog off, or while the user points', async () => {
    const plain = page()
    await automation(plain).input({ type: 'click', x: 10, y: 10 }, go)
    const off = page()
    await automation(off, { parity: false, cursor: true }).input({ type: 'click', x: 10, y: 10 }, go)
    for (const fake of [plain, off]) expect(fake.methods().filter(method => method.startsWith('Overlay.highlight'))).toEqual([])
    const pointing = page(), pointer = automation(pointing, { cursor: true })
    await pointer.point({ r: 1, g: 2, b: 3 }, { hover: go, pick: go })
    await pointer.input({ type: 'click', x: 10, y: 10 }, go)
    expect(pointing.calls('Overlay.highlightQuad')).toEqual([])
  })

  it('never fails the action when the overlay will not draw', async () => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => method.startsWith('Overlay.') ? Promise.reject(new Error('Overlay is not enabled')) : base(method, params)
    const automation_ = automation(fake, { cursor: true, reducedMotion: true })
    await expect(automation_.input({ type: 'click', x: 30, y: 40 }, go)).resolves.toBeUndefined()
    expect(fake.calls('Input.dispatchMouseEvent').some(params => params.type === 'mousePressed')).toBe(true)
  })
})

describe('typing a secret (ADR-0219, as Gemini\'s review asked)', () => {
  it('focuses the password field named, checks the focus right before typing, and types nothing else', async () => {
    const focus = { node: 9 }, fake = page(focus), automation_ = automation(fake)
    await automation_.typeSecret('hunter2-secret', go, { selector: '#password' })
    expect(fake.calls('DOM.focus')).toEqual([{ backendNodeId: 7 }])
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
    // The last look at the focus comes right before the value goes.
    const methods = fake.methods()
    expect(methods.lastIndexOf('DOM.describeNode')).toBeLessThan(methods.indexOf('Input.insertText'))
  })

  it('refuses when the field named is not a password field', async () => {
    const fake = page(), automation_ = automation(fake)
    await expect(automation_.typeSecret('hunter2-secret', go, { selector: '#name' })).rejects.toMatchObject({ code: 'blocked' })
    expect(fake.calls('Input.insertText')).toEqual([])
  })

  it('refuses when the page moves the focus away from the field before the value goes', async () => {
    const focus = { node: 7 }, fake = page(focus), base = fake.handle
    let looks = 0
    fake.handle = (method, params) => {
      // The page's script moves the focus to the text field after the first look.
      if (method === 'Runtime.evaluate' && params.expression === 'document.activeElement' && ++looks === 2) focus.node = 9
      return base(method, params)
    }
    const automation_ = automation(fake)
    await expect(automation_.typeSecret('hunter2-secret', go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked' })
    expect(fake.calls('Input.insertText')).toEqual([])
    expect(automation_.holdsSecret()).toBe(false)
  })

  it('refuses when a different password field has the focus than the one named', async () => {
    const focus = { node: 7 }, fake = page(focus), base = fake.handle
    fake.handle = (method, params) => method === 'DOM.focus' ? {} : method === 'DOM.describeNode' && params.objectId === 'active' ? { node: { backendNodeId: 8 } } : method === 'DOM.describeNode' && params.backendNodeId === 8 ? { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } } : base(method, params)
    await expect(automation(fake).typeSecret('hunter2-secret', go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('did not take the focus') })
    expect(fake.calls('Input.insertText')).toEqual([])
  })

  it('replaces what the field held when asked to clear it, and appends otherwise', async () => {
    const cleared = page(), clearing = automation(cleared)
    await clearing.typeSecret('hunter2-secret', go, { selector: '#password' }, true)
    const methods = cleared.sent.map(entry => entry.method === 'Runtime.evaluate' && String(entry.params.expression).includes('select()') ? 'select' : entry.method)
    expect(methods.indexOf('select')).toBeGreaterThan(-1)
    expect(methods.indexOf('select')).toBeLessThan(methods.indexOf('Input.insertText'))
    const kept = page(), keeping = automation(kept)
    await keeping.typeSecret('hunter2-secret', go, { selector: '#password' })
    expect(kept.calls('Runtime.evaluate').some(params => String(params.expression).includes('select()'))).toBe(false)
  })

  it('types into the focused password field when none is named, and refuses a focused text field', async () => {
    const fake = page({ node: 7 }), automation_ = automation(fake)
    await automation_.typeSecret('hunter2-secret', go)
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
    const text = page({ node: 9 })
    await expect(automation(text).typeSecret('hunter2-secret', go)).rejects.toMatchObject({ code: 'blocked' })
    expect(text.calls('Input.insertText')).toEqual([])
  })
})

describe('a document that holds a typed secret (ADR-0220, decision 6)', () => {
  const typed = async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret('hunter2-secret', go, { selector: '#password' })
    return { fake, automation_ }
  }

  it('keeps evaluate off through a hash change, a load that never commits, Stop sharing and a new attachment', async () => {
    const { fake, automation_ } = await typed()
    await expect(automation_.evaluate('document.querySelector("#password").value')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret') })
    // A navigation starting (the desktop's did-start-navigation, a load) clears the page's refs and errors, not this.
    automation_.clear()
    fake.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://shop.example/checkout#pay' })
    fake.emit('Page.frameNavigated', { frame: { id: 'ad', parentId: 'main', url: 'https://ads.example/' } })
    expect(automation_.holdsSecret()).toBe(true)
    // Stop sharing detaches; sharing again reattaches the same document.
    automation_.dispose()
    expect(automation_.holdsSecret()).toBe(true)
    fake.attached = false
    await expect(automation_.evaluate('1 + 1')).rejects.toMatchObject({ code: 'blocked' })
    expect(fake.calls('Runtime.evaluate').some(params => String(params.expression).includes('.value'))).toBe(false)
  })

  it('turns evaluate back on once a new document commits in the main frame', async () => {
    const { fake, automation_ } = await typed()
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/thanks' } })
    expect(automation_.holdsSecret()).toBe(false)
    fake.handle = (method) => method === 'Runtime.evaluate' ? { result: { type: 'number', value: 2 } } : {}
    expect(await automation_.evaluate('1 + 1')).toBe('2')
  })

  it('turns evaluate back on when the desktop says a new document committed', async () => {
    const { automation_ } = await typed()
    automation_.documentCommitted()
    expect(automation_.holdsSecret()).toBe(false)
  })

  it('still masks the secret in what the page says back once the document has gone', async () => {
    const { fake, automation_ } = await typed()
    automation_.documentCommitted()
    fake.handle = (method) => method === 'Runtime.evaluate' ? { result: { type: 'string', value: 'echo hunter2-secret' } } : {}
    expect(await automation_.evaluate('window.name')).toBe('"echo ••••••••"')
  })
})

describe('a page\'s dialog words (Gemini\'s review)', () => {
  const opened = (fake: FakePage, message: string): void => fake.emit('Page.javascriptDialogOpening', { type: 'alert', message })

  it('masks a typed secret in the refusal an open dialog gives', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret('hunter2-secret', go, { selector: '#password' })
    automation_.documentCommitted()
    opened(fake, 'Your password is hunter2-secret')
    await expect(automation_.inspect().then(() => automation_.snapshotText())).rejects.toMatchObject({ message: expect.stringContaining('Your password is ••••••••') })
    await expect(automation_.snapshotText()).rejects.toMatchObject({ message: expect.not.stringContaining('hunter2') })
  })

  it('leaves the dialog\'s words out while the document holds a secret', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret('hunter2-secret', go, { selector: '#password' })
    // The page's script could put the field's value into the words in any form: reversed, encoded, split.
    opened(fake, 'terces-2retnuh')
    for (const attempt of [() => automation_.snapshotText(), () => automation_.input({ type: 'click', x: 1, y: 1 }, go), () => automation_.capture('https://shop.example/')]) {
      const refused = await attempt().then(() => null, (error: Error) => error)
      expect(refused?.message).toContain('alert dialog open')
      expect(refused?.message).not.toContain('terces')
    }
  })

  it('says a dialog\'s words, masked, when no secret is in the document', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.inspect()
    opened(fake, 'Leave this page?')
    await expect(automation_.snapshotText()).rejects.toMatchObject({ message: expect.stringContaining('"Leave this page?"') })
  })
})

describe('the file chooser an agent\'s click may open (Gemini\'s review)', () => {
  const interception = (fake: FakePage): unknown[] => fake.calls('Page.setInterceptFileChooserDialog').map(params => params.enabled)

  it('gives the system\'s chooser back after a click that opened none', async () => {
    const fake = page()
    await automation(fake).input({ type: 'click', x: 5, y: 5 }, go)
    expect(interception(fake)).toEqual([true, false])
  })

  it('gives it back after a click that failed', async () => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? Promise.reject(new Error('Target closed')) : base(method, params)
    await expect(automation(fake).input({ type: 'click', x: 5, y: 5 }, go)).rejects.toThrow()
    expect(interception(fake)).toEqual([true, false])
  })

  it('gives it back once a dialog the click opened is answered, sending nothing in front of the answer', async () => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') { fake.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' }); return new Promise(() => undefined) }
      return base(method, params)
    }
    const automation_ = automation(fake, { cursor: true, reducedMotion: true })
    expect(await automation_.input({ type: 'click', x: 5, y: 5 }, go)).toContain('confirm dialog')
    // While the dialog holds the page, Chromium runs no command for it until the dialog is answered, so nothing is sent
    // that the answer would wait behind: not the chooser given back, not the click's ring, not the cursor taken off.
    const sentWhileOpen = fake.sent.length
    expect(interception(fake)).toEqual([true])
    await new Promise(resolve => setTimeout(resolve, 300))
    await automation_.hideCursor()
    expect(fake.sent.slice(sentWhileOpen).map(entry => entry.method)).toEqual([])
    await automation_.answerDialog(true)
    expect(fake.methods().at(-1)).toBe('Page.handleJavaScriptDialog')
    fake.emit('Page.javascriptDialogClosed', { result: true })
    await Promise.resolve()
    expect(interception(fake)).toEqual([true, false])
  })

  it('keeps it held while a chooser waits for upload, and gives it back when the page navigates', async () => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') fake.emit('Page.fileChooserOpened', { backendNodeId: 11, mode: 'selectSingle' })
      return base(method, params)
    }
    const automation_ = automation(fake)
    expect(await automation_.input({ type: 'click', x: 5, y: 5 }, go)).toContain('file chooser')
    expect(interception(fake)).toEqual([true])
    expect(automation_.choosing()).toBe(true)
    automation_.clear()
    expect(automation_.choosing()).toBe(false)
    await Promise.resolve()
    expect(interception(fake)).toEqual([true, false])
  })
})

describe('a snapshot\'s size and the attributes it reads', () => {
  it('cuts a snapshot at its total and says so', async () => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => method === 'Runtime.evaluate' && String(params.expression).includes('innerText') ? { result: { value: { title: 'Long', text: 'x'.repeat(30_000), state: 'complete' } } } : base(method, params)
    const automation_ = automation(fake)
    for (let index = 0; index < 100; index++) fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'y'.repeat(500) }] })
    for (let index = 0; index < 40; index++) fake.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'z'.repeat(2000) } })
    const nodes = Array.from({ length: 3000 }, (_, index) => ({ nodeId: String(index), role: { value: 'button' }, name: { value: `Button ${'w'.repeat(200)} ${index}` }, backendDOMNodeId: index + 1 }))
    const huge = fake.handle
    fake.handle = (method, params) => method === 'Accessibility.getFullAXTree' ? { nodes } : huge(method, params)
    const said = await automation_.snapshotText()
    expect(said.length).toBeLessThanOrEqual(SNAPSHOT_TOTAL + 200)
  })

  it('reads an attribute by walking name and value pairs, not by finding the word', () => {
    expect(attributeOf(['aria-label', 'type', 'type', 'text'], 'type')).toBe('text')
    expect(attributeOf(['title', 'file', 'type', 'password'], 'type')).toBe('password')
    expect(attributeOf(['TYPE', 'file'], 'type')).toBe('file')
    expect(attributeOf(['type'], 'type')).toBeUndefined()
    expect(attributeOf(undefined, 'type')).toBeUndefined()
  })
})


describe('what is masked (ADR-0219)', () => {
  it('masks a typed secret as written, as JSON writes it, and as an address or a GET form carries it', async () => {
    const fake = page(), automation_ = automation(fake)
    const secret = 'pa ss&word"1'
    await automation_.typeSecret(secret, go, { selector: '#password' })
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/gu, '+')]) {
      expect(automation_.masked(`before ${form} after`)).toBe('before •••••••• after')
    }
  })
})
