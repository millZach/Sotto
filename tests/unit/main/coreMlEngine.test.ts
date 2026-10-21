import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { coreMlHelperAvailable, createCoreMlEngineLoader, requestDeadlineMs } from '../../../src/main/asr/coreMlEngine'
import { MAX_TRANSCRIPTION_SAMPLES } from '../../../src/shared/audio'

const fixture = resolve('tests/fixtures/fakeCoreMlHelper.mjs')
const children: ChildProcess[] = []

/** Runs the fake helper under Node; the "model directory" argument picks its mode. */
const spawnFn = ((_command: string, args: readonly string[], options: object) => {
  const child = spawn(process.execPath, [fixture, ...args], options)
  children.push(child)
  return child
}) as unknown as typeof spawn

const load = (mode: string, loadTimeoutMs?: number) => createCoreMlEngineLoader('/helper', 'ultra', { spawnFn, ...(loadTimeoutMs === undefined ? {} : { loadTimeoutMs }) })(mode)

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
})

describe('Core ML engine', () => {
  it('loads once the helper is ready and answers requests in order', async () => {
    const engine = await load('ready')
    const [first, second] = await Promise.all([engine.transcribe(new Float32Array([0.5, 0, 0])), engine.transcribe(new Float32Array([-0.25, 0, 0, 0, 0]))])
    expect(first).toBe('heard 3 samples from 0.5 to 0')
    expect(second).toBe('heard 5 samples from -0.25 to 0')
    engine.dispose?.()
  })

  it('sends a recording longer than a minute whole, up to the longest one, and refuses only what is longer', async () => {
    const engine = await load('ready')
    // Two minutes, past protocol 1's 960,000-sample limit: every sample reaches the helper.
    const twoMinutes = new Float32Array(16_000 * 120)
    twoMinutes[0] = 0.5
    twoMinutes[twoMinutes.length - 1] = -0.25
    await expect(engine.transcribe(twoMinutes)).resolves.toBe('heard 1920000 samples from 0.5 to -0.25')
    const longest = new Float32Array(MAX_TRANSCRIPTION_SAMPLES)
    longest[longest.length - 1] = 0.75
    await expect(engine.transcribe(longest)).resolves.toBe(`heard ${MAX_TRANSCRIPTION_SAMPLES} samples from 0 to 0.75`)
    // Longer than any recording: refused before the helper sees it, and the engine keeps working.
    await expect(engine.transcribe(new Float32Array(MAX_TRANSCRIPTION_SAMPLES + 1))).rejects.toThrow('longer than the longest recording')
    await expect(engine.transcribe(new Float32Array([0.5]))).resolves.toBe('heard 1 samples from 0.5 to 0.5')
    engine.dispose?.()
  })

  it('refuses a helper from an earlier build, which would refuse long recordings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(load('protocol-1')).rejects.toThrow('speaks protocol 1, not 2; rebuild it')
    expect(warn).toHaveBeenCalledWith('coreml-helper-outdated', { protocol: 1, expected: 2, rebuild: 'node scripts/build-coreml-asr.mjs' })
    warn.mockRestore()
  })

  it('gives a request 20 seconds plus twice its audio, and never more than two minutes', () => {
    expect(requestDeadlineMs(16_000 * 6)).toBe(32_000)
    expect(requestDeadlineMs(16_000 * 50)).toBe(120_000)
    expect(requestDeadlineMs(MAX_TRANSCRIPTION_SAMPLES)).toBe(120_000)
  })

  it('rejects the load when the helper cannot load the model', async () => {
    await expect(load('load-fail')).rejects.toThrow('could not load')
  })

  it('rejects pending and later requests once the helper crashes', async () => {
    const engine = await load('crash-after-ready')
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
  })

  it('says the engine stopped when the helper crashes by itself, not when it is disposed', async () => {
    const crashed = await load('crash-after-ready')
    const stopped = vi.fn()
    crashed.onStopped?.(stopped)
    await expect(crashed.transcribe(new Float32Array(4))).rejects.toThrow('stopped')
    expect(stopped).toHaveBeenCalledOnce()

    const disposed = await load('ready')
    const notStopped = vi.fn()
    disposed.onStopped?.(notStopped)
    disposed.dispose?.()
    expect(notStopped).not.toHaveBeenCalled()
  })

  it('stops a helper that never answers a request, so the queue behind it drains', async () => {
    const engine = await createCoreMlEngineLoader('/helper', 'ultra', { spawnFn, requestTimeoutMs: () => 200 })('hang')
    const child = children.at(-1)!
    const stopped = vi.fn()
    engine.onStopped?.(stopped)
    await expect(engine.transcribe(new Float32Array(4))).rejects.toThrow('stopped answering')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    expect(child.signalCode).toBe('SIGTERM')
    expect(stopped).toHaveBeenCalledOnce()
  })

  it('ends the helper on dispose and refuses later requests', async () => {
    const engine = await load('ready')
    const child = children.at(-1)!
    const exited = once(child, 'exit')
    engine.dispose?.()
    const [code] = await exited
    expect(code).toBe(0)
    await expect(engine.transcribe(new Float32Array(1))).rejects.toThrow('disposed')
  })

  it('gives up and kills the helper when it never becomes ready', async () => {
    await expect(load('never-ready', 200)).rejects.toThrow('did not load in time')
    const child = children.at(-1)!
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    expect(child.signalCode).toBe('SIGTERM')
  })

  it('is available only on Apple silicon Macs with the helper present', () => {
    expect(coreMlHelperAvailable(fixture, 'darwin', 'arm64')).toBe(true)
    expect(coreMlHelperAvailable(fixture, 'darwin', 'x64')).toBe(false)
    expect(coreMlHelperAvailable(fixture, 'linux', 'arm64')).toBe(false)
    expect(coreMlHelperAvailable('/no/such/helper', 'darwin', 'arm64')).toBe(false)
  })
})

describe('the longest request', () => {
  // One limit, written in three places: Sotto's longest recording, the helper's and the stand-in's.
  it('is the same in main, the Core ML helper and its test stand-in', () => {
    const helper = readFileSync(resolve('native/coreml-asr/Sources/sotto-coreml-asr/main.swift'), 'utf8')
    const [, perSecond, seconds] = /let maxSampleCount: UInt32 = ([\d_]+) \* ([\d_]+)/u.exec(helper) ?? []
    expect(Number(perSecond?.replaceAll('_', '')) * Number(seconds?.replaceAll('_', ''))).toBe(MAX_TRANSCRIPTION_SAMPLES)
    const standIn = readFileSync(fixture, 'utf8')
    const [, standInPerSecond, standInSeconds] = /count > ([\d_]+) \* ([\d_]+)/u.exec(standIn) ?? []
    expect(Number(standInPerSecond?.replaceAll('_', '')) * Number(standInSeconds?.replaceAll('_', ''))).toBe(MAX_TRANSCRIPTION_SAMPLES)
  })
})
