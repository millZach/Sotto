import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'


import { AUDIO_CAPTURE_PROCESSOR_NAME } from '../../../../src/renderer/src/audio/audioRecorder'

describe('audio capture worklet', () => {
  type Processor = {
    port: { postMessage: ReturnType<typeof vi.fn> }
    process(inputs: readonly (readonly Float32Array[])[]): boolean
  }
  type ProcessorConstructor = new () => Processor

  function loadProcessor() {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/public/audio-capture-worklet.js'),
      'utf8',
    )
    const postMessage = vi.fn()
    let registeredName: string | undefined
    let RegisteredProcessor: ProcessorConstructor | undefined

    class FakeAudioWorkletProcessor {
      readonly port = { postMessage }
    }

    runInNewContext(source, {
      AudioWorkletProcessor: FakeAudioWorkletProcessor,
      Float32Array,
      registerProcessor: (name: string, processor: ProcessorConstructor) => {
        registeredName = name
        RegisteredProcessor = processor
      },
    })

    if (RegisteredProcessor === undefined) throw new Error('Worklet did not register a processor.')
    return { postMessage, processor: new RegisteredProcessor(), registeredName }
  }

  it('registers the stable processor and safely remains alive without mono input', () => {
    const { postMessage, processor, registeredName } = loadProcessor()

    expect(registeredName).toBe(AUDIO_CAPTURE_PROCESSOR_NAME)
    expect(processor.process([])).toBe(true)
    expect(processor.process([[]])).toBe(true)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('downmixes every bus-zero channel into a fresh transferred buffer on every call', () => {
    const { postMessage, processor } = loadProcessor()
    const channelZero = new Float32Array([0.25, -0.5, 0.75])
    const channelOne = new Float32Array([1, 1, 1])
    const otherInput = new Float32Array([-1, -1, -1])

    expect(processor.process([[channelZero, channelOne], [otherInput]])).toBe(true)
    const firstCopy = postMessage.mock.calls[0]?.[0] as Float32Array
    const firstTransfers = postMessage.mock.calls[0]?.[1] as ArrayBuffer[]

    expect(firstCopy).toStrictEqual(new Float32Array([0.625, 0.25, 0.875]))
    expect(firstCopy).not.toBe(channelZero)
    expect(firstCopy.buffer).not.toBe(channelZero.buffer)
    expect(firstTransfers).toHaveLength(1)
    expect(firstTransfers[0]).toBe(firstCopy.buffer)

    channelZero.fill(0)
    expect(firstCopy).toStrictEqual(new Float32Array([0.625, 0.25, 0.875]))

    expect(processor.process([[new Float32Array([0.1])]])).toBe(true)
    const secondCopy = postMessage.mock.calls[1]?.[0] as Float32Array
    expect(secondCopy).toStrictEqual(new Float32Array([0.1]))
    expect(secondCopy).not.toBe(firstCopy)
    expect(secondCopy.buffer).not.toBe(firstCopy.buffer)
    const secondTransfers = postMessage.mock.calls[1]?.[1] as ArrayBuffer[]
    expect(secondTransfers).toHaveLength(1)
    expect(secondTransfers[0]).toBe(secondCopy.buffer)
  })

  it('preserves mono and captures a signal present only on the right channel', () => {
    const { postMessage, processor } = loadProcessor()

    expect(processor.process([[new Float32Array([0.2, -0.4])]])).toBe(true)
    expect(postMessage.mock.calls[0]?.[0]).toStrictEqual(new Float32Array([0.2, -0.4]))

    expect(
      processor.process([
        [new Float32Array([0, 0]), new Float32Array([0.8, -0.6])],
      ]),
    ).toBe(true)
    expect(postMessage.mock.calls[1]?.[0]).toStrictEqual(new Float32Array([0.4, -0.3]))
  })
})
