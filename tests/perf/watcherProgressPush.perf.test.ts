// @vitest-environment node
/**
 * What a paired desktop is sent for each step a watched thread takes, at forge's record size (ADR-0073, November 10,
 * 2026 amendment, #2391). The host holds 925 requests and 929 operations a desktop's Watcher made there and 140 watched
 * threads' progress, and one thread at a time takes a step, `STEPS` times. It counts the Watcher frames two desktops are
 * sent over the real socket server: the desktop's real client, which accepts `watcher-progress` where its host lists it,
 * and a desktop whose hello does not, which is sent what every desktop was before. Bytes are the JSON text, and on the
 * wire at the socket's own compression: zlib level 6 for a message of 1 KiB or more, as `src/host/socketFrames.ts` does.
 *
 * Run against the code before the change, the real client is sent what the other desktop is, so the same file measures
 * before and after. It prints JSON and asserts nothing, so it runs only under `SOTTO_PERF_BENCH=1`:
 *
 *   SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/watcherProgressPush.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `tests/integration/watcherProgressPush.test.ts` is the guard in the default suite.
 */
import { deflateRawSync, constants as zlib } from 'node:zlib'
import { expect, it } from 'vitest'
import { PERF_BENCH } from '../fixtures/perfBench'
import { watcherProgressHost } from '../fixtures/watcherProgressHost'

const STEPS = 50
const SIZE = { requests: 925, operations: 929, targets: 140 }

interface Tally { frames: Record<string, number>; jsonBytes: number; wireBytes: number; largest: number }
function tally(texts: readonly string[]): Tally {
  const result: Tally = { frames: {}, jsonBytes: 0, wireBytes: 0, largest: 0 }
  for (const text of texts) {
    const event = String((JSON.parse(text) as { event?: unknown }).event)
    if (event !== 'watcher-state' && event !== 'watcher-progress') continue
    const data = Buffer.from(text)
    result.frames[event] = (result.frames[event] ?? 0) + 1
    result.jsonBytes += data.byteLength; result.largest = Math.max(result.largest, data.byteLength)
    result.wireBytes += data.byteLength < 1024 ? data.byteLength : deflateRawSync(data, { level: 6, finishFlush: zlib.Z_SYNC_FLUSH }).byteLength
  }
  return result
}
const perStep = (value: Tally) => ({ ...value, jsonBytesPerStep: Math.round(value.jsonBytes / STEPS), wireBytesPerStep: Math.round(value.wireBytes / STEPS) })

it.skipIf(!PERF_BENCH)('counts what a desktop is sent for each step a watched thread takes', async () => {
  const host = await watcherProgressHost(SIZE)
  try {
    const { client, frames, hello } = await host.desktop()
    const older = await host.rawDesktop(['detail-delta', 'watcher-reads'])
    await client.watcherRead({ master: host.master })
    expect(await older.call('scope', { op: 'watcher-read', request: { master: host.master } })).toMatchObject({ ok: true })
    const whole = Buffer.byteLength(JSON.stringify({ v: 1, event: 'watcher-state', projection: host.projection() }))
    const marks = { client: frames.length, older: older.messages.length }
    const watcherCount = (texts: readonly string[]) => texts.filter(text => /^\{"v":1,"event":"watcher-(state|progress)"/u.test(text)).length
    for (let step = 0; step < STEPS; step++) {
      host.step()
      await expect.poll(() => watcherCount(frames.slice(marks.client)), { timeout: 15_000 }).toBe(step + 1)
      await expect.poll(() => older.messages.slice(marks.older).filter(message => message.event === 'watcher-state').length, { timeout: 15_000 }).toBe(step + 1)
    }
    const desktop = perStep(tally(frames.slice(marks.client)))
    const olderDesktop = perStep(tally(older.messages.slice(marks.older).map(message => JSON.stringify(message))))
    const report = {
      size: { ...SIZE, steps: STEPS, wholeProjectionJsonBytes: whole },
      desktopClient: { acceptsWatcherProgress: hello.features.includes('watcher-progress'), ...desktop },
      desktopWithoutTheFeature: olderDesktop,
      jsonBytesFallBy: Math.round(olderDesktop.jsonBytes / Math.max(1, desktop.jsonBytes)),
      wireBytesFallBy: Math.round(olderDesktop.wireBytes / Math.max(1, desktop.wireBytes)),
      // At the 2.1 Watcher pushes a second forge's host sent the laptop on November 10.
      atLiveRate: { wireBytesPerMinute: { desktopClient: Math.round(desktop.wireBytesPerStep * 2.1 * 60), desktopWithoutTheFeature: Math.round(olderDesktop.wireBytesPerStep * 2.1 * 60) } },
    }
    console.log(`WATCHER-PROGRESS-PUSH ${JSON.stringify(report, null, 1)}`)
  } finally { await host.close() }
}, 300_000)
