// @vitest-environment node
/**
 * Phase 2 out-of-process desktop engine transport, authentication, crash recovery and
 * separate engine performance recording (ADR-0210, ADR-0098).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  connectEngineClient,
  createEngineEndpoint,
  decodeRpcValue,
  encodeRpcValue,
  encodeEngineFrame,
  EngineFrameDecoder,
  generateEngineToken,
  listenEngineServer,
  verifyEngineToken,
  type EngineWireMessage,
} from '../../../../src/main/engine/transport'
import { MainActivityService } from '../../../../src/main/performance/mainActivityService'
import type { ProfilerTarget, RawCpuProfile } from '../../../../src/main/performance/activityRecorder'

describe('EngineFrameDecoder and auth tokens (ADR-0210)', () => {
  it('reconstructs frames split across arbitrary byte boundaries and coalesced chunks', () => {
    const decoder = new EngineFrameDecoder()
    const first: EngineWireMessage = { kind: 'push', event: 'a', payload: { n: 1 } }
    const second: EngineWireMessage = { kind: 'req', id: 7, method: 'ping', args: ['hi'] }
    const wire = Buffer.concat([encodeEngineFrame(first), encodeEngineFrame(second)])
    const received: EngineWireMessage[] = []

    // Feed 1 byte at a time across the 4-byte length headers and bodies.
    for (let i = 0; i < wire.length; i++) {
      decoder.push(wire.subarray(i, i + 1), msg => received.push(msg))
    }
    expect(received).toEqual([first, second])
  })

  it('verifies tokens in constant time and rejects mismatches', () => {
    const token = generateEngineToken()
    expect(token).toHaveLength(64)
    expect(verifyEngineToken(token, token)).toBe(true)
    expect(verifyEngineToken(token, `${token.slice(0, 63)}0` === token ? `${token.slice(0, 63)}1` : `${token.slice(0, 63)}0`)).toBe(false)
    expect(verifyEngineToken(token, 'short')).toBe(false)
    expect(verifyEngineToken(token, 12345)).toBe(false)
    expect(verifyEngineToken('', '')).toBe(false)
  })
})

describe('encodeRpcValue and decodeRpcValue (ADR-0210)', () => {
  it('round-trips Uint8Array and Buffer values nested inside the args array through JSON', () => {
    const png = new Uint8Array([137, 80, 78, 71])
    const stage = { threadId: 't', name: 'a.png', mimeType: 'image/png', bytes: png }
    const args = ['agent:attachmentStage', 'window', [stage, { list: [Buffer.from([4, 5])] }]]
    const wire = JSON.parse(JSON.stringify(encodeRpcValue(args))) as unknown
    const decoded = decodeRpcValue(wire) as [string, string, [{ bytes: Uint8Array; name: string }, { list: Uint8Array[] }]]
    expect(decoded[2][0].name).toBe('a.png')
    expect(decoded[2][0].bytes).toBeInstanceOf(Uint8Array)
    expect([...decoded[2][0].bytes]).toEqual([137, 80, 78, 71])
    expect(decoded[2][1].list[0]).toBeInstanceOf(Uint8Array)
    expect([...decoded[2][1].list[0]!]).toEqual([4, 5])
    // Encoding never changes the caller's own arguments.
    expect(stage.bytes).toBe(png)
  })

  it('returns values with no binary inside unchanged and by reference', () => {
    const state = { threads: [{ id: 'a', title: 'x', when: new Date(0) }], count: 1, none: null }
    expect(encodeRpcValue(state)).toBe(state)
    expect(decodeRpcValue(state)).toBe(state)
  })
})

describe('EngineTransport server/client over OS named pipe or UDS (ADR-0210)', () => {
  it('rejects unauthenticated peers and supports bidirectional RPC, binary values and pushes', async () => {
    const endpoint = createEngineEndpoint('sotto-eng-test')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)

    try {
      // Unauthorized client with wrong token must be disconnected immediately.
      const rogueClosed = new Promise<void>(resolve => {
        const rogue = createConnection(endpoint, () => {
          rogue.write(encodeEngineFrame({ kind: 'hello', token: 'wrong-token' }))
        })
        rogue.once('close', () => resolve())
        rogue.once('error', () => resolve())
      })
      await rogueClosed

      const [serverConn, clientConn] = await Promise.all([
        server.waitForClient(5_000),
        connectEngineClient(endpoint, token),
      ])

      const pushes: Array<{ event: string; payload: unknown }> = []
      serverConn.onPush((event, payload) => {
        if (event === 'shell:throw') throw new Error('bad push listener')
        pushes.push({ event, payload })
      })
      clientConn.onRequest(async (method, args) => {
        if (method === 'echoBin') return new Uint8Array([1, 2, 3, 4])
        if (method === 'engine:invokeIpc') {
          const [channel, role, ipcArgs] = args as [string, string, unknown[]]
          const payload = ipcArgs[0] as { threadId: string; name: string; mimeType: string; bytes: Uint8Array }
          if (!(payload.bytes instanceof Uint8Array)) throw new Error('NESTED_BYTES_NOT_UINT8ARRAY')
          return { channel, role, mimeType: payload.mimeType, bytes: new Uint8Array([...payload.bytes, 99]) }
        }
        if (method === 'fail') throw Object.assign(new Error('boom'), { code: 'E_BOOM' })
        if (method === 'reverse') return await clientConn.request('shell:greet', [args[0]])
        throw new Error(`unexpected ${method}`)
      })
      serverConn.onRequest((method, args) => {
        if (method === 'shell:greet') return `hello ${String(args[0])}`
        throw new Error(`unexpected ${method}`)
      })

      // Bidirectional reverse-RPC (shell -> engine -> shell -> engine -> shell).
      await expect(serverConn.request('reverse', ['sotto'])).resolves.toBe('hello sotto')

      // Top-level Uint8Array binary preservation.
      const bin = await serverConn.request<Uint8Array>('echoBin')
      expect(bin).toBeInstanceOf(Uint8Array)
      expect([...bin]).toEqual([1, 2, 3, 4])

      // Nested Uint8Array preservation inside engine:invokeIpc args and return object (ADR-0031 attachment staging).
      const nestedInput = { threadId: 't1', name: 'shot.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }
      const nestedResult = await serverConn.request<{ channel: string; role: string; mimeType: string; bytes: Uint8Array }>(
        'engine:invokeIpc',
        ['agent:attachment-stage', 'main', [nestedInput]],
      )
      expect(nestedResult.channel).toBe('agent:attachment-stage')
      expect(nestedResult.mimeType).toBe('image/png')
      expect(nestedResult.bytes).toBeInstanceOf(Uint8Array)
      expect([...nestedResult.bytes]).toEqual([137, 80, 78, 71, 99])

      // Error serialization preserves message and code.
      await expect(serverConn.request('fail')).rejects.toMatchObject({ message: 'boom', code: 'E_BOOM' })

      // Push delivery, including verifying a throwing push handler does not tear down the link (L2).
      clientConn.sendPush('shell:throw', { bad: true })
      clientConn.sendPush('shell:sendToMain', { channel: 'agent:state', payload: { rev: 9 } })
      await vi.waitFor(() => {
        expect(pushes).toEqual([{ event: 'shell:sendToMain', payload: { channel: 'agent:state', payload: { rev: 9 } } }])
      })
      await expect(serverConn.request('reverse', ['still-alive'])).resolves.toBe('hello still-alive')

      // Closing the client rejects in-flight requests cleanly.
      const hanging = serverConn.request('hang-never-answered')
      clientConn.close()
      await expect(hanging).rejects.toThrow(/stopped|unavailable/i)
    } finally {
      await server.close()
    }
  })
})

describe('MainActivityService separate engine recording (ADR-0098, ADR-0210)', () => {
  it('saves engine.cpuprofile alongside main.cpuprofile and records engine loop stats in summary.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sotto-engine-perf-'))
    const rawProfile = (name: string): RawCpuProfile => ({
      nodes: [{ id: 1, callFrame: { functionName: name, scriptId: '1', url: 'node:internal', lineNumber: 1, columnNumber: 1 }, hitCount: 3, children: [] }],
      startTime: 1000, endTime: 2000, samples: [1], timeDeltas: [1000],
    })
    const makeProfiler = (name: string): ProfilerTarget => ({
      start: async () => undefined,
      stop: async () => rawProfile(name),
      cancel: async () => undefined,
    })

    let timerCb: (() => void) | undefined
    let readingCount = 0
    const service = new MainActivityService({
      directory: dir,
      clock: { now: () => 1000, setInterval: () => ({}), clearInterval: () => undefined },
      wallClock: () => Date.UTC(2026, 10, 20, 12, 0, 0),
      durationMs: 1000,
      mainProfiler: () => makeProfiler('mainLoop'),
      engineProfiler: () => makeProfiler('engineCoordinator'),
      engineLoopReading: async () => {
        readingCount += 1
        return { blockedShare: readingCount === 1 ? 0.02 : 0.14, longestFreezeMs: 12, freezesOver100ms: 0, bars: [1, 2] }
      },
      appRoots: [process.cwd()],
      sottoVersion: '0.1.43-owl.20261120.1',
      platform: process.platform,
      revealFile: () => undefined,
      log: () => undefined,
      setTimeout: cb => { timerCb = cb; return 1 },
      clearTimeout: () => undefined,
    })

    try {
      service.start()
      await service.command({ type: 'record' }, () => makeProfiler('windowPaint'))
      expect(timerCb).toBeDefined()
      timerCb!()
      await service.settled()

      const state = service.state()
      expect(state.recording.phase).toBe('saved')
      if (state.recording.phase !== 'saved') throw new Error('expected saved')
      expect(state.recording.files).toEqual(['main.cpuprofile', 'window.cpuprofile', 'engine.cpuprofile', 'summary.json'])

      const summary = JSON.parse(await readFile(join(state.recording.folder, 'summary.json'), 'utf8')) as Record<string, unknown>
      expect(summary['engineRecorded']).toBe(true)
      expect(summary['engineBefore']).toMatchObject({ blockedShare: 0.02 })
      expect(summary['engineDuring']).toMatchObject({ blockedShare: 0.14 })
    } finally {
      service.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
