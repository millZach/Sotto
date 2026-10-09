// @vitest-environment node
/**
 * What an 8 MiB screenshot in a thread's draft costs everything that mentions the draft (issue #320, ADR-0031):
 * the draft save the window sends and its answer, the shell main broadcasts to each window, the write of
 * `agents.json`, and the preview file a send with the image writes. Drives the real coordinator and stores on a
 * temporary folder, with the in-process E2E provider. Counters and timers only: nothing about the prompt or the
 * image is recorded.
 *
 * The byte counts are asserted and run by default; the timings run only under `SOTTO_PERF_BENCH=1`
 * (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/attachmentHandles.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { createAgentControl } from '../fixtures/agentControlFixture'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serialize } from 'node:v8'
import { afterAll, describe, expect, it } from 'vitest'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import type { AgentCommand } from '../../src/shared/agents'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'
import { immediatePublishScheduler } from '../fixtures/publishScheduler'
import { pngOfSize } from '../fixtures/stagedImages'

const MiB = 1024 * 1024
const SAMPLES = 9
/** Everything that mentions a draft stays under this, whatever the image weighs. */
const BOUND = 64 * 1024
const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-perf-handles-')); roots.push(root)
  const credentials = await testCredentials(root, { mode: 'unavailable' })
  const control = createAgentControl({ schedule: immediatePublishScheduler, directory: root, host: new E2EAgentHost(), credentials, reasoner: e2eAgentReasoner })
  let broadcastBytes = 0
  control.subscribe(state => { broadcastBytes = Math.max(broadcastBytes, serialize(state).length) })
  await control.start(); await control.command({ type: 'connect' })
  const image = await control.stageAttachment({ name: 'Screenshot.png', mimeType: 'image/png', bytes: pngOfSize(8 * MiB) })
  const save = (index: number): AgentCommand => ({ type: 'save-thread-draft', composer: 'manual', threadId: 'workshop', draftId: randomUUID(), text: `Text ${index}`, attachments: [image], requestId: null })
  return { root, control, image, save, broadcast: () => broadcastBytes }
}

describe('an 8 MiB screenshot in a draft', () => {
  it('adds no image bytes to a draft save, its answer, a broadcast, agents.json or the preview file', async () => {
    const f = await fixture()
    try {
      const commands: number[] = []; const replies: number[] = []; const files: number[] = []
      for (let index = 0; index < SAMPLES; index++) {
        const command = f.save(index)
        commands.push(serialize(command).length)
        const reply = await f.control.command(command)
        expect(reply.error).toBeNull()
        replies.push(serialize(reply).length)
        files.push((await stat(join(f.root, 'agents.json'))).size)
      }
      const shell = serialize(f.control.shell()).length
      const broadcast = f.broadcast()
      await f.control.command({ type: 'manual-send', threadId: 'workshop', text: 'Look', attachments: [f.image] })
      await f.control.privacyChanged()
      // The bound means something only once the preview is written: the send records it without waiting on the disk.
      expect(await readFile(join(f.root, 'attachment-previews.json'), 'utf8')).toContain(f.image.digest)
      const previews = (await stat(join(f.root, 'attachment-previews.json'))).size
      const bytes = { saveCommand: median(commands), saveReply: median(replies), shell, largestBroadcast: broadcast, agentsJson: median(files), previewFileAfterSend: previews }
      console.info(`attachment handles bytes: ${JSON.stringify(bytes)}`)
      for (const value of Object.values(bytes)) expect(value).toBeLessThan(BOUND)
    } finally { f.control.dispose(); await f.control.privacyChanged() }
  }, 120_000)
})

describe.skipIf(!PERF_BENCH)('an 8 MiB screenshot in a draft, timed', () => {
  it('reports a draft save, a shell and a persist', async () => {
    const f = await fixture()
    try {
      const saves: number[] = []; const shells: number[] = []; const persists: number[] = []; const stages: number[] = []
      // What the image costs once, when it is attached: hashed, written and synced, then named in the index.
      for (let index = 0; index < SAMPLES; index++) {
        const bytes = pngOfSize(8 * MiB, index + 1)
        const started = performance.now(); await f.control.stageAttachment({ name: 'Screenshot.png', mimeType: 'image/png', bytes }); stages.push(performance.now() - started)
      }
      for (let index = 0; index < SAMPLES; index++) {
        const started = performance.now(); await f.control.command(f.save(index)); saves.push(performance.now() - started)
      }
      for (let index = 0; index < SAMPLES; index++) { const started = performance.now(); f.control.shell(); shells.push(performance.now() - started) }
      const internals = f.control as unknown as { persist(): Promise<void>; contextActivityAt: number }
      for (let index = 0; index < SAMPLES; index++) {
        // A change the write carries, so each one reaches the disk rather than joining the last.
        internals.contextActivityAt = index
        const started = performance.now(); await internals.persist(); persists.push(performance.now() - started)
      }
      console.info(`attachment handles timing: ${JSON.stringify({ samples: SAMPLES,
        medianMs: { stage: round(median(stages)), draftSave: round(median(saves)), shell: round(median(shells), 2), persist: round(median(persists)) } })}`)
    } finally { f.control.dispose(); await f.control.privacyChanged() }
  }, 120_000)
})
