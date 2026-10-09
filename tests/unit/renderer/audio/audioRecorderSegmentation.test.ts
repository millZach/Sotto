import { describe, expect, it } from 'vitest'


import { createHarness } from '../../../fixtures/renderer/audioRecorderHarness'

describe('AudioRecorder streaming segmentation', () => {
  const SAMPLE_RATE = 48_000
  const loudChunk = (seconds: number) =>
    new Float32Array(SAMPLE_RATE * seconds).fill(0.5)
  const silentChunk = (seconds: number) => new Float32Array(SAMPLE_RATE * seconds)

  function pushChunk(harness: ReturnType<typeof createHarness>, chunk: Float32Array): void {
    harness.worklet.port.onmessage?.({ data: chunk })
  }

  it('emits a segment at sustained silence once the minimum length is reached', async () => {
    const harness = createHarness()
    const segments: Array<{ samples: Float32Array; durationMs: number }> = []
    const recorder = harness.recorder({ onSegment: (segment) => { segments.push(segment) } })
    await recorder.start()

    for (let second = 0; second < 6; second++) pushChunk(harness, loudChunk(1))
    expect(segments).toHaveLength(0)
    pushChunk(harness, silentChunk(1))

    expect(segments).toHaveLength(1)
    expect(segments[0]?.durationMs).toBeCloseTo(7_000, 0)
    expect(segments[0]?.samples.length).toBeGreaterThan(0)

    pushChunk(harness, loudChunk(1))
    const result = await recorder.stop()

    expect(result).not.toBeNull()
    // The tail excludes the emitted segment but reports the full duration.
    expect(result?.durationMs).toBeCloseTo(8_000, 0)
    expect(result?.samples.length).toBeLessThan(2 * 16_000)
  })

  it('forces a cut at the maximum segment length without silence', async () => {
    const harness = createHarness()
    const segments: Array<{ durationMs: number }> = []
    const recorder = harness.recorder({ onSegment: (segment) => { segments.push(segment) } })
    await recorder.start()

    for (let second = 0; second < 16; second++) pushChunk(harness, loudChunk(1))

    expect(segments).toHaveLength(1)
    expect(segments[0]?.durationMs).toBeGreaterThanOrEqual(15_000)
    await recorder.cancel()
  })

  it('keeps audio and disables segmentation when the segment callback throws', async () => {
    const harness = createHarness()
    let calls = 0
    const recorder = harness.recorder({
      onSegment: () => {
        calls += 1
        throw new Error('renderer bug')
      },
    })
    await recorder.start()

    for (let second = 0; second < 20; second++) pushChunk(harness, loudChunk(1))
    expect(calls).toBe(1)

    const result = await recorder.stop()
    // Nothing was lost: the entire recording is still in the final result.
    expect(result?.durationMs).toBeCloseTo(20_000, 0)
    expect(result?.samples.length).toBeGreaterThan(19 * 16_000)
  })

  it('never segments without an onSegment callback', async () => {
    const harness = createHarness()
    const recorder = harness.recorder()
    await recorder.start()
    for (let second = 0; second < 20; second++) pushChunk(harness, loudChunk(1))
    const result = await recorder.stop()
    expect(result?.samples.length).toBeGreaterThan(19 * 16_000)
  })
})
