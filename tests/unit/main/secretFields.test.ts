// @vitest-environment jsdom
/**
 * Fields on a page a secret was typed into (ADR-0219 and ADR-0222, after the fourth review of the browser-parity
 * branch), with every read Sotto makes of the page run in a DOM, as Chromium runs it in the page: which keys a field
 * that holds the secret still takes, by the kind of field it is; that the page's own origin is not taken for the
 * secret; and that a field Sotto cannot read counts as one that holds it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { PageAutomation, type PageDebugger, type PageEventListener, type PageFrame, type PageInput, type PagePicture } from '../../../src/main/tools/pageAutomation'

beforeAll(() => {
  // jsdom has neither; Chromium's are what Sotto's reads of a field use.
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', { configurable: true, get(this: HTMLElement) { return this.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') !== null } })
  Object.defineProperty(HTMLElement.prototype, 'innerText', { configurable: true, get(this: HTMLElement) { return this.textContent ?? '' } })
})
afterEach(() => { document.body.replaceChildren() })

/**
 * A page's debugger backed by this DOM: each expression Sotto evaluates and each function it calls on an element runs
 * here, as Chromium runs them in the page, and an exception comes back as Chromium's `exceptionDetails`. Elements and
 * values are handed out by id. With `unresolved`, an element named by node cannot be resolved, as one Chromium no
 * longer has.
 */
class DomPage implements PageDebugger {
  readonly sent: { method: string; params: Record<string, unknown> }[] = []
  address = 'https://shop.example/login'
  unresolved = false
  private readonly nodes = new Map<number, Element>()
  private readonly objects = new Map<string, unknown>()
  private listener: PageEventListener | null = null
  private attached = false
  isGone(): boolean { return false }
  url(): string { return this.address }
  isAttached(): boolean { return this.attached }
  attach(): void { this.attached = true }
  detach(): void { this.attached = false }
  onEvent(listener: PageEventListener): void { this.listener = listener }
  offEvent(): void { this.listener = null }
  emit(method: string, params: Record<string, unknown>): void { this.listener?.(method, params) }
  keys(): string[] { return this.sent.filter(entry => entry.method === 'Input.dispatchKeyEvent' && entry.params.type !== 'keyUp').map(entry => String(entry.params.key)) }
  private idOf(element: Element): number {
    for (const [id, known] of this.nodes) if (known === element) return id
    this.nodes.set(this.nodes.size + 1, element)
    return this.nodes.size
  }
  private handOut(value: unknown): string {
    const id = `object-${this.objects.size + 1}`
    this.objects.set(id, value)
    return id
  }
  async sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression)
      if (expression === 'location.origin') return { result: { type: 'string', value: new URL(this.address).origin } }
      let value: unknown
      try { value = (0, eval)(expression) } catch (error) { return { exceptionDetails: { text: String(error) } } }
      if (params.returnByValue) return { result: { value } }
      return value === null || value === undefined ? { result: { subtype: 'null' } } : { result: { objectId: this.handOut(value) } }
    }
    if (method === 'Runtime.callFunctionOn') {
      const run = (0, eval)(`(${String(params.functionDeclaration)})`) as (...args: unknown[]) => unknown
      const args = ((params.arguments ?? []) as { value: unknown }[]).map(argument => argument.value)
      try { return { result: { value: run.apply(this.objects.get(String(params.objectId)), args) } } } catch (error) { return { exceptionDetails: { text: String(error) } } }
    }
    if (method === 'DOM.describeNode') {
      const element = (params.objectId !== undefined ? this.objects.get(String(params.objectId)) : this.nodes.get(Number(params.backendNodeId))) as Element | undefined
      if (!element) return {}
      return { node: { backendNodeId: this.idOf(element), nodeName: element.nodeName, nodeType: 1, attributes: [...element.attributes].flatMap(attribute => [attribute.name, attribute.value]) } }
    }
    if (method === 'DOM.resolveNode') {
      const element = this.nodes.get(Number(params.backendNodeId))
      return this.unresolved || !element ? {} : { object: { objectId: this.handOut(element) } }
    }
    if (method === 'DOM.focus') { (this.nodes.get(Number(params.backendNodeId)) as HTMLElement | undefined)?.focus(); return {} }
    if (method === 'Input.insertText') {
      const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null
      if (focused && 'value' in focused) focused.value += String(params.text)
      else if (focused) focused.textContent += String(params.text)
      return {}
    }
    return {}
  }
}

class TestAutomation extends PageAutomation {
  protected picture(frame: PageFrame): PagePicture { return { empty: false, width: frame.width, height: frame.height, dataUrl: `data:image/png;base64,${frame.data}` } }
  evidence(): null { return null }
  async thumbnail(): Promise<string | null> { return null }
}

const go = (): void => undefined
type Key = Extract<PageInput, { type: 'key' }>
const key = (pressed: string, ...modifiers: NonNullable<Key['modifiers']>): Key => ({ type: 'key', key: pressed, modifiers })

/** A sign-in page with a password field, `value` typed into it from a secret request, and the focus then on `field`. */
async function typedInto(value: string, field?: HTMLElement, options: { address?: string } = {}): Promise<{ fake: DomPage; automation: TestAutomation }> {
  document.body.innerHTML = '<input id="password" type="password">'
  const fake = new DomPage(), automation = new TestAutomation(fake)
  if (options.address) fake.address = options.address
  automation.parity = true
  await automation.typeSecret(async () => value, go, { selector: '#password' })
  expect((document.getElementById('password') as HTMLInputElement).value).toBe(value)
  if (field) { document.body.append(field); field.focus(); expect(document.activeElement).toBe(field) }
  return { fake, automation }
}
const holding = {
  'a single-line field': (text: string): HTMLElement => Object.assign(document.createElement('input'), { type: 'text', value: text }),
  'a textarea': (text: string): HTMLElement => Object.assign(document.createElement('textarea'), { value: text }),
  'a rich field': (text: string): HTMLElement => { const rich = document.createElement('div'); rich.setAttribute('contenteditable', 'true'); rich.tabIndex = 0; rich.textContent = text; return rich },
} as const
type FieldKind = keyof typeof holding

describe('the keys a field that holds a typed secret takes, by its kind (after the fourth review, P-L2)', () => {
  // The caret keys and Escape, in any field (NON_EDITING_KEYS), and Enter and Tab, in a one-line one (ONE_LINE_KEYS).
  const caretKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
  const takes = (kind: FieldKind, pressed: string): boolean => (pressed === 'Enter' || pressed === 'Tab') ? kind === 'a single-line field' : true

  for (const kind of Object.keys(holding) as FieldKind[]) {
    it(`in ${kind}: the caret keys and Escape go, and Enter and Tab go only where they cannot put a line break or a tab in it`, async () => {
      const { fake, automation } = await typedInto('hunter2-secret', holding[kind]('hunter2-secret'))
      for (const pressed of [...caretKeys, 'Enter', 'Tab', 'Escape']) {
        for (const action of [key(pressed), key(pressed, 'Alt')]) {
          const label = `${kind}: ${[...action.modifiers ?? [], pressed].join('+')}`
          const sent = fake.keys().length
          if (takes(kind, pressed)) {
            await automation.target(action)
            await automation.input(action, go)
            expect(fake.keys().slice(sent), label).toEqual([pressed])
          } else {
            await expect(automation.target(action), label).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
            await expect(automation.input(action, go), label).rejects.toMatchObject({ code: 'blocked' })
            expect(fake.keys().slice(sent), label).toEqual([])
          }
        }
      }
      // Space types a space in any of them, and Shift+Tab is Tab.
      await expect(automation.input(key('Space'), go)).rejects.toMatchObject({ code: 'blocked' })
      if (kind === 'a single-line field') await automation.input(key('Tab', 'Shift'), go)
      else await expect(automation.input(key('Tab', 'Shift'), go)).rejects.toMatchObject({ code: 'blocked' })
    })
  }

  it('takes every key in a field of any kind that holds none of the secret', async () => {
    for (const kind of Object.keys(holding) as FieldKind[]) {
      const { fake, automation } = await typedInto('hunter2-secret', holding[kind]('notes'))
      for (const pressed of ['Enter', 'Tab', 'Backspace', 'Space']) await automation.input(key(pressed), go)
      expect(fake.keys(), kind).toEqual(['Enter', 'Tab', 'Backspace', ' '])
    }
  })
})

describe('the page\'s own origin is not taken for the secret (after the fourth review, P-L4)', () => {
  it('finds no secret in a later document or a field that names the page\'s own address, and finds it said on its own', async () => {
    // A PIN that is also the page's port: a later document's script names the page's address, and a field holds a webhook on it.
    const hook = holding['a single-line field']('http://localhost:5173/hooks/deploy')
    const { fake, automation } = await typedInto('5173', hook, { address: 'http://localhost:5173/login' })
    // The sign-in document is gone, and its field with it.
    automation.documentCommitted()
    document.getElementById('password')!.remove()
    document.body.insertAdjacentHTML('afterbegin', '<script type="application/json">{"api":"http://localhost:5173/api"}</script><p>Dashboard</p>')
    expect(await automation.showsSecret()).toBe(false)
    await automation.input({ type: 'key', key: 'a', modifiers: ['Control'] }, go)
    await automation.input(key('Backspace'), go)
    expect(fake.keys()).toEqual(['a', 'Backspace'])
    // Said on its own, it is the secret.
    document.body.insertAdjacentHTML('beforeend', '<p>Your PIN is 5173</p>')
    expect(await automation.showsSecret()).toBe(true)
    ;(hook as HTMLInputElement).value = 'PIN 5173'
    await expect(automation.input(key('Backspace'), go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
  })
})

describe('a field Sotto cannot read counts as one that holds the secret (after the fourth review, P-N1)', () => {
  it('refuses a key when reading the field throws in the page, or the field it names cannot be resolved', async () => {
    const field = holding['a single-line field']('')
    Object.defineProperty(field, 'value', { configurable: true, get() { throw new Error('The page will not say.') } })
    const { fake, automation } = await typedInto('hunter2-secret', field)
    await expect(automation.input(key('Backspace'), go)).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
    await expect(automation.target(key('Backspace'))).rejects.toMatchObject({ code: 'blocked' })
    // A field that reads, but that Chromium can no longer resolve by its node.
    const plain = holding['a single-line field']('notes')
    document.body.append(plain); plain.focus()
    fake.unresolved = true
    await expect(automation.target(key('Backspace'))).rejects.toMatchObject({ code: 'blocked', message: expect.stringContaining('holds a secret you saved') })
    expect(fake.keys()).toEqual([])
  })
})

