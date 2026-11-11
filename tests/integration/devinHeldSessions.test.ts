// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { devinFixture } from '../fixtures/devinFixture'

// Saying why a session is held is a read (#2398): it must leave the thread as it found it. Devin's `thread(id)` marks
// the thread changed, so a read that went through it had the next adapter update publish a thread nothing had changed.
let f: Awaited<ReturnType<typeof devinFixture>> | undefined
afterEach(async () => { await f?.cleanup(); f = undefined })

it('says why a Devin session is held without marking its thread changed', async () => {
  f = await devinFixture(undefined, undefined, 60_000, {}, undefined, { acceptanceGraceMs: 60_000 })
  await f.host.connect()
  await f.host.execute({ type: 'create-project', commandId: randomUUID(), projectId: f.projectId, title: 'Project', path: f.root })
  const id = randomUUID()
  expect(await f.host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId: f.projectId, modelId: f.modelId, title: 'Synthetic thread' })).toEqual({ accepted: true })
  f.host.observeThreads([id])
  // The rule the read asks of the adapter, as the reaper asks it for each session it tracks.
  const internals = f.host as unknown as { threadChanges: { mark(id: string): void }; reaper: { options: { whyBusy(id: string): readonly string[] } } }
  const marked = vi.spyOn(internals.threadChanges, 'mark')
  expect(internals.reaper.options.whyBusy(id)).toEqual([])
  f.host.heldSessions()
  expect(marked).not.toHaveBeenCalled()
})
