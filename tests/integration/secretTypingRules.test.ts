// @vitest-environment node
/**
 * Where Sotto's browser types a secret reference, and when it will not (ADR-0219 and ADR-0222, as the review of the
 * browser-parity branch asked): only on the site its card named, asking every time when the card named none; never into
 * a document the agent ran its own script in; and a type that fails before the value goes leaves the reference for
 * another try, while one that fails after says, as an error, that the reference is used. While the document holds the
 * value no picture of the page goes to the agent, and once a secret was typed into a page, evaluate stays off for as
 * long as the page is open.
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
import { SECRET_REQUESTS_ANSWER, SECRET_VALUE_MAX } from '../../src/shared/secretRequests'
import type { BrowserEvent, BrowserTask } from '../../src/shared/browser'
import { ipcRegistry } from '../fixtures/ipcHarness'

const CANARY = 'CANARY-51c8 a0d2&b7e6-s3cr3t'
/** The page: what was typed into its password field (7), which element has the focus (9 a text field), and whether focus is refused. */
const page = vi.hoisted(() => ({ typed: '', focus: 9, refuseFocus: false, contents: [] as { url: string; emit(event: string, ...args: unknown[]): boolean }[] }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const send = async (contents: { url: string }, method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } }
    if (method === 'Page.captureScreenshot') return { data: 'YQ==' }
    if (method === 'Input.insertText') { page.typed += String(params.text); return {} }
    if (method === 'DOM.focus') { if (!page.refuseFocus) page.focus = params.backendNodeId as number; return {} }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Sign in' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Password' }, backendDOMNodeId: 7 },
    ] }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression)
      if (expression === 'document.activeElement') return { result: { objectId: 'active' } }
      if (expression === 'location.origin') return { result: { type: 'string', value: new URL(contents.url).origin } }
      if (expression.startsWith('document.querySelector("#password")')) return { result: { objectId: 'password' } }
      if (expression.includes('document.title')) return { result: { value: { title: 'Sign in', text: 'Sign in', state: 'complete' } } }
      if (params.returnByValue && params.userGesture) return { result: { type: 'string', value: 'ran' } }
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
    debugger: InstanceType<typeof EventEmitter> & { isAttached(): boolean; attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> }
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toDataURL: () => 'data:image/png;base64,YQ==', resize: () => ({ toJPEG: () => Buffer.from('thumbnail') }) }))
    getBackgroundThrottling = vi.fn(() => true)
    setBackgroundThrottling = vi.fn()
    getZoomFactor() { return this.zoom }
    setZoomFactor(zoom: number) { this.zoom = zoom }
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    constructor() {
      super()
      this.debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => send(this, method, params)) })
      page.contents.push(this)
    }
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

let userData: string, work: string
let secrets: SecretRequests, tools: SecretToolServer, browser: BrowserService
let answer: (values: unknown) => Promise<unknown>
const events: BrowserEvent[] = []
const THREAD = 'thread-secret-typing'

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'sotto-secret-typing-data-'))
  work = await mkdtemp(join(tmpdir(), 'sotto-secret-typing-work-'))
  secrets = new SecretRequests({ directory: userData, protect: async () => undefined })
  tools = new SecretToolServer({ admits: () => true, service: secrets })
  const { ipc, handlers, main, mainEvent } = ipcRegistry()
  registerSecretRequestsIpc(ipc, secrets, () => [main], () => undefined)
  answer = async values => handlers.get(SECRET_REQUESTS_ANSWER)!(mainEvent, values)
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: work }), copyPath: vi.fn(), reveal: vi.fn() })
  // The browser grant is on, as it is by default (ADR-0029).
  browser = new BrowserService({ files, getWindow: () => null, emit: event => { events.push(event) }, openExternal: vi.fn(), destination: async () => 'embedded', byDefault: () => true,
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

/** Asks for a secret as the agent would, saves the card with `value` as the user would, and returns the reference. */
async function secretRef(card: Record<string, unknown> = {}, value = CANARY): Promise<string> {
  const call = tools.call(THREAD, 'request_secret', { label: 'GitHub password', reason: 'To sign in.', ...card })
  await vi.waitFor(() => expect(secrets.requests().get(THREAD)?.length).toBe(1))
  const requestId = secrets.requests().get(THREAD)![0]!.id
  expect(await answer({ answer: 'save', threadId: THREAD, requestId, values: { value } })).toEqual({ ok: true })
  const result = await call
  return (JSON.parse((result.content[0] as { text: string }).text) as { secretRef: string }).secretRef
}
const agent = createBrowserAgentServer(() => browser, undefined, true)
async function call(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string; images: number }> {
  const result = await agent.call(THREAD, name, args)
  const text = result.content.map(part => 'text' in part ? part.text : '').join('\n')
  return { ...result.isError ? { isError: true } : {}, text, images: result.content.filter(part => part.type === 'image').length }
}
/** Opens a page for the thread and returns how to act on it. */
async function opened(url: string): Promise<{ act: (action: Record<string, unknown>) => ReturnType<typeof call>; pageId: string; taskId: string }> {
  const result = await call('browser_open', { url, description: 'Sign in' })
  expect(result.isError).toBeFalsy()
  const { task } = JSON.parse(result.text) as { task: { id: string; pageId: string } }
  await vi.waitFor(() => expect(page.contents.at(-1)!.url).toBe(url))
  return { act: action => call('browser_action', { pageId: task.pageId, taskId: task.id, action }), pageId: task.pageId, taskId: task.id }
}
const workspaceId = (): string => (events.find(event => event.type === 'page') as Extract<BrowserEvent, { type: 'page' }>).page.workspace.workspaceId
const latestTask = (taskId: string): BrowserTask | undefined => (events.filter(event => event.type === 'task' && event.task.id === taskId).at(-1) as Extract<BrowserEvent, { type: 'task' }> | undefined)?.task
const fresh = (): void => { page.typed = ''; page.focus = 9; page.refuseFocus = false }

describe('a secret reference is typed only on the site its card named', () => {
  it('is refused on another site, even under the browser grant, and is still there for its own site', async () => {
    fresh()
    const ref = await secretRef({ url: 'https://github.com/login' })
    const elsewhere = await opened('https://attacker.example.net/fake-login')
    const refused = await elsewhere.act({ type: 'type', selector: '#password', secretRef: ref })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('https://github.com')
    expect(page.typed).toBe('')
    const own = await opened('https://github.com/login')
    const typed = await own.act({ type: 'type', selector: '#password', secretRef: ref })
    expect(typed.isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
  })

  it('asks every time when the card named no site, shows the page it would go to, and is never the thread\'s grant', async () => {
    fresh()
    const ref = await secretRef()
    const staging = await opened('https://staging.example/login')
    const typing = staging.act({ type: 'type', selector: '#password', secretRef: ref })
    await vi.waitFor(() => expect(latestTask(staging.taskId)?.pendingAction?.action.type).toBe('type'))
    const pending = latestTask(staging.taskId)!.pendingAction!
    expect(pending.everyTime).toBe(true)
    expect(pending.description).toContain('https://staging.example/login')
    expect(page.typed).toBe('')
    const target = { threadId: THREAD, workspaceId: workspaceId(), pageId: staging.pageId, taskId: staging.taskId, actionId: pending.id }
    expect(await browser.answerAction({ ...target, allow: true, forThread: true })).toMatchObject({ ok: false })
    expect(await browser.answerAction({ ...target, allow: true })).toMatchObject({ ok: true })
    expect((await typing).isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
  })
})

describe('a secret reference is not typed where the agent\'s script could be listening', () => {
  it('is refused in a document the agent ran script in, until another document loads', async () => {
    fresh()
    const ref = await secretRef({ url: 'https://github.com/login' })
    const github = await opened('https://github.com/login')
    const planted = await github.act({ type: 'evaluate', expression: 'document.querySelector("#password").addEventListener("input", event => history.replaceState(null, "", "#" + btoa(event.target.value)))' })
    expect(planted.isError).toBeFalsy()
    const refused = await github.act({ type: 'type', selector: '#password', secretRef: ref })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('script')
    expect(page.typed).toBe('')
    // Loading the sign-in page again is a new document, which no script of the agent's has run in.
    expect((await github.act({ type: 'navigate', url: 'https://github.com/login' })).isError).toBeFalsy()
    expect((await github.act({ type: 'type', selector: '#password', secretRef: ref })).isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
  })

  it('keeps evaluate off for the rest of the page\'s life once the page\'s address has held the secret', async () => {
    const github = await opened('https://github.com/login')
    fresh()
    expect((await github.act({ type: 'type', selector: '#password', secretRef: await secretRef({ url: 'https://github.com/login' }) })).isError).toBeFalsy()
    // The sign-in form is sent by GET: the next document's address carries the value, and its history keeps it.
    const contents = page.contents.at(-1)!
    for (const address of [`https://github.com/session?password=${encodeURIComponent(CANARY).replace(/%20/gu, '+')}`, 'https://github.com/dashboard']) {
      contents.url = address
      contents.emit('did-start-navigation', {}, address, false, true)
      contents.emit('did-navigate', {}, address)
      contents.emit('did-finish-load')
      const refused = await github.act({ type: 'evaluate', expression: 'btoa(navigation.entries().map(entry => entry.url).join())' })
      expect(refused.isError).toBe(true)
      expect(refused.text).not.toContain('ran')
    }
  })
})

describe('a type the user allowed that fails once the value is taken (the second review, R-N3)', () => {
  it('tells the agent, as an error, that its reference is used', async () => {
    fresh()
    // A card that named no site asks every time, so the agent waits for the user's answer.
    const ref = await secretRef()
    const staging = await opened('https://staging.example/login')
    const typing = staging.act({ type: 'type', selector: '#password', secretRef: ref })
    await vi.waitFor(() => expect(latestTask(staging.taskId)?.pendingAction?.action.type).toBe('type'))
    const pending = latestTask(staging.taskId)!.pendingAction!
    // The page moves the focus while the value comes from the engine.
    const take = secrets.take.bind(secrets)
    vi.spyOn(secrets, 'take').mockImplementationOnce((threadId, used) => { const value = take(threadId, used); page.focus = 9; return value })
    await browser.answerAction({ threadId: THREAD, workspaceId: workspaceId(), pageId: staging.pageId, taskId: staging.taskId, actionId: pending.id, allow: true })
    const result = await typing
    expect(result.isError).toBe(true)
    expect(result.text).toContain('this secretRef is used')
    expect(result.text).not.toContain(CANARY)
    expect(page.typed).toBe('')
  })
})

describe('a failed type and the pictures of a page that holds a secret', () => {
  it('leaves the reference for another try when typing fails before the value goes', async () => {
    fresh()
    const ref = await secretRef({ url: 'https://github.com/login' })
    const github = await opened('https://github.com/login')
    page.refuseFocus = true
    const failed = await github.act({ type: 'type', selector: '#password', secretRef: ref })
    expect(failed.isError).toBe(true)
    expect(page.typed).toBe('')
    page.refuseFocus = false
    const again = await github.act({ type: 'type', selector: '#password', secretRef: ref })
    expect(again.isError).toBeFalsy()
    expect(page.typed).toBe(CANARY)
  })

  it('sends the agent no picture of the page while its document holds the secret', async () => {
    fresh()
    const github = await opened('https://github.com/login')
    expect((await github.act({ type: 'type', selector: '#password', secretRef: await secretRef({ url: 'https://github.com/login' }) })).isError).toBeFalsy()
    const shot = await github.act({ type: 'screenshot' })
    expect(shot.isError).toBe(true)
    expect(shot.images).toBe(0)
    const saved = await github.act({ type: 'screenshot', save: true })
    expect(saved.isError).toBe(true)
    const read = await github.act({ type: 'snapshot', includeImage: true })
    expect(read.isError).toBeFalsy()
    expect(read.images).toBe(0)
    expect(read.text).toContain('Password')
    // A new document holds no secret, so the pictures come back.
    expect((await github.act({ type: 'navigate', url: 'https://github.com/' })).isError).toBeFalsy()
    const after = await github.act({ type: 'screenshot' })
    expect(after.isError).toBeFalsy()
    expect(after.images).toBe(1)
  })
})

describe('a typed secret of any length, and one the page\'s own address holds (the third review)', () => {
  it('keeps the browser working once a secret of the longest length a card takes is typed, and its words go nowhere', async () => {
    fresh()
    // Characters a pattern would have had to escape, a backslash and a quote among them.
    const awkward = '\\"%+ /.*?()[]{}|^$aZ9'
    const long = Array.from({ length: SECRET_VALUE_MAX }, (_, index) => awkward[index % awkward.length]).join('')
    const github = await opened('https://github.com/login')
    expect((await github.act({ type: 'type', selector: '#password', secretRef: await secretRef({ url: 'https://github.com/login' }, long) })).isError).toBeFalsy()
    expect(page.typed).toBe(long)
    // The page's own news is published outside any tool call, and none of it may throw.
    const contents = page.contents.at(-1)!
    expect(() => { contents.emit('page-title-updated', {}, `Welcome ${long}`); contents.emit('did-navigate-in-page', {}, 'https://github.com/login#done', true) }).not.toThrow()
    for (const [name, args] of [['browser_pages', {}], ['browser_status', {}]] as const) {
      const said = await call(name, args)
      expect(said.isError, name).toBeFalsy()
      expect(said.text).not.toContain(long.slice(0, 200))
    }
    const read = await github.act({ type: 'snapshot' })
    expect(read.isError).toBeFalsy()
    expect(JSON.stringify(events)).not.toContain(long.slice(0, 200))
  })

  it('keeps a page\'s origin whole when the secret matches its port or its host, and the agent still sees the page', async () => {
    for (const { secret, address } of [{ secret: '5173', address: 'http://localhost:5173/login' }, { secret: 'staging', address: 'https://staging.example/login' }]) {
      fresh()
      const signIn = await opened(address)
      expect((await signIn.act({ type: 'type', selector: '#password', secretRef: await secretRef({ url: address }, secret) })).isError).toBeFalsy()
      const listed = JSON.parse((await call('browser_pages', {})).text) as { pages: { pageId: string; url?: string; shared: boolean }[] }
      expect(listed.pages.find(entry => entry.pageId === signIn.pageId)).toMatchObject({ url: address, shared: true })
      const read = await signIn.act({ type: 'snapshot' })
      expect(read.isError, `${secret}: ${read.text}`).toBeFalsy()
      expect(read.text).not.toContain('is not shared')
      expect(read.text).toContain(`URL: ${address}`)
      // Past the origin, the secret is masked as anywhere else.
      const contents = page.contents.at(-1)!
      const next = `${new URL(address).origin}/done?pin=${secret}`
      contents.url = next
      contents.emit('did-start-navigation', {}, next, false, true)
      expect(JSON.parse((await call('browser_pages', {})).text).pages.find((entry: { pageId: string }) => entry.pageId === signIn.pageId).url).toBe(`${new URL(address).origin}/done?pin=••••••••`)
    }
  })
})
