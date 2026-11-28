// @vitest-environment node
/**
 * The canary with the full catalog on (ADR-0219, ADR-0220 decision 6, and Gemini's review): one known value is typed by
 * ref and by selector into a page that echoes it every way it can (its words, its title, its address through a form sent
 * by GET, a dialog, an evaluated value), and goes through a hash change, Stop sharing and sharing again, snapshots and
 * screenshots. It appears nowhere but the page: no tool result, browser event, log line or task. While the document
 * that holds it is loaded, evaluate stays off, no picture of the page goes to the agent and a dialog's words are not
 * passed on in any form; once the page's address has held it, evaluate stays off for the page's life.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretRequests } from '../../src/main/secrets/secretRequests'
import { registerSecretRequestsIpc } from '../../src/main/secrets/secretRequestsIpc'
import { SecretToolServer } from '../../src/main/agents/secretTools'
import { BrowserService } from '../../src/main/tools/browser'
import { createBrowserAgentServer } from '../../src/main/tools/browserAgentTools'
import { FilesService } from '../../src/main/files/service'
import { SECRET_REQUESTS_ANSWER } from '../../src/shared/secretRequests'
import type { BrowserEvent } from '../../src/shared/browser'
import { ipcRegistry } from '../fixtures/ipcHarness'

/** A space and an ampersand, so an address carries it encoded. */
const CANARY = 'CANARY-7d21 f0b3&e9a4-s3cr3t'
const REVERSED = [...CANARY].reverse().join('')
/** The page: what was typed into its password field, and which element has the focus (7 the password field, 9 a text field). */
const page = vi.hoisted(() => ({ typed: '', focus: 9, contents: [] as { url: string; emit(event: string, ...args: unknown[]): boolean; debugger: { emit(event: string, ...args: unknown[]): boolean } }[] }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } }
    if (method === 'Page.captureScreenshot') return { data: 'YQ==' }
    if (method === 'Input.insertText') { page.typed += String(params.text); return {} }
    if (method === 'DOM.focus') { page.focus = params.backendNodeId as number; return {} }
    // A page that repeats what was typed, as a text field's name and its words, is the worst case.
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Sign in' }, childIds: ['2', '3'] },
      { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Password' }, backendDOMNodeId: 7 },
      { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: `Echo ${page.typed}` }, backendDOMNodeId: 9 },
    ] }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression)
      if (expression === 'document.activeElement') return { result: { objectId: 'active' } }
      if (expression === 'location.origin') return { result: { type: 'string', value: new URL(page.contents.at(-1)!.url).origin } }
      if (expression.startsWith('document.querySelector("#password")')) return { result: { objectId: 'password' } }
      if (expression.includes('document.title')) return { result: { value: { title: 'Sign in', text: `Echo ${page.typed}`, state: 'complete' } } }
      if (expression.startsWith('Array.from(document.querySelectorAll')) return { result: { value: [{ tag: 'input', role: '', name: page.typed, x: 0, y: 0, width: 200, height: 30, disabled: false }] } }
      if (params.returnByValue && params.userGesture) return { result: { type: 'string', value: `field holds ${page.typed}` } }
      return { result: {} }
    }
    if (method === 'DOM.describeNode') {
      const node = params.objectId === 'active' ? page.focus : params.objectId === 'password' ? 7 : params.backendNodeId
      return node === 7 ? { node: { backendNodeId: 7, nodeName: 'INPUT', attributes: ['id', 'password', 'type', 'password'] } } : { node: { backendNodeId: 9, nodeName: 'INPUT', attributes: ['id', 'echo', 'type', 'text'] } }
    }
    return {}
  }
  class Contents extends EventEmitter {
    url = ''; destroyed = false; zoom = 1
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(send) })
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toDataURL: () => 'data:image/png;base64,YQ==', resize: () => ({ toJPEG: () => Buffer.from('thumbnail') }) }))
    getBackgroundThrottling = vi.fn(() => true)
    setBackgroundThrottling = vi.fn()
    getZoomFactor() { return this.zoom }
    setZoomFactor(zoom: number) { this.zoom = zoom }
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    constructor() { super(); page.contents.push(this) }
    /** A load commits a new document and finishes, as Chromium says it. */
    loadURL(url: string) {
      this.url = url
      setTimeout(() => { this.emit('did-start-navigation', {}, url, false, true); this.emit('did-navigate', {}, url); this.emit('did-finish-load') }, 0)
      return Promise.resolve()
    }
    setWindowOpenHandler = vi.fn(); focus = vi.fn()
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class IsolatedSession extends EventEmitter {
    setSpellCheckerDictionaryDownloadURL = vi.fn(); setSpellCheckerEnabled = vi.fn()
    setPermissionRequestHandler = vi.fn(); setPermissionCheckHandler = vi.fn(); setDevicePermissionHandler = vi.fn()
    webRequest = { onBeforeRequest: vi.fn() }
    closeAllConnections = vi.fn().mockResolvedValue(undefined)
  }
  const makeImage = (buffer: Buffer, width = 1280, height = 800): unknown => ({
    isEmpty: () => false, getSize: () => ({ width, height }), toDataURL: () => `data:image/png;base64,${buffer.toString('base64')}`,
    toBitmap: () => buffer, toJPEG: () => buffer,
    crop: (region: { width: number; height: number }) => makeImage(buffer, region.width, region.height),
    resize: (size: { width?: number; height?: number }) => makeImage(buffer, size.width ?? width, size.height ?? height),
  })
  class CaptureWindow {
    destroyed = false
    children = new Set<unknown>()
    contentView = { addChildView: (view: unknown) => this.children.add(view), removeChildView: (view: unknown) => this.children.delete(view) }
    isDestroyed = () => this.destroyed
    showInactive = vi.fn()
    destroy = () => { this.destroyed = true; this.children.clear() }
  }
  return { BaseWindow: vi.fn(CaptureWindow), screen: { getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    nativeImage: { createFromDataURL: vi.fn((data: string) => makeImage(Buffer.from(data.split(',')[1]!, 'base64'))), createFromBuffer: vi.fn((buffer: Buffer) => makeImage(buffer)) },
    WebContentsView: vi.fn(class { webContents = new Contents(); bounds = { x: 0, y: 0, width: 1280, height: 800 }; setBounds = vi.fn((bounds: typeof this.bounds) => { this.bounds = bounds }); getBounds = () => this.bounds }),
    session: { fromPartition: () => new IsolatedSession() } }
})

/** Everything that must never hold the value, as text, and what the agent was told, which must not hold it in any form. */
const seen: string[] = []
const told: string[] = []
const record = (value: unknown): void => { seen.push(typeof value === 'string' ? value : JSON.stringify(value)) }
let userData: string, work: string
let secrets: SecretRequests, tools: SecretToolServer, browser: BrowserService
let answer: (values: unknown) => Promise<unknown>
const events: BrowserEvent[] = []
const THREAD = 'thread-parity-canary'

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'sotto-parity-canary-data-'))
  work = await mkdtemp(join(tmpdir(), 'sotto-parity-canary-work-'))
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { record(args.map(String).join(' ')) })
  secrets = new SecretRequests({ directory: userData, protect: async () => undefined })
  secrets.subscribe(() => { record([...secrets.requests()]) })
  tools = new SecretToolServer({ admits: () => true, service: secrets })
  const { ipc, handlers, main, mainEvent } = ipcRegistry()
  registerSecretRequestsIpc(ipc, secrets, () => [main], () => undefined)
  answer = async values => { const result = await handlers.get(SECRET_REQUESTS_ANSWER)!(mainEvent, values); record(result); return result }
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: work }), copyPath: vi.fn(), reveal: vi.fn() })
  browser = new BrowserService({ files, getWindow: () => null, emit: event => { events.push(event); record(event) }, openExternal: vi.fn(), destination: async () => 'embedded', byDefault: () => true,
    parity: true, secret: async (threadId, ref) => secrets.take(threadId, ref), secretSite: async (threadId, ref) => secrets.site(threadId, ref) })
})
afterAll(async () => {
  browser.dispose()
  secrets.close()
  await tools.close()
  vi.restoreAllMocks()
  await rm(userData, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

async function secretRef(): Promise<string> {
  const call = tools.call(THREAD, 'request_secret', { label: 'Staging password', reason: 'To sign in to staging.', url: 'http://127.0.0.1:5173/login' })
  await vi.waitFor(() => expect(secrets.requests().get(THREAD)?.length).toBe(1))
  const requestId = secrets.requests().get(THREAD)![0]!.id
  expect(await answer({ answer: 'save', threadId: THREAD, requestId, values: { value: CANARY } })).toEqual({ ok: true })
  const result = await call
  record(result)
  return (JSON.parse((result.content[0] as { text: string }).text) as { secretRef: string }).secretRef
}
const agent = createBrowserAgentServer(() => browser, undefined, true)
async function call(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const result = await agent.call(THREAD, name, args)
  record(result)
  const text = result.content.map(part => 'text' in part ? part.text : '').join('\n')
  told.push(text)
  return { ...result.isError ? { isError: true } : {}, text }
}

let target: { pageId: string; taskId: string }
const act = (action: Record<string, unknown>) => call('browser_action', { ...target, action })
const contents = () => page.contents.at(-1)!
const pageRequest = () => ({ threadId: THREAD, workspaceId: events.find(event => event.type === 'page')!.type === 'page' ? (events.find(event => event.type === 'page') as Extract<BrowserEvent, { type: 'page' }>).page.workspace.workspaceId : '', pageId: target.pageId })

describe('a secret typed into a page with the full catalog on', () => {
  it('is typed by a snapshot\'s ref into the password field, and the snapshot after says only a mask', async () => {
    const opened = await call('browser_open', { url: 'http://127.0.0.1:5173/login', description: 'Sign in to staging' })
    expect(opened.isError).toBeFalsy()
    const { task } = JSON.parse(opened.text) as { task: { id: string; pageId: string } }
    target = { pageId: task.pageId, taskId: task.id }
    const snapshot = await act({ type: 'snapshot' })
    expect(snapshot.text).toContain('textbox \\"Password\\" [ref=e1]')
    const typed = await act({ type: 'type', ref: 'e1', secretRef: await secretRef() })
    expect(typed.isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
    expect(page.focus).toBe(7)
    const after = await act({ type: 'snapshot' })
    expect(after.text).toContain('Echo ••••••••')
  })

  it('keeps evaluate off through a hash change, Stop sharing and sharing again', async () => {
    expect((await act({ type: 'evaluate', expression: 'document.querySelector("#password").value' }))).toMatchObject({ isError: true, text: expect.stringContaining('holds a secret') })
    contents().emit('did-start-navigation', {}, 'http://127.0.0.1:5173/login#pay', true, true)
    contents().emit('did-navigate-in-page', {}, 'http://127.0.0.1:5173/login#pay', true)
    expect((await act({ type: 'evaluate', expression: '1 + 1' })).isError).toBe(true)
    unwrapped(await browser.share({ ...pageRequest(), enabled: false }))
    unwrapped(await browser.share({ ...pageRequest(), enabled: true }))
    unwrapped(await browser.controlTask({ ...pageRequest(), taskId: target.taskId, control: 'resume' }))
    expect((await act({ type: 'evaluate', expression: '1 + 1' }))).toMatchObject({ isError: true, text: expect.stringContaining('holds a secret') })
  })

  it('passes on none of a dialog\'s words while the document holds the secret', async () => {
    contents().debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: `Saved: ${REVERSED}` })
    for (const action of [{ type: 'snapshot' }, { type: 'click', x: 10, y: 10 }, { type: 'screenshot' }]) {
      const refused = await act(action)
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('alert dialog open')
      expect(refused.text).not.toContain('Saved')
    }
    const answered = await act({ type: 'dialog', accept: true })
    expect(answered.text).toContain('Accepted the alert dialog.')
    contents().debugger.emit('message', {}, 'Page.javascriptDialogClosed', {})
    // Answered, the page still holds the secret, so no picture of it goes to the agent.
    expect(await act({ type: 'screenshot' })).toMatchObject({ isError: true, text: expect.stringContaining('no picture of it goes to you') })
  })

  it('is masked in the page\'s title and in an address a form sent by GET', async () => {
    contents().emit('page-title-updated', {}, `Welcome back ${CANARY}`)
    const address = `http://127.0.0.1:5173/login?password=${encodeURIComponent(CANARY).replace(/%20/gu, '+')}`
    contents().url = address
    contents().emit('did-start-navigation', {}, address, false, true)
    contents().emit('did-navigate', {}, address)
    contents().emit('did-finish-load')
    const pages = await call('browser_pages', {})
    expect(pages.text).toContain('Welcome back ••••••••')
    expect(pages.text).toContain('password=••••••••')
    // A new document committed, but its address holds the value, and the page's history keeps it: evaluate stays off.
    const evaluated = await act({ type: 'evaluate', expression: 'btoa(location.search)' })
    expect(evaluated).toMatchObject({ isError: true, text: expect.stringContaining('address') })
    await call('browser_status', {})
  })

  it('is typed again by a selector, from a new reference, into the field named', async () => {
    page.typed = ''
    page.focus = 9
    const typed = await act({ type: 'type', selector: '#password', secretRef: await secretRef(), clear: true })
    expect(typed.isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
    expect(page.focus).toBe(7)
    expect((await act({ type: 'evaluate', expression: '1 + 1' })).isError).toBe(true)
  })

  it('appears in none of it, in any form', async () => {
    const forms = [CANARY, encodeURIComponent(CANARY), encodeURIComponent(CANARY).replace(/%20/gu, '+'), Buffer.from(CANARY).toString('base64')]
    for (const text of seen) for (const form of forms) expect(text).not.toContain(form)
    // The dialog's words, which held the value backwards, went nowhere the agent reads. (A page that writes a transform of
    // the value into its own content can show it in a snapshot: masking matches the value as written and as an address or
    // JSON carries it, and such a page holds the value anyway. ADR-0222 says so.)
    for (const text of told) expect(text).not.toContain(REVERSED.slice(0, 12))
    expect(told.length).toBeGreaterThan(10)
  })
})

function unwrapped<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
