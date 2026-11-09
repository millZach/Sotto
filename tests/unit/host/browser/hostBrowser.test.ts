// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevToolsPipe } from '../../../../src/host/browser/devToolsPipe'
import { HostBrowser, HostBrowserPage, pageTitle } from '../../../../src/host/browser/hostBrowser'

/** A browser that exits before it answers anything. */
function exitingBrowser(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdio: unknown[]; exitCode: number | null; signalCode: null; killed: boolean; kill(): boolean }
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough()
  child.stdio = [null, null, null, toBrowser, fromBrowser]
  child.exitCode = null; child.signalCode = null; child.killed = false
  child.kill = () => true
  setTimeout(() => { child.exitCode = 1; fromBrowser.end(); child.emit('exit', 1, null) }, 10)
  return child as unknown as ChildProcess
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-host-browser-unit-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('a host browser that fails to start (ADR-0198)', () => {
  it('fails the open, deletes its profile and can be closed, rather than waiting on itself', async () => {
    const browser = new HostBrowser({ find: async () => '/usr/bin/chromium', profileRoot: root, spawn: () => exitingBrowser() })
    await expect(browser.open('workspace')).rejects.toThrow('The browser has closed.')
    expect(await readdir(root)).toEqual([])
    await expect(browser.close()).resolves.toBeUndefined()
    expect(await browser.pages()).toEqual([])
  })
})

describe('a page title as the pane shows it', () => {
  it('drops Chromium\'s stand-in, the address without its scheme, and strips controls and bidi marks', () => {
    expect(pageTitle('127.0.0.1:5173/a', 'http://127.0.0.1:5173/a')).toBe('')
    expect(pageTitle('http://127.0.0.1:5173/a', 'http://127.0.0.1:5173/a')).toBe('')
    expect(pageTitle('Sign‮ in\u0007', 'http://127.0.0.1:5173/a')).toBe('Sign in')
    expect(pageTitle('x'.repeat(600), 'https://example.com/')).toHaveLength(512)
  })
})

describe('a page\'s picture stream', () => {
  it('ends stopped when every pane stops watching in a burst, however slowly the browser answers', async () => {
    const toBrowser = new PassThrough(), fromBrowser = new PassThrough()
    const pipe = new DevToolsPipe(toBrowser, fromBrowser)
    const sent: string[] = []
    let buffered = ''
    toBrowser.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const messages = buffered.split('\0'); buffered = messages.pop()!
      for (const text of messages) {
        const message = JSON.parse(text) as { id: number; method: string }
        sent.push(message.method)
        // Each answer comes later than the one before, so a change could finish after the next one starts.
        setTimeout(() => fromBrowser.write(JSON.stringify({ id: message.id, result: {} }) + '\0'), 5 * (10 - sent.length))
      }
    })
    const page = new HostBrowserPage(pipe, 'target', 'session', 'workspace', () => undefined)
    const first = page.watch({ width: 400, height: 300 }, () => undefined)
    await new Promise(resolve => setTimeout(resolve, 1))
    const second = page.watch({ width: 900, height: 700 }, () => undefined)
    first(); second()
    await new Promise(resolve => setTimeout(resolve, 200))
    const stream = sent.filter(method => method === 'Page.startScreencast' || method === 'Page.stopScreencast')
    expect(stream[0]).toBe('Page.startScreencast')
    expect(stream.at(-1)).toBe('Page.stopScreencast')
    pipe.close()
  })
})
