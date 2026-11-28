// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The page that makes a recording (ADR-0220), over a stand-in for Electron: one in-memory partition serves every
 * recording, and closing one before its page loaded leaves no promise unanswered.
 */
const electron = vi.hoisted(() => {
  const partition = {
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  }
  const windows: { load: { resolve: () => void; reject: (error: Error) => void }; destroyed: boolean; options: { webPreferences: { session: unknown } } }[] = []
  class FakeWindow {
    destroyed = false
    readonly webContents = { executeJavaScript: vi.fn(async () => 0) }
    private readonly entry: (typeof windows)[number]
    constructor(readonly options: { webPreferences: { session: unknown } }) {
      this.entry = { load: { resolve: () => undefined, reject: () => undefined }, destroyed: false, options }
      windows.push(this.entry)
    }
    loadURL(): Promise<void> { return new Promise((resolve, reject) => { this.entry.load = { resolve, reject } }) }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void {
      this.destroyed = true; this.entry.destroyed = true
      // As Electron does: a page still loading when its window goes fails its load.
      this.entry.load.reject(Object.assign(new Error('ERR_ABORTED (-3) loading data:text/html'), { code: 'ERR_ABORTED' }))
    }
  }
  return { partition, windows, fromPartition: vi.fn(() => partition), FakeWindow }
})
vi.mock('electron', () => ({ BrowserWindow: electron.FakeWindow, session: { fromPartition: electron.fromPartition } }))

const { PageRecording } = await import('../../../src/main/tools/pageRecorder')

afterEach(() => { electron.windows.length = 0 })

describe('the page that makes a recording', () => {
  it('makes one in-memory partition for every recording, refusing permissions and loading only data: addresses', () => {
    const first = new PageRecording(() => undefined)
    const second = new PageRecording(() => undefined)
    try {
      expect(electron.fromPartition).toHaveBeenCalledTimes(1)
      const [name] = electron.fromPartition.mock.calls[0] as unknown as [string]
      expect(name).not.toMatch(/^persist:/u)
      expect(electron.windows.map(window => window.options.webPreferences.session)).toEqual([electron.partition, electron.partition])
      expect(electron.partition.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
      expect(electron.partition.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)

      const refuse = electron.partition.setPermissionRequestHandler.mock.calls[0]![0] as (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void
      const answered = vi.fn()
      refuse({}, 'media', answered)
      expect(answered).toHaveBeenCalledWith(false)
      const filter = electron.partition.webRequest.onBeforeRequest.mock.calls[0]![0] as (details: { url: string }, callback: (answer: { cancel: boolean }) => void) => void
      const decided = vi.fn()
      filter({ url: 'data:text/html;base64,PHA+' }, decided)
      filter({ url: 'https://example.com/' }, decided)
      expect(decided.mock.calls).toEqual([[{ cancel: false }], [{ cancel: true }]])
    } finally { first.close(); second.close() }
  })

  it('leaves no unhandled rejection when it is closed before its page loads', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const recording = new PageRecording(() => undefined)
      recording.close()
      expect(electron.windows[0]!.destroyed).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
})
