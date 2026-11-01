// @vitest-environment node
/**
 * What a tool step's pictures cost the Codex and Cursor projections on Electron main, per update (ADR-0170, plan part 3).
 *
 * Every update of a running tool passes through its provider's projection while a thread works. With the Owl feature
 * `inline-media` on, a Codex Computer Use call, a Codex `view_image` and a Cursor tool may carry a picture, which is hashed
 * once and kept by handle. This times one update of each, with words alone and with a picture, the feature off and on,
 * and counts the work that must not repeat: a repeated update hashes nothing, and a `view_image` file is read once.
 *
 * The same file runs on a checkout without these sources (the "before"): there a `view_image` is no step and Cursor's
 * projection takes no capture, so only the words-only and feature-off rows compare, and those must not get slower. The
 * microseconds print every run and are asserted only under SOTTO_PERF_ASSERT=1; the counts are asserted always.
 *
 *   npx vitest run tests/perf/toolPictureCapture.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexActivityProjection, codexItemSchema } from '../../src/main/agents/codexActivity'
import { cursorActivities } from '../../src/main/agents/cursorActivity'
import { ThreadMediaStore, type MediaCapture, type MediaFileCapture } from '../../src/main/agents/threadMedia'
import type { AgentActivity } from '../../src/shared/agentActivity'
import type { AgentThread } from '../../src/shared/agents'
import { pngHeader } from '../fixtures/stagedImages'

const ROUNDS = 7
const UPDATES = 2_000
/** A screenshot-sized picture, 256 KiB, so a capture that hashes it again would show. */
const SCREENSHOT = Buffer.concat([pngHeader(1280, 800), Buffer.alloc(256 * 1024 - 40, 7)])
const DATA = SCREENSHOT.toString('base64')
/** A stopwatch budget per update, in microseconds, under SOTTO_PERF_ASSERT=1: generous, since a hash of the picture is far over it. */
const BUDGET_US = 40

const folders: string[] = []
afterAll(async () => { await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }))) })
async function store(): Promise<ThreadMediaStore> {
  const folder = await mkdtemp(join(tmpdir(), 'sotto-tool-picture-perf-')); folders.push(folder)
  const made = new ThreadMediaStore(folder); await made.load(); return made
}
/** Counts the calls that had something to do: a capture given pictures (an update with words alone passes none), or a file read. */
function counted<T extends (first: never, ...rest: never[]) => unknown>(work: T): { work: T; calls: () => number } {
  let calls = 0
  const each = (first: unknown, ...rest: unknown[]): unknown => {
    if (!Array.isArray(first) || first.length) calls += 1
    return (work as unknown as (...args: unknown[]) => unknown)(first, ...rest)
  }
  return { work: each as unknown as T, calls: () => calls }
}
/** Median microseconds per update over `ROUNDS` rounds of `UPDATES`. */
function perUpdate(update: () => void): number {
  for (let index = 0; index < 200; index++) update()
  const rounds: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const start = process.hrtime.bigint()
    for (let index = 0; index < UPDATES; index++) update()
    rounds.push(Number(process.hrtime.bigint() - start) / 1_000 / UPDATES)
  }
  return rounds.sort((a, b) => a - b)[Math.floor(ROUNDS / 2)]!
}
const thread = (): AgentThread => ({ id: 't', projectId: 'p', title: 'T', modelId: 'm', status: 'running', requests: [], messages: [] })
const round = (value: number): string => value.toFixed(2)

describe('tool pictures per update (ADR-0170)', () => {
  it('Codex: a Computer Use call and a view_image hash and read once, and an update costs about what it did', async () => {
    const media = await store()
    const capture = counted<MediaCapture>(media.capture)
    const path = join(folders[0]!, 'viewed.png'); await writeFile(path, SCREENSHOT)
    const captureFile = counted<MediaFileCapture>(media.captureFile)
    const words = { id: 'cu', type: 'mcpToolCall', status: 'completed', server: 'node_repl', tool: 'js', arguments: { code: 'await sky.click()' }, result: { content: [{ type: 'text', text: 'Clicked.' }] } }
    const shot = { ...words, arguments: { code: 'await nodeRepl.emitImage(await sky.screenshot())' }, result: { content: [{ type: 'text', text: 'Script completed' }, { type: 'image', data: DATA, mimeType: 'image/png' }] } }
    const viewed = { id: 'view', type: 'imageView', path }
    const context = { turnId: 'turn', phase: 'completed' as const }
    const timed = (projection: CodexActivityProjection, item: unknown): number => {
      const conversation = thread()
      return perUpdate(() => projection.item(conversation, codexItemSchema.parse(item), context))
    }
    const off = new CodexActivityProjection(() => 1_000)
    const on = new CodexActivityProjection(() => 1_000, capture.work, captureFile.work)
    const result = {
      wordsOff: timed(off, words), shotOff: timed(off, shot), viewOff: timed(off, viewed),
      wordsOn: timed(on, words), shotOn: timed(on, shot), viewOn: timed(on, viewed),
    }
    await media.idle()
    console.info(`[perf] Codex per update, µs (off / on): Computer Use words ${round(result.wordsOff)} / ${round(result.wordsOn)}, `
      + `Computer Use screenshot ${round(result.shotOff)} / ${round(result.shotOn)}, view_image ${round(result.viewOff)} / ${round(result.viewOn)}; `
      + `captures ${capture.calls()}, file reads ${captureFile.calls()}`)
    // The screenshot was hashed on its first update only, and the viewed file read once, however many updates followed.
    expect(capture.calls()).toBe(1)
    expect(captureFile.calls()).toBeLessThanOrEqual(1)
    if (process.env.SOTTO_PERF_ASSERT === '1') for (const value of Object.values(result)) expect(value).toBeLessThan(BUDGET_US)
  })

  it('Cursor: a tool\'s picture is hashed once, repeated updates hash nothing, and an update costs about what it did', async () => {
    const media = await store()
    const capture = counted<MediaCapture>(media.capture)
    const place = { turnId: 'turn', cwd: '/repo', key: 'shot' }
    const words = { sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Took a screenshot.' } }] }
    const shot = { ...words, content: [...words.content, { type: 'content', content: { type: 'image', data: DATA, mimeType: 'image/png' } }] }
    const timed = (update: Record<string, unknown>, work?: MediaCapture): number => {
      let rows: AgentActivity[] = cursorActivities({ sessionUpdate: 'tool_call', toolCallId: 'call', title: 'screenshot', kind: 'other', status: 'pending' }, place, [], true, work)
      // Each update projects against the rows the last one made, as the adapter's thread holds them.
      return perUpdate(() => { rows = cursorActivities(update, place, rows, true, work) })
    }
    const result = { wordsOff: timed(words), shotOff: timed(shot), wordsOn: timed(words, capture.work), shotOn: timed(shot, capture.work) }
    await media.idle()
    console.info(`[perf] Cursor per update, µs (off / on): words ${round(result.wordsOff)} / ${round(result.wordsOn)}, `
      + `screenshot ${round(result.shotOff)} / ${round(result.shotOn)}; captures ${capture.calls()}`)
    // Hashed on its first update only. A replay into the step hashing nothing is `acpPictures.test.ts`'s, through the adapter.
    expect(capture.calls()).toBe(1)
    if (process.env.SOTTO_PERF_ASSERT === '1') for (const value of Object.values(result)) expect(value).toBeLessThan(BUDGET_US)
  })
})
