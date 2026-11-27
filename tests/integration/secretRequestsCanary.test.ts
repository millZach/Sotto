// @vitest-environment node
/**
 * The canary (ADR-0219): one known value goes through every way a secret request delivers it, a one-use reference
 * typed by Sotto's browser, a file a command reads, several values on one card, and a declined card, and the test
 * asserts it appears nowhere it must not: no tool result, no request the window or a phone is sent, no browser event,
 * no log line, no file in Sotto's folder but the secret file itself, and nothing the agent reads back from the page.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
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

const CANARY = 'CANARY-a8f3e1c94b72-s3cr3t'
/** What the fake page holds: the text typed into its focused password field, which it then echoes back in every way it can. */
const page = vi.hoisted(() => ({ typed: '' }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 } }
    if (method === 'Page.captureScreenshot') return { data: 'YQ==' }
    if (method === 'Input.insertText') { page.typed += String(params.text); return {} }
    // A page that repeats what was typed, as its accessible name, its words and an error, is the worst case.
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ role: { value: 'textbox' }, name: { value: `Password ${page.typed}` } }] }
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'document.activeElement') return { result: { objectId: 'password-1' } }
      return { result: { value: [{ tag: 'input', role: '', name: page.typed, x: 0, y: 0, width: 200, height: 30, disabled: false }] } }
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 7, nodeName: 'INPUT', attributes: ['type', 'password', 'aria-label', 'Password'] } }
    return {}
  }
  class Contents extends EventEmitter {
    url = ''; destroyed = false
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    debugger = Object.assign(new EventEmitter(), { isAttached: () => true, attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(send) })
    capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 1280, height: 800 }), toDataURL: () => 'data:image/png;base64,YQ==', resize: () => ({ toJPEG: () => Buffer.from('thumbnail') }) }))
    getBackgroundThrottling = vi.fn(() => true)
    setBackgroundThrottling = vi.fn()
    getURL() { return this.url }
    isDestroyed() { return this.destroyed }
    loadURL(url: string) { this.url = url; return Promise.resolve() }
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

/** Everything that must never hold the value, as text. */
const seen: string[] = []
const record = (value: unknown): void => { seen.push(typeof value === 'string' ? value : JSON.stringify(value)) }
let userData: string, work: string
let secrets: SecretRequests, tools: SecretToolServer, browser: BrowserService
let answer: (values: unknown) => Promise<unknown>
const events: BrowserEvent[] = []
const THREAD = 'thread-canary'

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'sotto-canary-data-'))
  work = await mkdtemp(join(tmpdir(), 'sotto-canary-work-'))
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { record(args.map(String).join(' ')) })
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { record(String(chunk)); return true }) as typeof process.stdout.write)
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { record(String(chunk)); return true }) as typeof process.stderr.write)
  secrets = new SecretRequests({ directory: userData, protect: async () => undefined })
  // Every listing of requests the coordinator would send to the window, Needs you, a notification or a phone.
  secrets.subscribe(() => { record([...secrets.requests()]) })
  tools = new SecretToolServer({ admits: () => true, service: secrets })
  const { ipc, handlers, main, mainEvent } = ipcRegistry()
  registerSecretRequestsIpc(ipc, secrets, () => [main], () => undefined)
  answer = async values => { const result = await handlers.get(SECRET_REQUESTS_ANSWER)!(mainEvent, values); record(result); return result }
  const files = new FilesService({ resolveBinding: threadId => ({ threadId, projectId: 'p', workingDirectory: work }), copyPath: vi.fn(), reveal: vi.fn() })
  browser = new BrowserService({ files, getWindow: () => null, emit: event => { events.push(event); record(event) }, openExternal: vi.fn(), destination: async () => 'embedded', byDefault: () => true,
    secret: async (threadId, ref) => secrets.take(threadId, ref) })
})
afterAll(async () => {
  browser.dispose()
  secrets.close()
  await tools.close()
  vi.restoreAllMocks()
  await rm(userData, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

/** Calls request_secret as the agent would, answers the card as the window would, and returns the tool's reply. */
async function requestAndAnswer(args: Record<string, unknown>, values: Record<string, string> | 'decline'): Promise<Record<string, unknown>> {
  const call = tools.call(THREAD, 'request_secret', args)
  await vi.waitFor(() => expect(secrets.requests().get(THREAD)?.length).toBe(1))
  const requestId = secrets.requests().get(THREAD)![0]!.id
  expect(await answer(values === 'decline' ? { answer: 'decline', threadId: THREAD, requestId } : { answer: 'save', threadId: THREAD, requestId, values })).toEqual({ ok: true })
  const result = await call
  record(result)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
}
const agent = () => createBrowserAgentServer(() => browser)
async function browserCall(name: string, args: Record<string, unknown>) {
  const result = await agent().call(THREAD, name, args)
  record(result)
  return result
}

describe('a secret request\'s value, sent through every way it is delivered', () => {
  it('is typed by Sotto\'s browser from a one-use reference, and the agent reads back only a mask', async () => {
    const reply = await requestAndAnswer({ label: 'Staging password', reason: 'To sign in to staging.' }, { value: CANARY })
    expect(reply.status).toBe('saved')
    const secretRef = reply.secretRef as string
    const opened = await browserCall('browser_open', { url: 'http://127.0.0.1:5173/login', description: 'Sign in to staging' })
    expect(opened.isError).toBeFalsy()
    const { task } = JSON.parse((opened.content[0] as { text: string }).text) as { task: { id: string; pageId: string } }
    const typed = await browserCall('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'type', secretRef } })
    expect(typed.isError).toBeFalsy()
    // The page, and only the page, has it.
    expect(page.typed).toBe(CANARY)
    const inspected = await browserCall('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'inspect' } })
    expect((inspected.content[0] as { text: string }).text).toContain('••••••••')
    await browserCall('browser_status', {})
    // It was one use: the same reference types nothing again.
    const again = await browserCall('browser_action', { pageId: task.pageId, taskId: task.id, action: { type: 'type', secretRef } })
    expect(again.isError).toBe(true)
    expect(page.typed).toBe(CANARY)
    expect(events.some(event => event.type === 'task' && event.task.steps.some(step => step.detail.includes('secret you saved')))).toBe(true)
  })

  it('is written to an owner-only file a command reads, and deleted when let go', async () => {
    const reply = await requestAndAnswer({ label: 'Sudo password', reason: 'To install the driver.', delivery: 'file' }, { value: CANARY })
    const file = reply.file as string
    expect(await readFile(file, 'utf8')).toBe(CANARY)
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    record(await tools.call(THREAD, 'release_secret', { files: [file] }))
    await vi.waitFor(() => expect(existsSync(file)).toBe(false))
  })

  it('goes by name from a card with several values', async () => {
    const reply = await requestAndAnswer({ label: 'Database', reason: 'To migrate.', fields: [{ name: 'user', label: 'User', secret: false }, { name: 'password', label: 'Password' }] },
      { user: 'admin', password: CANARY })
    const refs = reply.secretRefs as Record<string, string>
    expect(secrets.take(THREAD, refs.password!)).toBe(CANARY)
    const files = await requestAndAnswer({ label: 'Keys', reason: 'For the deploy script.', delivery: 'file', fields: [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }] },
      { a: CANARY, b: CANARY })
    const paths = Object.values(files.files as Record<string, string>)
    for (const path of paths) expect(await readFile(path, 'utf8')).toBe(CANARY)
    record(await tools.call(THREAD, 'release_secret', { files: paths }))
  })

  it('goes nowhere when declined, and a phone cannot approve it', async () => {
    const call = tools.call(THREAD, 'request_secret', { label: 'Token', reason: 'For the API.' })
    await vi.waitFor(() => expect(secrets.requests().get(THREAD)?.length).toBe(1))
    const requestId = secrets.requests().get(THREAD)![0]!.id
    expect(() => secrets.answer(THREAD, requestId, true)).toThrow()
    secrets.answer(THREAD, requestId, false)
    const result = await call
    record(result)
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ status: 'declined' })
  })

  it('appears in none of it, nor in any file in Sotto\'s folder once the files are let go', async () => {
    secrets.close()
    for (const text of seen) expect(text).not.toContain(CANARY)
    // JSON escapes nothing in the canary, but a base64 form would hide it from a plain search.
    const encoded = Buffer.from(CANARY).toString('base64')
    for (const text of seen) expect(text).not.toContain(encoded)
    const walk = async (folder: string): Promise<string[]> => (await Promise.all((await readdir(folder, { withFileTypes: true }))
      .map(entry => entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)]))).flat()
    // Closing lets go of every secret file; they are removed as it returns, so the folder is read once they are gone.
    await vi.waitFor(async () => expect(await readdir(join(userData, 'secret-files')).catch(() => [])).toEqual([]))
    for (const file of await walk(userData)) expect(await readFile(file, 'utf8')).not.toContain(CANARY)
    expect(seen.length).toBeGreaterThan(10)
  })
})
