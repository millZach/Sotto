// @vitest-environment node
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_MAX_FRAME_BYTES, ClaudeProtocol, ClaudeRejected, type ClaudeFrame } from '../../../src/main/agents/claudeProtocol'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: ReturnType<typeof vi.fn> }

/** A child whose stdout is a real stream, so `setEncoding('utf8')` decodes the bytes the test writes. */
function start(timeout = 5000) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) }) as FakeChild
  vi.mocked(spawn).mockReturnValueOnce(child as never)
  const frames: ClaudeFrame[] = []
  const onExit = vi.fn()
  const protocol = new ClaudeProtocol('claude', [], '.', {}, timeout, frame => { frames.push(frame) }, onExit)
  const written: ClaudeFrame[] = []
  let pending = ''
  child.stdin.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) { written.push(JSON.parse(pending.slice(0, newline)) as ClaudeFrame); pending = pending.slice(newline + 1) }
  })
  const send = async (...chunks: (string | Buffer)[]) => {
    for (const chunk of chunks) child.stdout.write(chunk)
    await new Promise(resolve => setImmediate(resolve))
  }
  return { child, protocol, frames, written, onExit, send }
}

function split(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size))
  return chunks
}

afterEach(() => { vi.mocked(spawn).mockReset() })

describe('ClaudeProtocol framing', () => {
  it('joins one frame split across many chunks, including inside a multi-byte character', async () => {
    const { frames, child, send } = start()
    const text = `${'é'.repeat(3000)} 画像 🎨 ${'x'.repeat(5000)}`
    const bytes = Buffer.from(`${JSON.stringify({ type: 'user', text })}\n`, 'utf8')
    // Odd sizes land boundaries inside two-, three- and four-byte sequences.
    const chunks = split(bytes, 7)
    expect(chunks.some(chunk => (chunk[0]! & 0xc0) === 0x80)).toBe(true)
    await send(...chunks)
    expect(frames).toEqual([{ type: 'user', text }])
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('splits a frame at a boundary that falls between its bytes and its newline', async () => {
    const { frames, send } = start()
    await send('{"type":"a"', '}', '\n{"type"', ':"b"}\n')
    expect(frames).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('delivers several frames from one chunk in order and skips blank lines', async () => {
    const { frames, send } = start()
    await send('{"type":"a"}\n\n   \n{"type":"b"}\n{"type":"c"}\n{"type":"d"')
    expect(frames.map(frame => frame.type)).toEqual(['a', 'b', 'c'])
    await send('}\n')
    expect(frames.map(frame => frame.type)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('aborts an oversized frame before it is parsed', async () => {
    const { frames, child, protocol, send } = start()
    const pending = protocol.control({ subtype: 'initialize' }).then(() => 'resolved', (error: Error) => error.message)
    const piece = 'a'.repeat(1024 * 1024)
    const chunks = ['{"type":"user","data":"']
    for (let size = chunks[0]!.length; size <= CLAUDE_MAX_FRAME_BYTES; size += piece.length) chunks.push(piece)
    // The newline arrives in the chunk that crosses the limit, so the frame is complete but never parsed.
    chunks[chunks.length - 1] += '"}\n'
    await send(...chunks)
    expect(frames).toEqual([])
    expect(child.kill).toHaveBeenCalled()
    await expect(pending).resolves.toBe('Claude disconnected before acknowledging the request.')
    await send('{"type":"after"}\n')
    expect(frames).toEqual([])
  })

  it('counts the limit in bytes, not characters', async () => {
    const { frames, child, send } = start()
    // Two bytes per character: under the limit by length, over it by bytes.
    const data = 'é'.repeat(Math.ceil(CLAUDE_MAX_FRAME_BYTES / 2) + 1)
    const line = `{"type":"user","data":"${data}"}\n`
    expect(line.length).toBeLessThan(CLAUDE_MAX_FRAME_BYTES)
    await send(...split(Buffer.from(line, 'utf8'), 1024 * 1024))
    expect(frames).toEqual([])
    expect(child.kill).toHaveBeenCalled()
  })

  it('accepts a frame just under the limit', async () => {
    const { frames, child, send } = start()
    const prefix = '{"type":"user","data":"'
    const data = 'a'.repeat(CLAUDE_MAX_FRAME_BYTES - prefix.length - 3)
    const bytes = Buffer.from(`${prefix}${data}"}\n`)
    expect(bytes.length).toBe(CLAUDE_MAX_FRAME_BYTES)
    await send(...split(bytes, 64 * 1024))
    expect(child.kill).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    expect((frames[0]!.data as string).length).toBe(data.length)
  })

  it('aborts on malformed JSON and on a line that is not an object', async () => {
    const malformed = start()
    await malformed.send('{"type":"a"}\n{not json\n')
    expect(malformed.frames).toEqual([{ type: 'a' }])
    expect(malformed.child.kill).toHaveBeenCalledTimes(1)

    const scalar = start()
    await scalar.send('null\n')
    expect(scalar.frames).toEqual([])
    expect(scalar.child.kill).toHaveBeenCalledTimes(1)
  })
})

describe('ClaudeProtocol control requests', () => {
  it('resolves waiters by request id and rejects a refused request', async () => {
    const { protocol, written, frames, send } = start()
    const first = protocol.control({ subtype: 'initialize' })
    const second = protocol.control({ subtype: 'set_model', model: 'opus' })
    const third = protocol.control({ subtype: 'interrupt' }).then(() => 'resolved', (error: Error) => error.message)
    await send()
    expect(written.map(frame => (frame.request as ClaudeFrame).subtype)).toEqual(['initialize', 'set_model', 'interrupt'])
    const [a, b, c] = written.map(frame => frame.request_id as string)
    const response = (id: string, body: ClaudeFrame) => `${JSON.stringify({ type: 'control_response', response: { request_id: id, ...body } })}\n`
    const order: string[] = []
    void first.then(() => order.push('first')); void second.then(() => order.push('second'))
    await send(response(a!, { subtype: 'success', response: { ok: 1 } }) + response(b!, { subtype: 'success', response: { ok: 2 } }) + response(c!, { subtype: 'error', error: 'no' }))
    await expect(first).resolves.toEqual({ ok: 1 })
    await expect(second).resolves.toEqual({ ok: 2 })
    await expect(third).resolves.toBe('Claude rejected a control request. Check the native client.')
    expect(order).toEqual(['first', 'second'])
    // Every control response is still a frame for the adapter.
    expect(frames.map(frame => frame.type)).toEqual(['control_response', 'control_response', 'control_response'])
  })

  it('reads a success with no body as empty, and tells a refusal from an answer it cannot read', async () => {
    const { protocol, written, send } = start()
    const bodiless = protocol.control({ subtype: 'set_model', model: 'opus' })
    const refused = protocol.control({ subtype: 'set_permission_mode', mode: 'bypassPermissions' }).catch((error: Error) => error)
    const unreadable = protocol.control({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }).catch((error: Error) => error)
    await send()
    const [a, b, c] = written.map(frame => frame.request_id as string)
    const response = (id: string, body: ClaudeFrame) => `${JSON.stringify({ type: 'control_response', response: { request_id: id, ...body } })}
`
    await send(response(a!, { subtype: 'success' }) + response(b!, { subtype: 'error', error: 'no' }) + response(c!, { subtype: 'success', response: 'text' }))
    await expect(bodiless).resolves.toEqual({})
    // A refusal is certain: the CLI heard the request and did not do it, so a caller may try another way.
    expect(await refused).toBeInstanceOf(ClaudeRejected)
    // An answer Sotto cannot read leaves the request's outcome unknown, which is not a refusal.
    expect(await unreadable).not.toBeInstanceOf(ClaudeRejected)
    expect((await unreadable as Error).message).toBe('Claude answered a control request in a form Sotto could not read.')
  })

  it('rejects every waiter when the process closes, and refuses new writes', async () => {
    const { protocol, child, onExit } = start()
    const first = protocol.control({ subtype: 'initialize' })
    const second = protocol.control({ subtype: 'interrupt' })
    child.emit('close', 0)
    await expect(first).rejects.toThrow('Claude disconnected before acknowledging the request.')
    await expect(second).rejects.toThrow('Claude disconnected before acknowledging the request.')
    await expect(protocol.write({ type: 'user' })).rejects.toThrow('Claude is disconnected.')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('does not report an exit it asked for', async () => {
    const { protocol, child, onExit } = start()
    protocol.stop()
    await expect(protocol.write({ type: 'user' })).rejects.toThrow('Claude is disconnected.')
    child.emit('close', 0)
    await protocol.closed
    expect(onExit).not.toHaveBeenCalled()
  })
})
