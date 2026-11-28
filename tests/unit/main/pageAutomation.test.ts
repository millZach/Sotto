// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attributeOf, CURSOR_ARROW, DOUBLE_TAP_GAP_MS, PageAutomation, SNAPSHOT_TOTAL, type PageDebugger, type PageEventListener, type PageFrame, type PageInput, type PagePicture } from '../../../src/main/tools/pageAutomation'
import { ToolFailure } from '../../../src/main/tools/common'
import { maskSecrets } from '../../../src/main/tools/secretMask'
import { SECRET_VALUE_MAX } from '../../../src/shared/secretRequests'

// The real matcher, wrapped so a test can make it fail once and see what the page then says back.
vi.mock('../../../src/main/tools/secretMask', async importOriginal => {
  const real = await importOriginal<typeof import('../../../src/main/tools/secretMask')>()
  return { ...real, maskSecrets: vi.fn(real.maskSecrets) }
})

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
/** A secret reference's value as main hands it over, at the moment it is typed. */
const given = (value: string) => async (): Promise<string | null> => value

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
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    expect(fake.calls('DOM.focus')).toEqual([{ backendNodeId: 7 }])
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
    // The last look at the focus comes right before the value goes.
    const methods = fake.methods()
    expect(methods.lastIndexOf('DOM.describeNode')).toBeLessThan(methods.indexOf('Input.insertText'))
  })

  it('refuses when the field named is not a password field', async () => {
    const fake = page(), automation_ = automation(fake)
    await expect(automation_.typeSecret(given('hunter2-secret'), go, { selector: '#name' })).rejects.toMatchObject({ code: 'blocked' })
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
    await expect(automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked' })
    expect(fake.calls('Input.insertText')).toEqual([])
    expect(automation_.holdsSecret()).toBe(false)
  })

  it('refuses when a different password field has the focus than the one named', async () => {
    const focus = { node: 7 }, fake = page(focus), base = fake.handle
    fake.handle = (method, params) => method === 'DOM.focus' ? {} : method === 'DOM.describeNode' && params.objectId === 'active' ? { node: { backendNodeId: 8 } } : method === 'DOM.describeNode' && params.backendNodeId === 8 ? { node: { nodeName: 'INPUT', attributes: ['type', 'password'] } } : base(method, params)
    await expect(automation(fake).typeSecret(given('hunter2-secret'), go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('did not take the focus') })
    expect(fake.calls('Input.insertText')).toEqual([])
  })

  it('replaces what the field held when asked to clear it, and appends otherwise', async () => {
    const cleared = page(), clearing = automation(cleared)
    await clearing.typeSecret(given('hunter2-secret'), go, { selector: '#password' }, true)
    const methods = cleared.sent.map(entry => entry.method === 'Runtime.evaluate' && String(entry.params.expression).includes('select()') ? 'select' : entry.method)
    expect(methods.indexOf('select')).toBeGreaterThan(-1)
    expect(methods.indexOf('select')).toBeLessThan(methods.indexOf('Input.insertText'))
    const kept = page(), keeping = automation(kept)
    await keeping.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    expect(kept.calls('Runtime.evaluate').some(params => String(params.expression).includes('select()'))).toBe(false)
  })

  it('types into the focused password field when none is named, and refuses a focused text field', async () => {
    const fake = page({ node: 7 }), automation_ = automation(fake)
    await automation_.typeSecret(given('hunter2-secret'), go)
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
    const text = page({ node: 9 })
    await expect(automation(text).typeSecret(given('hunter2-secret'), go)).rejects.toMatchObject({ code: 'blocked' })
    expect(text.calls('Input.insertText')).toEqual([])
  })
})

describe('a document that holds a typed secret (ADR-0220, decision 6)', () => {
  const typed = async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    return { fake, automation_ }
  }

  it('keeps evaluate off through a hash change, a load that never commits, Stop sharing and a new attachment', async () => {
    const { fake, automation_ } = await typed()
    await expect(automation_.evaluate('document.querySelector("#password").value')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('typed into this page') })
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

  it('takes a new document in the main frame as one no secret is in, while evaluate stays off for the page', async () => {
    const { fake, automation_ } = await typed()
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/thanks' } })
    expect(automation_.holdsSecret()).toBe(false)
    fake.handle = (method) => method === 'Runtime.evaluate' ? { result: { type: 'number', value: 2 } } : {}
    await expect(automation_.evaluate('1 + 1')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('new page') })
  })

  it('takes the desktop\'s word that a new document committed', async () => {
    const { automation_ } = await typed()
    automation_.documentCommitted()
    expect(automation_.holdsSecret()).toBe(false)
  })

  it('still masks the secret in what the page says back once the document has gone', async () => {
    const { fake, automation_ } = await typed()
    automation_.documentCommitted()
    const base = fake.handle
    fake.handle = (method, params) => method === 'Accessibility.getFullAXTree' ? { nodes: [] }
      : method === 'Runtime.evaluate' && String(params.expression).includes('document.title') ? { result: { value: { title: 'Account', text: 'echo hunter2-secret', state: 'complete' } } }
        : base(method, params)
    const said = await automation_.snapshotText()
    expect(said).toContain('echo ••••••••')
    expect(said).not.toContain('hunter2')
  })

  it('leaves out what a field holds while the document holds the secret, so an edited value cannot come out a piece at a time', async () => {
    const fake = page(), base = fake.handle, automation_ = automation(fake)
    // The site's "show password" button made the field a text field, and an edit took the first character off.
    const tree = { nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'unter2-secret' }, backendDOMNodeId: 7, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { value: 'StaticText' }, name: { value: 'unter2-secret' } },
    ] }
    fake.handle = (method, params) => method === 'Accessibility.getFullAXTree' ? tree
      : method === 'Runtime.evaluate' && String(params.expression).includes('document.title') ? { result: { value: { title: 'Sign in', text: '', state: 'complete' } } }
        : base(method, params)
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    const said = await automation_.snapshotText()
    expect(said).toContain('textbox "Password" [value hidden')
    expect(said).not.toContain('unter2')
    expect(await automation_.inspect()).not.toContain('unter2')
    // Another document holds no secret, and its fields read as before.
    automation_.documentCommitted()
    expect(await automation_.snapshotText()).toContain('value="unter2-secret"')
  })
})

describe('a page\'s dialog words (Gemini\'s review)', () => {
  const opened = (fake: FakePage, message: string): void => fake.emit('Page.javascriptDialogOpening', { type: 'alert', message })

  it('masks a typed secret in the refusal an open dialog gives', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    automation_.documentCommitted()
    opened(fake, 'Your password is hunter2-secret')
    await expect(automation_.inspect().then(() => automation_.snapshotText())).rejects.toMatchObject({ message: expect.stringContaining('Your password is ••••••••') })
    await expect(automation_.snapshotText()).rejects.toMatchObject({ message: expect.not.stringContaining('hunter2') })
  })

  it('leaves the dialog\'s words out while the document holds a secret', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
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
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    for (const form of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), encodeURIComponent(secret).replace(/%20/gu, '+')]) {
      expect(automation_.masked(`before ${form} after`)).toBe('before •••••••• after')
    }
  })

  it('masks a typed secret in an address however it is escaped, a stray % beside it included', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('pa!ss~\'1'), go, { selector: '#password' })
    for (const escaped of [
      // The second review's address: a stray % first, then lower-case hex.
      'pa%21ss%7e%271', 'pa%21ss%7E%271', 'pa!ss~\'1', 'p%61!ss%7E\'1', '%70%61%21%73%73%7e%27%31',
      // Escaped twice, as an address carried inside another one is.
      'pa%2521ss%257e%25271',
    ]) expect(automation_.masked(`https://shop.example/session?discount=100%&p=${escaped}&next=1`)).toBe('https://shop.example/session?discount=100%&p=••••••••&next=1')
    // A value with a space and a letter outside ASCII, as a form, an address and JSON each write them.
    const other = page(), others = automation(other), wide = 'pä ss wörd'
    await others.typeSecret(given(wide), go, { selector: '#password' })
    for (const form of [encodeURIComponent(wide), encodeURIComponent(wide).replace(/%20/gu, '+').toLowerCase(), JSON.stringify(wide).slice(1, -1), 'p\\u00e4 ss w\\u00F6rd', 'p%C3%A4 ss+w%c3%b6rd']) {
      expect(others.masked(`[${form}]`)).toBe('[••••••••]')
    }
  })

  it('masks a space a form sent as + and an address then escaped again, as %2B or %252B (the third review)', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('my pass'), go, { selector: '#password' })
    for (const form of ['my%2Bpass', 'my%2bpass', 'my%252Bpass', 'my+pass']) expect(automation_.masked(`https://app.example/?next=%2F%3Fp%3D${form}&x=1`)).toBe('https://app.example/?next=%2F%3Fp%3D••••••••&x=1')
    // A + in the secret is found escaped too.
    const plus = page(), plusses = automation(plus)
    await plusses.typeSecret(given('a+b=c'), go, { selector: '#password' })
    for (const form of ['a+b=c', 'a%2Bb%3Dc', 'a%252Bb%253Dc', 'a\\u002bb\\u003dc']) expect(plusses.masked(`[${form}]`)).toBe('[••••••••]')
  })

  it('leaves a secret shorter than three characters unmasked everywhere, and keeps its page\'s rules (the third review)', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('/'), go, { selector: '#password' })
    // Masking a single character, raw or escaped, would mangle every address the page gives.
    expect(automation_.masked('https://app.example/a?next=https%3A%2F%2Fapp.example%2Fb')).toBe('https://app.example/a?next=https%3A%2F%2Fapp.example%2Fb')
    // evaluate stays off all the same.
    await expect(automation_.evaluate('1')).rejects.toMatchObject({ code: 'blocked' })
  })

  it('offers a new page in the evaluate refusal only where an agent can open one, not in a profile (the third review)', async () => {
    const own = automation(page()), signedIn = automation(page())
    signedIn.inProfile = true
    for (const each of [own, signedIn]) await each.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    await expect(own.evaluate('1')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('or open a new page') })
    await expect(signedIn.evaluate('1')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('Use snapshot, click and type.') })
    await expect(signedIn.evaluate('1')).rejects.toMatchObject({ message: expect.not.stringContaining('new page') })
  })

  it('keeps the page\'s own origin whole, and masks the secret everywhere else, the same address\'s path included (the third review)', async () => {
    // The page is on https://shop.example, and the secret is also part of its host.
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('shop'), go, { selector: '#password' })
    expect(automation_.masked('Signed in at https://shop.example/account?pin=shop')).toBe('Signed in at https://shop.example/account?pin=••••••••')
    // A match that runs past the origin is not inside it, so it is masked.
    expect(automation_.maskedUrl('https://shop.example/shop')).toBe('https://shop.example/••••••••')
    // Another site's address keeps its own origin when asked as an address, and only its own.
    expect(automation_.maskedUrl('https://workshop.example/?a=shop')).toBe('https://workshop.example/?a=••••••••')
    expect(automation_.masked('https://workshop.example/')).toBe('https://work••••••••.example/')
  })
})

describe('nothing moves a typed secret\'s text out of its document (the third review, Q-L3)', () => {
  type Key = Extract<PageInput, { type: 'key' }>
  const key = (pressed: string, ...modifiers: NonNullable<Key['modifiers']>): Key => ({ type: 'key', key: pressed, modifiers })
  /**
   * A page whose fields keep what is typed into them, and answer Sotto's read of one, by the focus or by node, as
   * Chromium would: the password field at 7 and the text field at 9.
   */
  const withFields = (focus: { node: number }): { fake: FakePage; values: Map<number, string> } => {
    const fake = page(focus), base = fake.handle, values = new Map<number, string>()
    fake.handle = (method, params) => {
      if (method === 'Input.insertText') values.set(focus.node, (values.get(focus.node) ?? '') + String(params.text))
      if (method === 'Runtime.evaluate' && String(params.expression).includes('.call(document.activeElement')) return { result: { value: values.get(focus.node) ?? '' } }
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${String(params.backendNodeId)}` } }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('isContentEditable')) return { result: { value: values.get(Number(String(params.objectId).slice('node-'.length))) ?? '' } }
      return base(method, params)
    }
    return { fake, values }
  }
  /** The secret typed into the password field, and the focus then on the text field beside it. */
  const holding = async (focus = { node: 9 }, options: { parity?: boolean } = {}): Promise<{ fake: FakePage; automation_: TestAutomation; values: Map<number, string> }> => {
    const { fake, values } = withFields(focus), automation_ = automation(fake, options)
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    expect(values.get(7)).toBe('hunter2-secret')
    focus.node = 9
    return { fake, automation_, values }
  }
  /** Every chord that selects, copies or cuts on Windows, Linux or macOS, whichever platform Sotto runs on. */
  const chords: Key[] = [
    key('a', 'Control'), key('c', 'Control'), key('x', 'Control'), key('A', 'Control'), key('C', 'Control', 'Shift'),
    key('a', 'Meta'), key('c', 'Meta'), key('x', 'Meta'), key('c', 'Meta', 'Alt'), key('X', 'Meta', 'Shift'),
    key('Insert', 'Control'), key('Delete', 'Shift'),
    key('ArrowLeft', 'Shift'), key('ArrowRight', 'Shift', 'Control'), key('Home', 'Shift'), key('End', 'Shift', 'Meta'), key('ArrowUp', 'Shift', 'Alt'), key('ArrowDown', 'Shift'), key('PageUp', 'Shift'), key('PageDown', 'Shift'),
  ]
  const selecting = [
    { type: 'click', x: 5, y: 5, clickCount: 2 }, { type: 'click', x: 5, y: 5, clickCount: 3 }, { type: 'click', x: 5, y: 5, modifiers: ['Shift'] },
    { type: 'click', x: 5, y: 5, button: 'middle' }, { type: 'drag', from: { x: 5, y: 5 }, to: { x: 50, y: 5 } },
  ] as const satisfies readonly PageInput[]

  it('refuses every chord that would select, copy or cut, on every platform, when asked and when run, and sends no key', async () => {
    const { fake, automation_ } = await holding()
    for (const chord of chords) {
      const label = [...chord.modifiers ?? [], chord.key].join('+')
      await expect(automation_.target(chord), label).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
      await expect(automation_.input(chord, go), label).rejects.toMatchObject({ code: 'blocked' })
    }
    expect(fake.calls('Input.dispatchKeyEvent')).toEqual([])
  })

  it('refuses a double or triple click, a click with Shift or the middle button, and a drag, and presses nothing', async () => {
    const { fake, automation_ } = await holding()
    for (const action of selecting) {
      await expect(automation_.target(action), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
      await expect(automation_.input(action, go), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked' })
    }
    expect(fake.calls('Input.dispatchMouseEvent')).toEqual([])
    // One click, a right click and a key that types still go.
    await automation_.input({ type: 'click', x: 5, y: 5 }, go)
    await automation_.input({ type: 'click', x: 5, y: 5, button: 'right' }, go)
    await automation_.input(key('a'), go)
    expect(fake.calls('Input.dispatchMouseEvent').filter(event => event.type === 'mousePressed')).toHaveLength(2)
  })

  it('types and deletes nothing in a field that holds the secret, while Enter, Tab, Escape and the caret keys still go', async () => {
    const focus = { node: 9 }, { fake, automation_, values } = await holding(focus)
    focus.node = 7
    const edits = [
      key('Backspace'), key('Delete'), key('Backspace', 'Control'), key('z'), key('z', 'Control'), key('Space'), key('v', 'Control'), key('v', 'Meta'), key('Insert', 'Shift'), key('Insert'), key('ContextMenu'),
      { type: 'type', text: 'x' }, { type: 'type', text: 'x', clear: true }, { type: 'type', text: 'x', selector: '#password' },
    ] as const satisfies readonly PageInput[]
    for (const action of edits) {
      await expect(automation_.target(action), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
      await expect(automation_.input(action, go), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked' })
    }
    // A secretRef typed beside it is refused before its value is taken, so the reference is not spent.
    const take = vi.fn(given('another-secret'))
    await expect(automation_.target({ type: 'type', secretRef: 'sr_next', selector: '#password' })).rejects.toMatchObject({ code: 'blocked' })
    await expect(automation_.typeSecret(take, go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('clear: true') })
    expect(take).not.toHaveBeenCalled()
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
    expect(values.get(7)).toBe('hunter2-secret')
    for (const pressed of [key('Enter'), key('Tab'), key('Tab', 'Shift'), key('Escape'), key('ArrowLeft'), key('End')]) {
      await automation_.target(pressed)
      await automation_.input(pressed, go)
    }
    expect(fake.calls('Input.dispatchKeyEvent').map(event => event.key)).toEqual(['Enter', 'Enter', 'Tab', 'Tab', 'Tab', 'Tab', 'Escape', 'Escape', 'ArrowLeft', 'ArrowLeft', 'End', 'End'])
    // With clear, the secretRef replaces the whole of it.
    await automation_.target({ type: 'type', secretRef: 'sr_next', selector: '#password', clear: true })
    await automation_.typeSecret(take, go, { selector: '#password' }, true)
    expect(take).toHaveBeenCalledOnce()
  })

  it('finds the secret by what a field holds, so a field a site copied it into is kept as well', async () => {
    const focus = { node: 9 }, { fake, automation_, values } = await holding(focus)
    // Another field takes typing, Backspace and any key while it holds none of it.
    for (const action of [{ type: 'type', text: 'rez@example.com' }, key('Backspace'), key('a')] as const satisfies readonly PageInput[]) {
      await automation_.target(action)
      await automation_.input(action, go)
    }
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }, { text: 'rez@example.com' }])
    // A site's "show password" that copies the value into this text field, or a paste of it there.
    values.set(9, 'hunter2-secret')
    for (const action of [key('Backspace'), { type: 'type', text: 'x' }, { type: 'type', text: 'x', selector: '#name' }] as const satisfies readonly PageInput[]) {
      await expect(automation_.target(action), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
      await expect(automation_.input(action, go), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked' })
    }
    // One escaped as a page might keep it is found too.
    values.set(9, 'hunter2%2Dsecret')
    await expect(automation_.input(key('Backspace'), go)).rejects.toMatchObject({ code: 'blocked' })
  })

  it('lets every chord, click and drag through once another document loads, while a field holding the secret stays unedited', async () => {
    const focus = { node: 9 }, { fake, automation_, values } = await holding(focus)
    automation_.documentCommitted()
    for (const action of [...chords, ...selecting, { type: 'type', text: 'x', clear: true }] as const satisfies readonly PageInput[]) await automation_.input(action, go)
    expect(fake.calls('Input.dispatchKeyEvent')).toHaveLength(chords.length * 2)
    expect(fake.calls('Input.dispatchMouseEvent').filter(event => event.type === 'mousePressed').length).toBeGreaterThanOrEqual(5)
    // A site can write the secret back into a later document: a field holding it is still not edited, for the page's life.
    values.set(9, 'hunter2-secret')
    await expect(automation_.input(key('Backspace'), go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
    // A page that never held a secret reads no field and refuses nothing.
    const plain = page(), plainly = automation(plain)
    for (const action of [...chords, ...selecting, key('Backspace')] as const satisfies readonly PageInput[]) await plainly.input(action, go)
    expect(plain.calls('Input.dispatchKeyEvent')).toHaveLength((chords.length + 1) * 2)
    expect(plain.calls('Runtime.callFunctionOn')).toEqual([])
    expect(plain.calls('Runtime.evaluate').filter(call => String(call.expression).includes('.call(document.activeElement'))).toEqual([])
  })

  it('holds a tap straight after another back while the document holds a secret, so the two are never a double tap', async () => {
    const touches = (fake: FakePage): number[] => {
      const at: number[] = [], base = fake.handle
      fake.handle = (method, params) => { if (method === 'Input.dispatchTouchEvent') at.push(Date.now()); return base(method, params) }
      return at
    }
    const { fake, automation_ } = await holding(undefined, { parity: false })
    const at = touches(fake)
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    // touchStart, touchEnd, then the second tap's touchStart.
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(DOUBLE_TAP_GAP_MS - 2)
    // Another document: the second tap goes at once.
    automation_.documentCommitted()
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    expect(at[6]! - at[5]!).toBeLessThan(DOUBLE_TAP_GAP_MS - 100)
  })
})

describe('masking a typed secret stays linear and cannot throw (the third review)', () => {
  /** Characters a pattern would have had to escape, a backslash and a quote among them, and some beyond ASCII. */
  const awkward = [...'\\"%+ /.*?()[]{}|^$aZ9é😀']
  /** A secret `length` code units long, as a card counts them, made of `awkward` and never splitting a character. */
  const longSecret = (length: number): string => {
    let made = ''
    for (let index = 0; ; index++) {
      const next = awkward[index % awkward.length]!
      if (made.length + next.length > length) return made.padEnd(length, 'a')
      made += next
    }
  }
  const typed = async (secret: string): Promise<TestAutomation> => { const automation_ = automation(page()); await automation_.typeSecret(given(secret), go, { selector: '#password' }); return automation_ }
  const time = (work: () => unknown): number => { const started = performance.now(); work(); return performance.now() - started }

  it('masks a secret of the longest length a card takes, as written, escaped and as JSON writes it', async () => {
    const secret = longSecret(SECRET_VALUE_MAX), automation_ = await typed(secret)
    expect(secret).toHaveLength(SECRET_VALUE_MAX)
    for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), encodeURIComponent(encodeURIComponent(secret))]) {
      expect(automation_.masked(`before ${form} after`)).toBe('before •••••••• after')
    }
    // The page's own words beside it, and a page that does not hold it, come back as they are.
    expect(automation_.masked('Sign in to continue')).toBe('Sign in to continue')
  })

  it('masks a page of a megabyte and more, in time that grows only with the text, however the text is built', async () => {
    const backslashes = '\\'.repeat(16_383) + 'Z', quoted = '\\"'.repeat(8_191) + 'Z'
    const cases: { secret: string; text: string }[] = [
      // A pattern with a backslash in it backtracked for ever on a run of backslashes that ends wrong.
      { secret: '\\'.repeat(24) + 'Z', text: ('\\'.repeat(36) + 'X').repeat(12) },
      { secret: '\\"'.repeat(22) + 'Z', text: ('\\"'.repeat(33) + 'X').repeat(12) },
      { secret: backslashes, text: '\\'.repeat(1_100_000) },
      { secret: quoted, text: '\\"'.repeat(550_000) },
      { secret: '%'.repeat(16_000) + 'Z', text: '%25'.repeat(400_000) },
      { secret: longSecret(16_384), text: `${longSecret(16_383)}X`.repeat(70) },
    ]
    for (const { secret, text } of cases) {
      const automation_ = await typed(secret)
      // A page of the same length that holds nothing like the secret is the yardstick, so a slow machine is not a failure.
      const plain = time(() => automation_.masked('a'.repeat(text.length)))
      const hostile = time(() => expect(automation_.masked(text)).not.toContain(secret))
      expect(hostile, `${secret.length} characters against ${text.length}`).toBeLessThan(plain * 20 + 500)
    }
  })

  it('shows nothing of a text it could not check, and the failure carries nothing of the secret', async () => {
    const secret = 'hunter2-secret', automation_ = await typed(secret)
    vi.mocked(maskSecrets).mockImplementationOnce(() => { throw new SyntaxError(`Invalid regular expression: /${secret}/`) })
    let said = ''
    expect(() => { said = automation_.masked(`Your password is ${secret}`) }).not.toThrow()
    expect(said).toBe('••••••••')
    // What the page says back goes through the same mask: the snapshot is all mask, not the page's raw words.
    vi.mocked(maskSecrets).mockImplementationOnce(() => { throw new RangeError(secret) })
    const snapshot = await automation_.snapshotText()
    expect(snapshot).toBe('••••••••')
    expect(vi.mocked(maskSecrets)).toHaveBeenCalled()
  })
})

describe('where a secret is not typed (the review of the browser-parity branch)', () => {
  /** A page whose document is at `origin`, as `location.origin` says it. */
  const at = (origin: string, focus: { node: number } = { node: 7 }): FakePage => {
    const fake = page(focus), base = fake.handle
    fake.handle = (method, params) => method === 'Runtime.evaluate' && params.expression === 'location.origin' ? { result: { type: 'string', value: origin } } : base(method, params)
    return fake
  }
  const counted = () => { const take = { calls: 0, fn: async (): Promise<string | null> => { take.calls++; return 'hunter2-secret' } }; return take }

  it('refuses a document the agent ran script in, before the value is taken, until another document commits', async () => {
    const fake = at('https://github.com'), automation_ = automation(fake), take = counted()
    fake.handle = ((base: Handler) => (method: string, params: Record<string, unknown>) => method === 'Runtime.evaluate' && params.userGesture ? { result: { type: 'string', value: 'ok' } } : base(method, params))(fake.handle)
    await automation_.evaluate('document.querySelector("#password").addEventListener("input", () => undefined)')
    await expect(automation_.typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('ran a script') })
    // Asked for, it is refused before the user is asked.
    await expect(automation_.target({ type: 'type', selector: '#password', secretRef: `secret-ref:${'a'.repeat(32)}` })).rejects.toMatchObject({ code: 'blocked' })
    expect(take.calls).toBe(0)
    expect(fake.calls('Input.insertText')).toEqual([])
    // A hash change keeps the document; a new one commits without the agent's script.
    fake.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://github.com/login#again' })
    await expect(automation_.typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')).rejects.toMatchObject({ code: 'blocked' })
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://github.com/login' } })
    await automation_.typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')
    expect(take.calls).toBe(1)
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
  })

  it('takes the value only after every check, so a refused focus spends nothing', async () => {
    const focus = { node: 9 }, fake = at('https://github.com', focus), base = fake.handle, take = counted()
    fake.handle = (method, params) => method === 'DOM.focus' ? {} : base(method, params)
    await expect(automation(fake).typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')).rejects.toMatchObject({ code: 'blocked' })
    expect(take.calls).toBe(0)
  })

  it('types nothing when the document is not at the site the value is for', async () => {
    const fake = at('https://attacker.example'), take = counted()
    await expect(automation(fake).typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('https://github.com') })
    expect(take.calls).toBe(0)
    expect(fake.calls('Input.insertText')).toEqual([])
    const own = at('https://github.com')
    await automation(own).typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')
    expect(own.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
  })

  it('looks again once the value has come from the engine, and types nothing into a page that changed meanwhile', async () => {
    const focus = { node: 7 }, moved = at('https://github.com', focus)
    // The page moves the focus while the value is on its way.
    await expect(automation(moved).typeSecret(async () => { focus.node = 9; return 'hunter2-secret' }, go, { selector: '#password' }, false, 'https://github.com'))
      .rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('lost focus') })
    expect(moved.calls('Input.insertText')).toEqual([])
    let origin = 'https://github.com'
    const away = page(), base = away.handle
    away.handle = (method, params) => method === 'Runtime.evaluate' && params.expression === 'location.origin' ? { result: { type: 'string', value: origin } } : base(method, params)
    await expect(automation(away).typeSecret(async () => { origin = 'https://attacker.example'; return 'hunter2-secret' }, go, { selector: '#password' }, false, 'https://github.com'))
      .rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('is used') })
    expect(away.calls('Input.insertText')).toEqual([])
  })

  it('finds a secret in an address a form sent, whichever characters the form encoded', async () => {
    // A form's encoding also escapes ! ' ( ) and ~, which encodeURIComponent leaves.
    const secret = 'pa!ss(1)~\'x y'
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    const address = `https://shop.example/session?${new URLSearchParams({ password: secret }).toString()}`
    expect(automation_.masked(address)).toBe('https://shop.example/session?password=••••••••')
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: address } })
    await expect(automation_.evaluate('location.search')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('address') })
    // An address escaped another way, with lower-case hex, is found once it is decoded.
    const other = page(), others = automation(other)
    await others.typeSecret(given(secret), go, { selector: '#password' })
    other.emit('Page.frameNavigated', { frame: { id: 'main', url: `https://shop.example/session?p=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/gu, hex => hex.toLowerCase())}` } })
    await expect(others.evaluate('location.search')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('address') })
  })

  it('takes a document the back-forward cache gives back, after another one, as one the agent scripted and a secret was typed in', async () => {
    // A: the agent runs a script. B: another document commits, which clears it. Back to A, from the cache.
    const fake = at('https://github.com'), automation_ = automation(fake), take = counted()
    fake.handle = ((base: Handler) => (method: string, params: Record<string, unknown>) => method === 'Runtime.evaluate' && params.userGesture ? { result: { type: 'string', value: 'ok' } } : base(method, params))(fake.handle)
    await automation_.evaluate('addEventListener("keydown", () => undefined)')
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://github.com/elsewhere' } })
    fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://github.com/login' }, type: 'BackForwardCacheRestore' })
    await expect(automation_.typeSecret(take.fn, go, { selector: '#password' }, false, 'https://github.com')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('ran a script') })
    expect(take.calls).toBe(0)
    // A: a secret is typed. B commits. Back to A, whose field still holds it.
    const holding = page(), holder = automation(holding)
    await holder.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    holding.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/next' } })
    expect(holder.holdsSecret()).toBe(false)
    holding.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/checkout' }, type: 'BackForwardCacheRestore' })
    expect(holder.holdsSecret()).toBe(true)
  })

  it('says the reference is used when anything stops the typing after the value was taken', async () => {
    const fake = at('https://github.com')
    let taken = false
    // The page changes while the value is on its way from the engine, as a navigation that starts then would.
    const guard = (): void => { if (taken) throw new ToolFailure('blocked', 'The page changed. Inspect it before trying again.') }
    await expect(automation(fake).typeSecret(async () => { taken = true; return 'hunter2-secret' }, guard, { selector: '#password' }, false, 'https://github.com'))
      .rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('this secretRef is used') })
    expect(fake.calls('Input.insertText')).toEqual([])
  })

  it('leaves a page not recording when its recording fails to start, so a secret can still be typed there', async () => {
    const fake = page(), base = fake.handle, automation_ = automation(fake)
    fake.handle = (method, params) => { if (method === 'Page.startScreencast') throw new ToolFailure('unavailable', 'The page did not answer in time.'); return base(method, params) }
    await expect(automation_.startScreencast(() => undefined)).rejects.toMatchObject({ code: 'unavailable' })
    await automation_.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    expect(fake.calls('Input.insertText')).toEqual([{ text: 'hunter2-secret' }])
  })

  it('types nothing while the page records, and starts no recording on a page that holds a secret', async () => {
    const recording = page(), recorder = automation(recording), take = counted()
    await recorder.startScreencast(() => undefined)
    await expect(recorder.typeSecret(take.fn, go, { selector: '#password' })).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('recording') })
    expect(take.calls).toBe(0)
    const holding = page(), holder = automation(holding)
    await holder.typeSecret(given('hunter2-secret'), go, { selector: '#password' })
    await expect(holder.startScreencast(() => undefined)).rejects.toMatchObject({ code: 'blocked' })
    expect(holding.calls('Page.startScreencast')).toEqual([])
  })

  it('keeps evaluate off for the page\'s life once its address, or a frame\'s, has held a typed secret', async () => {
    const secret = 'pa ss&word"1'
    for (const reaching of [
      (fake: FakePage) => fake.emit('Page.frameNavigated', { frame: { id: 'main', url: `https://shop.example/session?password=${encodeURIComponent(secret).replace(/%20/gu, '+')}` } }),
      (fake: FakePage) => fake.emit('Page.navigatedWithinDocument', { frameId: 'main', url: `https://shop.example/#${encodeURIComponent(secret)}` }),
      (fake: FakePage) => fake.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: `https://shop.example/frame?p=${encodeURIComponent(secret)}` } }),
    ]) {
      const fake = page(), automation_ = automation(fake)
      await automation_.typeSecret(given(secret), go, { selector: '#password' })
      reaching(fake)
      fake.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/thanks' } })
      expect(automation_.holdsSecret()).toBe(false)
      await expect(automation_.evaluate('btoa(navigation.entries().map(entry => entry.url).join())')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('address') })
    }
    // An address that never held it keeps evaluate off too: a site can write the value back into the next document, as
    // one that fills a failed sign-in form in again does, and a script could send it on in any encoding.
    const plain = page(), plainly = automation(plain)
    await plainly.typeSecret(given(secret), go, { selector: '#password' })
    plain.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/thanks' } })
    plain.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://shop.example/account' } })
    await expect(plainly.evaluate('btoa(document.querySelector("input[type=password]").value)')).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('new page') })
    // A new page has evaluate.
    const fresh = page(), freshly = automation(fresh)
    fresh.handle = (method) => method === 'Runtime.evaluate' ? { result: { type: 'number', value: 2 } } : {}
    expect(await freshly.evaluate('1 + 1')).toBe('2')
  })

  it('compares wait_for\'s words and address with a typed secret masked, so it cannot test the secret a character at a time', async () => {
    const secret = 'Cobalt-7731'
    let href = '', body = ''
    const fake = page(), base = fake.handle, automation_ = automation(fake)
    fake.handle = (method, params) => {
      const expression = typeof params.expression === 'string' ? params.expression : ''
      if (method === 'Runtime.evaluate' && expression === 'location.href') return { result: { value: href } }
      if (method === 'Runtime.evaluate' && expression.includes('document.body')) {
        // The page answers what it is asked: the words themselves, or whether they include the ones given.
        const asked = /\.includes\(("(?:[^"\\]|\\.)*")\)$/u.exec(expression)
        return { result: { value: asked ? body.includes(JSON.parse(asked[1]!) as string) : body } }
      }
      return base(method, params)
    }
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    href = `https://shop.example/session?password=${encodeURIComponent(secret)}`
    body = `Signed in. Your password ${secret} was accepted.`
    // The right first character and a wrong one look the same.
    for (const probe of ['password=C', 'password=X']) await expect(automation_.waitFor({ type: 'wait_for', urlIncludes: probe, timeoutMs: 100 }, go)).rejects.toMatchObject({ code: 'blocked' })
    for (const probe of ['password Co', 'password Xo']) await expect(automation_.waitFor({ type: 'wait_for', text: probe, timeoutMs: 100 }, go)).rejects.toMatchObject({ code: 'blocked' })
    // Waiting for words that are not the secret still works.
    expect(await automation_.waitFor({ type: 'wait_for', urlIncludes: 'shop.example/session?password=', timeoutMs: 100 }, go)).toContain('Seen')
    expect(await automation_.waitFor({ type: 'wait_for', text: 'Signed in.', timeoutMs: 100 }, go)).toContain('Seen')
  })

  it('refuses a selector that tests part of an attribute\'s value on a page a secret was typed into', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('Cobalt-7731'), go, { selector: '#password' })
    for (const selector of ['input[value^="C"]', 'a[href*="password=C"]', 'input[value$=1 i]', '[data-x~="C"]', '[lang|=C]', 'a[href*/**/="C"]', ':is(input[value^="C"])']) {
      await expect(automation_.waitFor({ type: 'wait_for', selector, timeoutMs: 100 }, go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('part of') })
      await expect(automation_.input({ type: 'click', selector }, go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('part of') })
    }
    // A whole value tests only a value guessed whole, and an id or a class nothing: they still reach the page.
    for (const selector of ['input[name="password"]', '#password']) {
      await expect(automation_.input({ type: 'click', selector }, go)).rejects.not.toMatchObject({ message: expect.stringContaining('part of') })
    }
    // A page no secret was typed into takes any selector.
    const plain = page(), plainly = automation(plain)
    await expect(plainly.input({ type: 'click', selector: 'input[value^="C"]' }, go)).rejects.not.toMatchObject({ message: expect.stringContaining('part of') })
  })
})
