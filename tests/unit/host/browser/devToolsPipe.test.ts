// @vitest-environment node
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { DEVTOOLS_MESSAGE_LIMIT, DevToolsError, DevToolsPipe } from '../../../../src/host/browser/devToolsPipe'

/** A pipe pair, with what the browser read so far as parsed messages. */
function connect() {
  const toBrowser = new PassThrough(), fromBrowser = new PassThrough()
  const pipe = new DevToolsPipe(toBrowser, fromBrowser)
  let read = ''
  toBrowser.on('data', (chunk: Buffer) => { read += chunk.toString('utf8') })
  const sent = () => read.split('\0').filter(Boolean).map(text => JSON.parse(text) as { id: number; method: string; params: unknown; sessionId?: string })
  const answer = (message: unknown) => fromBrowser.write(JSON.stringify(message) + '\0')
  return { pipe, fromBrowser, sent, answer }
}

describe('the DevTools pipe (ADR-0198)', () => {
  it('sends NUL-ended commands and matches each answer to its command', async () => {
    const { pipe, sent, answer } = connect()
    const first = pipe.send('Target.createTarget', { url: 'about:blank' })
    const second = pipe.send('Page.enable', {}, 'session-1')
    await new Promise(resolve => setImmediate(resolve))
    expect(sent()).toEqual([{ id: 1, method: 'Target.createTarget', params: { url: 'about:blank' } }, { id: 2, method: 'Page.enable', params: {}, sessionId: 'session-1' }])
    answer({ id: 2, result: {} })
    answer({ id: 1, result: { targetId: 'target-1' } })
    await expect(first).resolves.toEqual({ targetId: 'target-1' })
    await expect(second).resolves.toEqual({})
  })

  it('reads a message split across chunks, and several in one chunk', async () => {
    const { pipe, fromBrowser } = connect()
    const events: [string, unknown, string | undefined][] = []
    pipe.on((method, params, sessionId) => events.push([method, params, sessionId]))
    const whole = JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 's' }) + '\0'
    fromBrowser.write(whole.slice(0, 10)); fromBrowser.write(whole.slice(10))
    fromBrowser.write(JSON.stringify({ method: 'A', params: {} }) + '\0' + JSON.stringify({ method: 'B' }) + '\0')
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual([['Page.loadEventFired', { timestamp: 1 }, 's'], ['A', {}, undefined], ['B', {}, undefined]])
  })

  it('fails a refused command in the protocol\'s words', async () => {
    const { pipe, answer } = connect()
    const refused = pipe.send('Page.navigate', { url: 'x' })
    answer({ id: 1, error: { code: -32000, message: 'Cannot navigate to invalid URL' } })
    await expect(refused).rejects.toMatchObject({ method: 'Page.navigate', code: -32000, message: 'Cannot navigate to invalid URL' })
    await expect(refused).rejects.toBeInstanceOf(DevToolsError)
  })

  it('fails every waiting command when the browser goes, and says so to whoever asked', async () => {
    const { pipe, fromBrowser } = connect()
    let closed = 0
    pipe.onClose(() => closed++)
    const waiting = pipe.send('Page.reload')
    fromBrowser.end()
    await expect(waiting).rejects.toThrow('The browser has closed.')
    expect(pipe.closed).toBe(true)
    expect(closed).toBe(1)
    await expect(pipe.send('Page.reload')).rejects.toThrow('The browser has closed.')
  })

  it('closes rather than buffering without end, and on a message that is not JSON', async () => {
    const big = connect()
    big.fromBrowser.write(Buffer.alloc(DEVTOOLS_MESSAGE_LIMIT + 1, 'a'))
    await new Promise(resolve => setImmediate(resolve))
    expect(big.pipe.closed).toBe(true)
    const garbled = connect()
    garbled.fromBrowser.write('not json\0')
    await new Promise(resolve => setImmediate(resolve))
    expect(garbled.pipe.closed).toBe(true)
  })
})
