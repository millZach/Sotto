// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attributeOf, CURSOR_ARROW, DOUBLE_TAP_GAP_MS, PageAutomation, SNAPSHOT_TOTAL, type PageDebugger, type PageEventListener, type PageFrame, type PageInput, type PagePicture } from '../../../src/main/tools/pageAutomation'
import { ToolFailure } from '../../../src/main/tools/common'
import { maskSecrets, secretMatcher } from '../../../src/main/tools/secretMask'
import { SECRET_VALUE_MAX } from '../../../src/shared/secretRequests'
import { SNAPSHOT_TEXT, type AXNode } from '../../../src/main/tools/pageSnapshot'
import { browserCaptureResultSchema, browserDialogSchema, browserPointStateSchema, safeBrowserUrl } from '../../../src/shared/browser'

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
    // A document that holds no words and no field with anything in it.
    if (method === 'Runtime.evaluate' && String(params.expression).includes('documentElement.textContent')) return { result: { value: '' } }
    if (method === 'Runtime.evaluate' && String(params.expression).includes('.call(document.activeElement')) return { result: { value: { text: '', singleLine: true } } }
    if (method === 'DOM.resolveNode') return { object: { objectId: `node-${String(params.backendNodeId)}` } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('isContentEditable')) return { result: { value: { text: '', singleLine: true } } }
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
      if (method === 'Runtime.evaluate' && String(params.expression).includes('.call(document.activeElement')) return { result: { value: { text: values.get(focus.node) ?? '', singleLine: true } } }
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${String(params.backendNodeId)}` } }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('isContentEditable')) return { result: { value: { text: values.get(Number(String(params.objectId).slice('node-'.length))) ?? '', singleLine: true } } }
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
    // What the page says back goes through the same mask, each part before it is cut and the whole after: with every
    // check failing, the snapshot is all mask, not the page's raw words.
    const real = vi.mocked(maskSecrets).getMockImplementation()!
    vi.mocked(maskSecrets).mockImplementation(() => { throw new RangeError(secret) })
    const snapshot = await automation_.snapshotText().finally(() => vi.mocked(maskSecrets).mockImplementation(real))
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
    // An attribute that names an element still reaches the page.
    for (const selector of ['input[name="password"]', '#password']) {
      await expect(automation_.input({ type: 'click', selector }, go)).rejects.not.toMatchObject({ message: expect.stringContaining('part of') })
    }
    // A page no secret was typed into takes any selector.
    const plain = page(), plainly = automation(plain)
    await expect(plainly.input({ type: 'click', selector: 'input[value^="C"]' }, go)).rejects.not.toMatchObject({ message: expect.stringContaining('part of') })
  })

  it('refuses a selector that compares a whole value a page could have copied the secret into (after the third review)', async () => {
    const fake = page(), automation_ = automation(fake)
    await automation_.typeSecret(given('4821'), go, { selector: '#password' })
    // A site that keeps a field's value in its attribute, as React does, would answer each of ten thousand guesses at a PIN.
    const guesses = ['input[value="4821"]', "[data-value='4821']", 'a[href="/next?pin=4821"]', '[VALUE=4821]', '[*|value="4821"]', '[v\\61lue="4821"]',
      '[value/**/="4821"]', ':not([value=""])', 'input[name="pin"][value="4821"]', '[data-x\\[name="4821"]', '[data-x="[name="]', ':has(> [aria-valuetext="4821"])']
    for (const selector of guesses) {
      await expect(automation_.waitFor({ type: 'wait_for', selector, timeoutMs: 100 }, go), selector).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('names an element') })
      await expect(automation_.input({ type: 'click', selector }, go), selector).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('names an element') })
    }
    // An attribute that names an element, or one tested only for being there, still reaches the page.
    for (const selector of ['input[name="pin"]', '[type=password]', '[ID = "pin" i]', '#pin', '[role="button"]', '[data-testid="pin"]', 'label[for="pin"]', 'input[value]', '[placeholder="PIN"]']) {
      await expect(automation_.input({ type: 'click', selector }, go), selector).rejects.not.toMatchObject({ message: expect.stringContaining('names an element') })
    }
    const plain = page(), plainly = automation(plain)
    await expect(plainly.input({ type: 'click', selector: 'input[value="4821"]' }, go)).rejects.not.toMatchObject({ message: expect.stringContaining('names an element') })
  })
})

describe('page words are masked before they are cut or tidied (after the third review)', () => {
  const secret = 'hunter2-secret'
  /**
   * A page whose body's visible text is `body` and whose tree is `tree`, each read cut where its expression asks, as
   * `innerText.slice` cuts it in the page; `more` answers anything else first.
   */
  const showing = (body: string, tree: AXNode[] = [], more: Handler = () => undefined): FakePage => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => {
      const answer = more(method, params)
      if (answer !== undefined) return answer
      if (method === 'Accessibility.getFullAXTree') return { nodes: tree }
      const expression = String(params.expression ?? ''), cut = /innerText\.slice\(0, ?(\d+)\)/u.exec(expression)
      const visible = cut ? body.slice(0, Number(cut[1])) : body
      if (method === 'Runtime.evaluate' && expression.startsWith('({ title')) return { result: { value: { title: 'Checkout', text: visible, state: 'complete' } } }
      if (method === 'Runtime.evaluate' && expression.startsWith('document.body ?')) return { result: { value: visible } }
      return base(method, params)
    }
    return fake
  }
  const typedOn = async (fake: FakePage, value = secret): Promise<TestAutomation> => {
    const automation_ = automation(fake)
    await automation_.typeSecret(given(value), go, { selector: '#password' })
    return automation_
  }

  it('reads the visible text past its cut, so a secret the cut would split is masked whole', async () => {
    const snapshot = await (await typedOn(showing(`${'a'.repeat(SNAPSHOT_TEXT - 5)}${secret} and more`))).snapshotText()
    expect(snapshot).not.toContain('hunte')
    // The mask the cut ran on to is cut at the cap once masked (the fourth review, P-L1).
    expect(snapshot).toContain(`${'a'.repeat(10)}•••••\n`)
  })

  it('cuts the visible text where the page\'s own words reach the cap, however much shorter the masks before it are', async () => {
    // Each of 400 copies is 40 characters shorter once masked, so a cut counted in the masked text would reach 16,000
    // characters past the cap, into the copy the page's own read cut in two.
    const long = 'L0ng-secret-'.repeat(4), overread = long.length * 15, many = `${long} `.repeat(400)
    const body = `${many}${'b'.repeat(SNAPSHOT_TEXT + overread - many.length - 20)}${long}`
    const snapshot = await (await typedOn(showing(body), long)).snapshotText()
    expect(snapshot).not.toContain('L0ng-sec')
    expect(snapshot).toContain(`${'b'.repeat(10)}\n`)
  })

  it('masks a name in the tree before its spaces are closed up and it is cut', async () => {
    const spaced = 'correct  horse-staple'
    const tree = (name: string): AXNode[] => [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: name }, backendDOMNodeId: 21 },
    ]
    const closed = await (await typedOn(showing('', tree(`Wrong password: ${spaced}`)), spaced)).snapshotText()
    expect(closed).not.toContain('correct horse')
    expect(closed).toContain('Wrong password: ••••••••')
    const cut = await (await typedOn(showing('', tree(`${'h'.repeat(195)}${secret}`)))).snapshotText()
    expect(cut).not.toContain('hunte')
  })

  it('looks for words only in the visible text a snapshot carries, read past its cut, so a wait cannot test a secret the cut splits', async () => {
    const automation_ = await typedOn(showing(`${'w'.repeat(SNAPSHOT_TEXT - 5)}${secret} ${'w'.repeat(40_000)} far-below`))
    // The start of the secret, which a read cut at the cap would end on.
    await expect(automation_.waitFor({ type: 'wait_for', text: 'hunte', timeoutMs: 1 }, go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('Not seen') })
    // Words past what a snapshot carries are not read every 100 ms.
    await expect(automation_.waitFor({ type: 'wait_for', text: 'far-below', timeoutMs: 1 }, go)).rejects.toMatchObject({ code: 'blocked' })
    await expect(automation_.waitFor({ type: 'wait_for', text: 'wwww', timeoutMs: 1 }, go)).resolves.toContain('Seen')
  })

  it('keeps inspect\'s answer within its size once masked, as each mask can be longer than the secret it stands for', async () => {
    // A short secret, said apart many times in what the page names an element's role, or in its address: each three
    // characters become nine, so the masked answer outgrows the raw one.
    const many = (copies: number): string => 'abc '.repeat(copies)
    const fake = showing('', [], (method, params) => {
      const expression = String(params.expression ?? '')
      if (method !== 'Runtime.evaluate' || !expression.startsWith('Array.from(document.querySelectorAll')) return undefined
      // Each role is cut where the read asks, as the page's own slice would cut it.
      const cut = /role:\(el\.getAttribute\('role'\)\|\|''\)\.slice\(0,(\d+)\)/u.exec(expression)
      const role = (index: number): string => `${many(475)}${index}`.slice(0, cut ? Number(cut[1]) : undefined)
      return { result: { value: Array.from({ length: 100 }, (_, index) => ({ tag: 'div', role: role(index), name: '', x: 0, y: 0, width: 1, height: 1, disabled: false })) } }
    })
    const automation_ = await typedOn(fake, 'abc')
    const roles = await automation_.inspect()
    expect(roles.length).toBeLessThanOrEqual(200_000)
    expect(roles).not.toContain('abc')
    expect((JSON.parse(roles) as { elements: { role: string }[] }).elements[0]?.role).toMatch(/^(•{8} ){10}/u)
    fake.url = () => `https://shop.example/search?q=${'abc+'.repeat(40_000)}`
    const address = await automation_.inspect()
    expect(address.length).toBeLessThanOrEqual(200_000)
    expect(address).not.toContain('abc')
    expect(JSON.parse(address)).toMatchObject({ url: expect.stringMatching(/^https:\/\/shop\.example\/search\?q=(•{8}\+){10}/u), truncated: true })
  })

  it('reads a console message, an error and a dialog past their cuts, and masks a dialog before its tabs are spaces', async () => {
    const fake = showing('')
    const automation_ = await typedOn(fake)
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `${'c'.repeat(495)}${secret}` }] })
    fake.emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: `${'e'.repeat(1995)}${secret}` } } })
    // A snapshot says both; inspect says the errors.
    const snapshot = await automation_.snapshotText(), inspected = await automation_.inspect()
    // Each mask the cut ran on to is cut at the cap once masked (the fourth review, P-L1).
    for (const said of [snapshot, inspected]) {
      expect(said).not.toContain('hunte')
      expect(said).toContain(`${'e'.repeat(5)}•••••`)
    }
    expect(snapshot).toContain(`${'c'.repeat(5)}•••••`)
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: `${'d'.repeat(1995)}${secret}` })
    expect(automation_.dialog()?.message).toMatch(/^d{1995}•{5}$/u)

    const tabbed = 'tab\there-secret', other = showing('')
    const elsewhere = await typedOn(other, tabbed)
    other.emit('Page.javascriptDialogOpening', { type: 'prompt', message: `Wrong password: ${tabbed}`, defaultPrompt: tabbed })
    expect(elsewhere.dialog()).toEqual({ type: 'prompt', message: 'Wrong password: ••••••••', defaultPrompt: '••••••••' })
  })

  it('masks what inspect reads of each name before the name is cut', async () => {
    const tree: AXNode[] = [{ nodeId: '1', role: { value: 'heading' }, name: { value: `${'n'.repeat(295)}${secret}` }, backendDOMNodeId: 21 }]
    const fake = showing('', tree, (method, params) => {
      const expression = String(params.expression ?? ''), cut = /\.slice\(0,(\d+)\), x:/u.exec(expression)
      if (method === 'Runtime.evaluate' && expression.startsWith('Array.from(document.querySelectorAll') && cut) return { result: { value: [{ tag: 'a', role: '', name: `${'m'.repeat(195)}${secret}`.slice(0, Number(cut[1])), x: 0, y: 0, width: 1, height: 1, disabled: false }] } }
      return undefined
    })
    const said = await (await typedOn(fake)).inspect()
    expect(said).not.toContain('hunte')
    // Each mask the cut ran on to is cut at the cap once masked (the fourth review, P-L1).
    expect(said).toContain(`${'n'.repeat(5)}•••••"`)
    expect(said).toContain(`${'m'.repeat(5)}•••••"`)
  })

  it('masks the element the user picks or comments on, which goes into their message to the agent', async () => {
    const spaced = 'correct  horse-staple'
    // Markup longer than is read (200,000 characters and the overread), with a secret that cut leaves five characters of.
    const at = 200_000 + spaced.length * 15 - 5, tags = '<i></i>'.repeat(Math.floor((at - 3) / 7))
    const long = `<p>${tags}${'a'.repeat(at - 3 - tags.length)}${spaced}</p>`
    const fake = showing('', [], (method, params) => {
      if (method === 'DOM.describeNode' && (params.backendNodeId === 30 || params.backendNodeId === 31)) return { node: { nodeType: 1, localName: 'p', attributes: ['id', spaced, 'aria-label', `Your password: ${spaced}`] } }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ role: { value: 'paragraph' }, name: { value: `Your password: ${spaced}` } }] }
      if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.getOuterHTML') return { outerHTML: params.backendNodeId === 31 ? long : `<p>${'x'.repeat(980)}<b>${spaced.replace(' ', '&nbsp;')}</b></p>` }
      const expression = String(params.expression ?? '')
      if (method === 'Runtime.evaluate' && expression.includes('document.elementFromPoint')) {
        const cuts = [...expression.matchAll(/\.slice\(0,(\d+)\)/gu)].map(match => Number(match[1]))
        const element = { tag: 'p', role: spaced, name: `${'y'.repeat(495)}${spaced}`.slice(0, cuts[0]), text: `${'z'.repeat(995)}${spaced}`.slice(0, cuts[1]) }
        return { result: { value: { element: expression.includes('id: el.id') ? { ...element, id: spaced } : { ...element, selector: `#${spaced}` }, bounds: { x: 0, y: 0, width: 10, height: 10 } } } }
      }
      return undefined
    })
    const automation_ = await typedOn(fake, spaced)
    const picked = await automation_.pointed({ backendNodeId: 30 }), commented = await automation_.elementAt({ x: 5, y: 5 })
    for (const said of [JSON.stringify(picked), JSON.stringify(commented)]) {
      expect(said).not.toContain('correct')
      expect(said).toContain('••••••••')
    }
    expect(picked?.element).toMatchObject({ name: 'Your password: ••••••••', selector: '#••••••••', text: expect.stringMatching(/x{5} ••••••••$/u) })
    // Each mask the cut ran on to is cut at the cap once masked (the fourth review, P-L1).
    expect(commented?.element).toMatchObject({ role: '••••••••', selector: '#••••••••', name: expect.stringMatching(/^y{495}•{5}$/u), text: expect.stringMatching(/^z{995}•{5}$/u) })
    expect((await automation_.pointed({ backendNodeId: 31 }))?.element.text).not.toContain('corr')
  })

  it('masks a picked element\'s markup before its tags go, and says none of its words when tags split the secret', async () => {
    const markup: Record<number, [secret: string, html: string]> = {
      // A PIN drawn a digit to a box, as a code is shown back.
      40: ['4821', '<p>Your PIN <span class="box">4</span>\n  <span class="box">8</span><span class="box">2</span><span class="box">1</span></p>'],
      41: ['hunt-er2x', '<p>hunt<b>-er</b>2x is saved</p>'],
      // A value with a > in an attribute, which a tag's end was looked for at.
      42: ['ab>cd-efgh', '<p title="ab>cd-efgh">Hi</p>'],
      43: ['a&b>cd-efgh', '<p title="a&amp;b>cd-efgh">Hi</p><!-- note > a&amp;b>cd-efgh -->'],
    }
    for (const [node, [value, html]] of Object.entries(markup)) {
      const fake = showing('', [], (method, params) => {
        if (method === 'DOM.describeNode' && params.backendNodeId === Number(node)) return { node: { nodeType: 1, localName: 'p', attributes: [] } }
        if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ role: { value: 'paragraph' }, name: { value: '' } }] }
        if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }
        if (method === 'DOM.getOuterHTML') return { outerHTML: html }
        return undefined
      })
      const picked = await (await typedOn(fake, value)).pointed({ backendNodeId: Number(node) })
      const text = picked?.element.text ?? ''
      for (const piece of value.split(/[<>&-]/u).filter(part => part.length >= 2)) expect(text, `${node}: ${text}`).not.toContain(piece)
      if (node === '40') expect(text).not.toMatch(/4\s*8\s*2\s*1/u)
      if (node === '42' || node === '43') expect(text).toBe('Hi')
    }
  })

  it('masks the address a picture is taken at, which the user\'s feedback names to the agent', async () => {
    const automation_ = await typedOn(showing('Thanks'))
    // A form sent by GET carries the value in the next document's address, which a picture the user takes there names.
    automation_.documentCommitted()
    const capture = await automation_.capture(`https://shop.example/done?pin=${secret}`)
    expect(capture.url).toBe('https://shop.example/done?pin=••••••••')
  })
})

describe('a secret a site writes back into a later document (after the third review)', () => {
  const secret = 'hunter2-secret'
  /** A page whose document holds `shown()` in its words and fields, as Sotto reads them whole, or fails to read when it throws. */
  const writing = (shown: () => string): FakePage => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => method === 'Runtime.evaluate' && String(params.expression ?? '').includes('documentElement.textContent') ? { result: { value: shown() } } : base(method, params)
    return fake
  }
  const chord = { type: 'key', key: 'a', modifiers: ['Control'] } as const satisfies PageInput
  const selecting = [chord, { type: 'key', key: 'c', modifiers: ['Meta'] }, { type: 'click', x: 5, y: 5, clickCount: 2 }, { type: 'drag', from: { x: 5, y: 5 }, to: { x: 50, y: 5 } }] as const satisfies readonly PageInput[]

  it('selects, copies and records none of a later document that shows the secret again, and pictures none of it', async () => {
    let shown = `Saved. Your key is ${secret}.`
    const fake = writing(() => shown), automation_ = automation(fake)
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    // The site's next document says the key back, as a settings page can.
    automation_.documentCommitted()
    for (const action of selecting) {
      await expect(automation_.target(action), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('while it does') })
      await expect(automation_.input(action, go), JSON.stringify(action)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('while it does') })
    }
    expect(fake.calls('Input.dispatchKeyEvent')).toEqual([])
    expect(fake.calls('Input.dispatchMouseEvent')).toEqual([])
    expect(await automation_.showsSecret()).toBe(true)
    // A recording runs on into later documents, so none starts on a page a secret was typed into.
    shown = 'Saved.'
    await expect(automation_.startScreencast(() => undefined)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('later documents') })
    expect(fake.calls('Page.startScreencast')).toEqual([])
    // A later document that shows none of it takes them again.
    expect(await automation_.showsSecret()).toBe(false)
    await automation_.input(chord, go)
    expect(fake.calls('Input.dispatchKeyEvent')).toHaveLength(2)
  })

  it('finds the secret in a field, and counts a document it cannot read as one that shows it', async () => {
    let answer: unknown = 'hunter2-secret'
    const fake = page(), base = fake.handle, automation_ = automation(fake)
    fake.handle = (method, params) => {
      if (method !== 'Runtime.evaluate' || !String(params.expression ?? '').includes('documentElement.textContent')) return base(method, params)
      if (answer instanceof Error) throw answer
      return { result: { value: answer } }
    }
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    automation_.documentCommitted()
    expect(automation_.typedSecret()).toBe(true)
    expect(await automation_.showsSecret()).toBe(true)
    for (answer of [undefined, { text: secret }, new Error(`Uncaught: ${secret}`)]) {
      expect(await automation_.showsSecret(), String(answer)).toBe(true)
      await expect(automation_.input(chord, go)).rejects.toMatchObject({ code: 'blocked', message: expect.not.stringContaining('hunter') })
    }
    // A dialog holds any read until it is answered, so none is tried while one is open.
    const reads = (): number => fake.calls('Runtime.evaluate').filter(call => String(call.expression).includes('documentElement.textContent')).length
    const before = reads()
    answer = ''
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' })
    expect(await automation_.showsSecret()).toBe(true)
    expect(reads()).toBe(before)
    fake.emit('Page.javascriptDialogClosed', {})
    expect(await automation_.showsSecret()).toBe(false)
    // The read names every field's value and follows open shadow roots and same-origin frames.
    const expression = String(fake.calls('Runtime.evaluate').filter(call => String(call.expression).includes('documentElement.textContent')).at(-1)?.expression)
    for (const part of ['.value', 'shadowRoot', 'contentDocument']) expect(expression).toContain(part)
  })

  it('holds a tap straight after another back on a later document that shows the secret, and reads nothing on a page none was typed into', async () => {
    const at: number[] = [], fake = writing(() => `Key: ${secret}`), base = fake.handle, automation_ = automation(fake, { parity: false })
    fake.handle = (method, params) => { if (method === 'Input.dispatchTouchEvent') at.push(Date.now()); return base(method, params) }
    await automation_.typeSecret(given(secret), go, { selector: '#password' })
    automation_.documentCommitted()
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    await automation_.input({ type: 'tap', x: 5, y: 5 }, go)
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(DOUBLE_TAP_GAP_MS - 2)
    const plain = writing(() => `Key: ${secret}`), plainly = automation(plain)
    await plainly.input(chord, go)
    await plainly.input({ type: 'tap', x: 5, y: 5 }, go)
    expect(await plainly.showsSecret()).toBe(false)
    expect(plain.calls('Runtime.evaluate').filter(call => String(call.expression).includes('documentElement.textContent'))).toEqual([])
  })
})

describe('the copies of a typed secret a page or Chromium makes (after the third review)', () => {
  /** A page whose password field keeps at most `keeps` of what is typed into it, and answers Sotto's read of it. */
  const keeping = (keeps: (typed: string) => string): FakePage => {
    const fake = page(), base = fake.handle
    let held = ''
    fake.handle = (method, params) => {
      if (method === 'Input.insertText') held = keeps(held + String(params.text))
      if (method === 'DOM.resolveNode') return { object: { objectId: `node-${String(params.backendNodeId)}` } }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('isContentEditable')) return { result: { value: { text: held, singleLine: true } } }
      return base(method, params)
    }
    return fake
  }

  it('masks the secret with its spaces closed up, as a page shows its text', async () => {
    const automation_ = automation(keeping(typed => typed))
    await automation_.typeSecret(given('correct  horse\tstaple'), go, { selector: '#password' })
    for (const shown of ['Saved: correct horse staple.', 'Saved: correct horse staple .']) expect(automation_.masked(shown)).not.toContain('horse')
  })

  it('masks a download\'s name as Chromium gives it, each character a file name cannot hold made safe', async () => {
    const automation_ = automation(keeping(typed => typed))
    await automation_.typeSecret(given('pin:4821*ok?'), go, { selector: '#password' })
    // Chromium makes the page's name safe before Sotto is told it, so the name as the page wrote it is never seen.
    for (const name of ['pin_4821_ok_.txt', 'pin-4821-ok-.txt']) expect(automation_.masked(name), name).toBe('••••••••.txt')
  })

  it('masks what a field kept of the secret, cut at its length or with no line break, which a form sent by GET carries', async () => {
    for (const [value, keeps, kept] of [
      ['Cobalt-7731-staple', (typed: string) => typed.slice(0, 8), 'Cobalt-7'],
      ['line-one\nline-two', (typed: string) => typed.replace(/[\r\n]/gu, ''), 'line-oneline-two'],
    ] as const) {
      const automation_ = automation(keeping(keeps))
      await automation_.typeSecret(given(value), go, { selector: '#password' })
      expect(automation_.masked(`https://shop.example/login?pw=${kept}&next=1`), value).toBe('https://shop.example/login?pw=••••••••&next=1')
    }
    // A field Sotto cannot read leaves the secret masked as it was typed, and the typing done.
    const unread = page(), base = unread.handle, automation_ = automation(unread)
    unread.handle = (method, params) => method === 'Runtime.callFunctionOn' ? Promise.reject(new Error('Cannot find context')) : base(method, params)
    await automation_.typeSecret(given('Cobalt-7731-staple'), go, { selector: '#password' })
    expect(unread.calls('Input.insertText')).toEqual([{ text: 'Cobalt-7731-staple' }])
    expect(automation_.masked('pw=Cobalt-7731-staple')).toBe('pw=••••••••')
  })
})

describe('the masker cuts a text without splitting a secret (after the third review)', () => {
  const hunter = secretMatcher('hunter2-secret')
  it('counts the cut in the text, and runs it on to the end of a mask it would fall inside', () => {
    const text = 'say hunter2-secret now'
    expect(maskSecrets(text, [hunter], '', 6)).toBe('say ••••••••')
    expect(maskSecrets(text, [hunter], '', 4)).toBe('say ')
    expect(maskSecrets(text, [hunter], '', 19)).toBe('say •••••••• ')
    expect(maskSecrets(text, [hunter], '', 0)).toBe('')
    expect(maskSecrets(text, [hunter], '', 1_000)).toBe('say •••••••• now')
    // A cut in a text that holds no secret is a plain cut.
    expect(maskSecrets('nothing here', [hunter], '', 7)).toBe('nothing')
    // Escaped, a secret is longer than itself; the cut still takes the whole escape.
    expect(maskSecrets(`a ${encodeURIComponent(encodeURIComponent('hunter2-secret'))} b`, [hunter], '', 3)).toBe('a ••••••••')
  })
})

describe('a secret\'s typing that fails says none of the error it met (after the third review)', () => {
  const secret = 'hunter2-secret'
  /** A page whose debugger fails the typing with `error`. */
  const failing = (error: unknown): FakePage => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => {
      if (method === 'Input.insertText') throw error
      return base(method, params)
    }
    return fake
  }
  const refusal = async (error: unknown): Promise<ToolFailure> => {
    const thrown = await automation(failing(error)).typeSecret(given(secret), go, { selector: '#password' }).then(() => null, (caught: unknown) => caught)
    expect(thrown).toBeInstanceOf(ToolFailure)
    return thrown as ToolFailure
  }

  it('says its own words for an error from the debugger, which could quote the command and so the secret', async () => {
    const said = await refusal(new Error(`Input.insertText failed: {"text":"${secret}"}`))
    expect(said.message).toBe('The typing stopped. The secret may not have been typed, and this secretRef is used. Ask for it again with request_secret.')
    expect(said.code).toBe('unavailable')
  })

  it('masks a refusal of Sotto\'s own kind that quotes the secret, as one a paired host sends back could', async () => {
    const said = await refusal(new ToolFailure('unavailable', `The host could not send {"text":"${secret}"}`))
    expect(said.message).not.toContain(secret)
    expect(said.message).toContain('{"text":"••••••••"}')
  })
})

describe('what is masked fits where it goes, and is tidied before it is cut (after the fourth review)', () => {
  /**
   * A page whose tree is `tree`, and whose element at node 30, the one the pointer is over, is named `name` and has
   * `html` for its markup. Anything else is answered as `page()` answers it.
   */
  const naming = (tree: AXNode[] = [], name = '', html = '<p></p>'): FakePage => {
    const fake = page(), base = fake.handle
    fake.handle = (method, params) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: tree }
      if (method === 'Runtime.evaluate' && String(params.expression ?? '').startsWith('({ title')) return { result: { value: { title: '', text: '', state: 'complete' } } }
      if (method === 'DOM.describeNode' && (params.nodeId === 30 || params.backendNodeId === 30)) return { node: { nodeType: 1, localName: 'p', attributes: [] } }
      if (method === 'Accessibility.getPartialAXTree') return { nodes: [{ role: { value: 'paragraph' }, name: { value: name } }] }
      if (method === 'DOM.getBoxModel') return { model: { border: [0, 0, 10, 0, 10, 10, 0, 10] } }
      if (method === 'DOM.getOuterHTML') return { outerHTML: html }
      return base(method, params)
    }
    return fake
  }
  const typedOn = async (fake: FakePage, value: string): Promise<TestAutomation> => {
    const automation_ = automation(fake)
    await automation_.typeSecret(given(value), go, { selector: '#password' })
    return automation_
  }
  /** What point mode tells the window of the element at node 30, once the pointer is over it. */
  const hovered = async (automation_: TestAutomation, fake: FakePage): Promise<{ tag: string; name: string }> => {
    const hover = vi.fn()
    await automation_.point({ r: 1, g: 2, b: 3 }, { hover, pick: vi.fn() })
    fake.emit('Overlay.nodeHighlightRequested', { nodeId: 30 })
    await vi.waitFor(() => expect(hover).toHaveBeenCalled())
    await automation_.unpoint()
    return hover.mock.calls[0]![0] as { tag: string; name: string }
  }

  it('keeps a picture\'s address, a hovered element\'s name and a dialog\'s words within what the window takes, once masked (P-L1)', async () => {
    // A PIN of four characters, whose mask is twice as long.
    const pin = '4821', fake = naming([], `${'n'.repeat(496)}${pin}`), automation_ = await typedOn(fake, pin)
    automation_.documentCommitted()
    const origin = 'https://shop.example/'
    // An address as long as one may be, which its mask makes longer; and one whose many masks the window escapes, at
    // 72 characters each.
    for (const url of [`${origin}${'a'.repeat(8192 - origin.length - pin.length)}${pin}`, `${origin}?${`${pin}/`.repeat(1500)}`]) {
      const parsed = browserCaptureResultSchema.safeParse(await automation_.capture(url))
      expect(parsed.success, url.slice(0, 60)).toBe(true)
      expect(parsed.data!.url).not.toContain(pin)
      expect(parsed.data!.url.startsWith(origin)).toBe(true)
      // The window can send it back as it was given it.
      expect(safeBrowserUrl(parsed.data!.url)).toBe(parsed.data!.url)
    }
    const hover = await hovered(automation_, fake)
    expect(browserPointStateSchema.safeParse({ state: 'hover', ...hover }).success).toBe(true)
    expect(hover.name).not.toContain(pin)
    fake.emit('Page.javascriptDialogOpening', { type: 'prompt', message: `${'d'.repeat(1996)}${pin}`, defaultPrompt: `${pin} `.repeat(500) })
    const dialog = automation_.dialog()
    expect(browserDialogSchema.safeParse(dialog).success).toBe(true)
    expect(JSON.stringify(dialog)).not.toContain(pin)
  })

  it('says only the origin and a mask of an address whose mask would change its origin (P-L1)', async () => {
    // A secret that runs from the host into the path: masked, the host would be another.
    const automation_ = await typedOn(naming(), 'ple/checkout')
    const said = automation_.maskedUrl('https://shop.example/checkout?step=2')
    expect(new URL(said).origin).toBe('https://shop.example')
    expect(said).not.toContain('checkout')
    expect(browserCaptureResultSchema.shape.url.safeParse(said).success).toBe(true)
  })

  it('tidies a snapshot\'s names, a dialog\'s words and a hovered or picked element\'s name before cutting them, so a secret tidying joins is masked whole (P-L3)', async () => {
    // The secret with a line break or a tab where its space is, right where each is cut.
    const tree: AXNode[] = [
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: `${'a'.repeat(190)}correct\n  horse` }, backendDOMNodeId: 21 },
      { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: 'Note' }, value: { value: `${'v'.repeat(192)}correct\thorse` }, backendDOMNodeId: 22 },
    ]
    const fake = naming(tree, `${'h'.repeat(493)}correct\thorse`), automation_ = await typedOn(fake, 'correct horse')
    automation_.documentCommitted()
    const snapshot = await automation_.snapshotText()
    expect(snapshot).not.toMatch(/correct|horse/u)
    expect(snapshot).toContain(`${'a'.repeat(5)}••••••••`)
    expect(snapshot).toContain(`${'v'.repeat(5)}••••••••`)
    expect((await hovered(automation_, fake)).name).toMatch(/h{5}•+$/u)
    expect((await automation_.pointed({ backendNodeId: 30 }))?.element.name).toMatch(/h{5}•+$/u)
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: `${'d'.repeat(1990)}correct\thorse` })
    expect(automation_.dialog()?.message).toMatch(/d{5}••••••••$/u)
  })

  it('cuts a dialog\'s words where the page\'s own words reach the cap, however much shorter the masks before it are', async () => {
    // A guard on the order of P-L3's fix: masked first, a page of copies is one mask, so a cut counted after it would
    // reach the copy that Sotto's own read of the dialog cut in two.
    const secret = 'hunter2-secret', fake = naming(), automation_ = await typedOn(fake, secret)
    fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: secret.repeat(200) })
    expect(automation_.dialog()?.message).toBe('••••••••')
  })

  it('masks a picked element\'s words before it drops the end its markup was cut at, so a secret its spaces join is masked whole (P-L3)', async () => {
    // Markup longer than is read, whose last words, as read, are the secret across a line break and then 190 letters.
    const phrase = 'correct horse', read = 200_000 + phrase.length * 15, tail = `correct\n\nhorse${'y'.repeat(190)}`
    const filler = read - '<div><!--'.length - '-->'.length - tail.length
    const html = `<div><!--${'z'.repeat(filler)}-->${tail}${'y'.repeat(50)}</div>`
    const automation_ = await typedOn(naming([], '', html), phrase)
    const text = (await automation_.pointed({ backendNodeId: 30 }))?.element.text ?? ''
    expect(text).not.toMatch(/correct|horse/u)
  })
})

describe('a page no secret was typed into reads nothing more for the rules on secrets (after the fourth review, P-N2)', () => {
  it('sends a type, a click and a key with only the commands each needs, once approved', async () => {
    // The text field at 9 takes up room, and is what is at its middle.
    const fake = page(), base = fake.handle, automation_ = automation(fake)
    fake.handle = (method, params) => {
      if (method === 'DOM.getContentQuads') return { quads: [[10, 10, 30, 10, 30, 30, 10, 30]] }
      if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('elementFromPoint')) return { result: { value: true } }
      return base(method, params)
    }
    const found = (): number => fake.calls('Runtime.evaluate').filter(call => String(call.expression).startsWith('document.querySelector')).length
    const actions: PageInput[] = [{ type: 'type', text: 'Rez', selector: '#name' }, { type: 'type', text: 'Rez' }, { type: 'click', selector: '#name' }, { type: 'key', key: 'a' }, { type: 'key', key: 'Backspace' }]
    for (const action of actions) {
      await automation_.target(action as Parameters<TestAutomation['target']>[0])
      const before = fake.sent.length, looked = found()
      await automation_.input(action, go)
      // A selector is looked up once, where the action is sent, and nothing else is read for it.
      expect(found() - looked, JSON.stringify(action)).toBe('selector' in action ? 1 : 0)
      if (action.type === 'key') expect(fake.sent.slice(before).map(entry => entry.method), action.key).toEqual(['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'])
    }
    // Nothing read a field or the document: the only function run on an element is the click's look at what it presses.
    expect(fake.calls('Runtime.callFunctionOn').filter(call => !String(call.functionDeclaration).includes('elementFromPoint'))).toEqual([])
    expect(fake.calls('Runtime.evaluate').filter(call => /activeElement \|\||documentElement\.textContent/u.test(String(call.expression)))).toEqual([])
  })
})

describe('a + in a secret is not a space (after the fourth review, P-N5.1)', () => {
  it('masks a + as written and escaped, and leaves a space where the secret has a +', () => {
    const plus = secretMatcher('a+b')!
    for (const form of ['[a+b]', '[a%2Bb]', '[a%252Bb]', '[a\\u002bb]']) expect(maskSecrets(form, [plus]), form).toBe('[••••••••]')
    for (const words of ['say a b now', 'q=a%20b', 'q=a%2520b']) expect(maskSecrets(words, [plus]), words).toBe(words)
    // A space in the secret is still found however a form or an address writes it, a + for it included.
    const spaced = secretMatcher('my pass')!
    for (const form of ['my pass', 'my+pass', 'my%20pass', 'my%2Bpass', 'my%252Bpass']) expect(maskSecrets(`[${form}]`, [spaced]), form).toBe('[••••••••]')
  })
})
