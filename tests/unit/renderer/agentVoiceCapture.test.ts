import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserVoiceCapture } from '../../../src/renderer/src/agents/voiceCapture'
import type { AudioNodeAdapter } from '../../../src/renderer/src/audio/audioRecorder'

const captures: BrowserVoiceCapture[] = []

afterEach(async () => {
  await Promise.all(captures.splice(0).map((capture) => capture.stop()))
  vi.unstubAllGlobals()
})

async function microphone(sampleRate: number) {
  const utterances: Float32Array[] = []
  const onError = vi.fn()
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null }
  class Node implements AudioNodeAdapter {
    connect(node: AudioNodeAdapter) { return node }
    disconnect() {}
  }
  vi.stubGlobal('AudioContext', class {
    readonly sampleRate = sampleRate
    readonly destination = new Node()
    readonly audioWorklet = { addModule: async () => undefined }
    createMediaStreamSource() { return new Node() }
    createGain() { return Object.assign(new Node(), { gain: { value: 1 } }) }
    async close() {}
  })
  vi.stubGlobal('AudioWorkletNode', class extends Node { readonly port = port })
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  })

  // Execute the shipped worklet so its input sanitization and the capture's
  // segmentation/resampling are both part of the regression path.
  type Processor = { process(inputs: Float32Array[][]): boolean }
  let ProcessorClass: (new () => Processor) | undefined
  runInNewContext(readFileSync(resolve('src/renderer/public/audio-capture-worklet.js'), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class {
      readonly port = { postMessage: (data: Float32Array) => port.onmessage?.({ data }) }
    },
    registerProcessor: (_name: string, implementation: new () => Processor) => { ProcessorClass = implementation },
  })
  if (ProcessorClass === undefined) throw new Error('Capture worklet did not register.')
  const processor = new ProcessorClass()
  const capture = new BrowserVoiceCapture({ onUtterance: (audio) => utterances.push(audio), onError })
  captures.push(capture)
  await capture.start()
  return {
    utterances,
    onError,
    feed(seconds: number, sample: (time: number) => number) {
      // Chromium currently delivers microphone render quanta of 128 frames.
      for (let offset = 0; offset < seconds * sampleRate; offset += 128) {
        processor.process([[Float32Array.from({ length: 128 }, (_, index) => sample((offset + index) / sampleRate))]])
      }
    },
  }
}

function peak(audio: Float32Array): number {
  return audio.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0)
}

describe('agent microphone PCM boundary', () => {
  it.each([16_000, 44_100, 48_000])('keeps a clipped microphone waveform normalized after resampling from %i Hz', async (sampleRate) => {
    const capture = await microphone(sampleRate)
    capture.feed(0.2, () => 0)
    // A saturated microphone is already bounded by the real worklet. The sinc
    // downsampler can nevertheless ring past both full-scale limits.
    capture.feed(0.2, (time) => 3 * Math.sin(2 * Math.PI * 400 * time))
    capture.feed(0.66, () => 0)

    expect(capture.utterances).toHaveLength(1)
    const audio = capture.utterances[0]!
    expect(audio.length).toBeLessThanOrEqual(132_000)
    expect(audio.every(Number.isFinite)).toBe(true)
    expect(peak(audio)).toBeLessThanOrEqual(1)
    expect(audio.some((sample) => sample >= 0.99)).toBe(true)
    expect(audio.some((sample) => sample <= -0.99)).toBe(true)
    expect(capture.onError).not.toHaveBeenCalled()
  })

  it('preserves quiet microphone amplitude instead of applying automatic gain', async () => {
    const capture = await microphone(48_000)
    capture.feed(0.2, (time) => 0.25 * Math.sin(2 * Math.PI * 400 * time))
    capture.feed(0.66, () => 0)

    expect(capture.utterances).toHaveLength(1)
    expect(peak(capture.utterances[0]!)).toBeGreaterThan(0.24)
    expect(peak(capture.utterances[0]!)).toBeLessThan(0.26)
  })

  it.each([8_000, 16_000, 44_100, 48_000])('caps continuous speech including pre-roll below the wake IPC duration limit at %i Hz', async (sampleRate) => {
    const capture = await microphone(sampleRate)
    capture.feed(0.3, () => 0)
    capture.feed(8.1, (time) => 0.25 * Math.sin(2 * Math.PI * 400 * time))

    expect(capture.utterances).toHaveLength(1)
    const audio = capture.utterances[0]!
    expect(audio.length).toBeGreaterThanOrEqual(8 * 16_000)
    expect(audio.length).toBeLessThanOrEqual(Math.ceil((8 + 128 / sampleRate) * 16_000))
    expect(audio.length).toBeLessThanOrEqual(132_000)
  })
})
