// @vitest-environment node
/**
 * What a read of a paired host's state costs this desktop while it holds the user's unsent drafts for that host. The
 * socket service's view lays the drafts over the host's state, and every Watcher pass and router build reads it: on the
 * owner's laptop on November 13, 2026, about 500 times a minute, with Watcher asking it twice for each thread taking part on
 * the host. Each read copied every retained draft twice, about 1.6 ms a read and 0.8 s of main's minute.
 *
 * The first test runs in the default suite: the view hands out the store's own drafts, frozen, copies none of them, and
 * the shell, whose caller may write, still gets copies. The second times reads and prints JSON; it runs only under
 * `SOTTO_PERF_BENCH=1` (`docs/perf/2026-11-13-remote-draft-view.md`).
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/remoteDraftView.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { RetainedDraftStore } from '../../src/main/agents/retainedDraftStore'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { PERF_BENCH, median, round } from '../fixtures/perfBench'
import { hostId } from '../fixtures/socketHostService'

afterEach(() => { vi.restoreAllMocks() })

/** A desktop's client of a paired host holding `count` unsent drafts there, one a thread, each a long prompt with two attachments. */
function clientWithDrafts(count: number) {
  const retainedDrafts = new RetainedDraftStore()
  const client = new SocketHostService({ url: 'http://127.0.0.1:4319', token: 'paired-token', expectedHostId: hostId, retainedDrafts })
  Object.assign(client, { features: ['draft-revisions', 'atomic-send'], cached: emptyDesktopState(hostId) })
  const text = 'A synthetic unsent prompt about the change this thread is making. '.repeat(30)
  for (let index = 0; index < count; index++) {
    retainedDrafts.put({ hostId, providerId: 'codex', questionsDigest: null, saved: index % 2 === 0, recovery: false, ...index % 2 === 0 ? { hostDraftId: randomUUID() } : {},
      draft: { threadId: `thread-${index}`, draftId: randomUUID(), text, requestId: null, updatedAt: new Date().toISOString(),
        attachments: [{ id: randomUUID(), name: 'screenshot.png', mimeType: 'image/png', sizeBytes: 120_000, digest: 'a'.repeat(64),
          browserFeedback: { label: 'Send button', comment: 'Make this bigger', context: 'The page and where the button is.' } }, { id: randomUUID(), name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 4_000, digest: 'b'.repeat(64) }] } })
  }
  return { client, retainedDrafts }
}

it('lays the store\'s own drafts over a read of the host, frozen, and copies them only for the shell', () => {
  const { client, retainedDrafts } = clientWithDrafts(40)
  const clone = vi.spyOn(globalThis, 'structuredClone')
  const first = client.view(), second = client.view()
  expect(clone).not.toHaveBeenCalled()
  expect(first.threadDrafts).toHaveLength(40)
  // An unsaved draft is the store's own record, the same on every read; a saved one is laid over with the host's ID.
  const unsaved = first.threadDrafts!.find(draft => draft.threadId === 'thread-1')!
  expect(second.threadDrafts!.find(draft => draft.threadId === 'thread-1')).toBe(unsaved)
  expect(unsaved).toBe(retainedDrafts.read(hostId).find(edit => edit.draft.threadId === 'thread-1')!.draft)
  // A reader that writes into one fails, and the user's words stay as they were.
  expect(() => { (unsaved as { text: string }).text = 'changed' }).toThrow(TypeError)
  expect(() => { (unsaved.attachments as unknown[]).push({}) }).toThrow(TypeError)
  expect(() => { (unsaved.attachments[0]!.browserFeedback as { comment: string }).comment = 'changed' }).toThrow(TypeError)
  expect(retainedDrafts.list(hostId).find(edit => edit.draft.threadId === 'thread-1')!.draft.text).toBe(unsaved.text)
  // A recovery that failed for one draft says so on a read, still without a copy.
  clone.mockClear()
  Object.assign(client, { recoveryError: { threadId: 'thread-1', draftId: unsaved.draftId, message: 'The draft could not be recovered.' } })
  expect(client.view().error).toBe('The draft could not be recovered.')
  expect(clone).not.toHaveBeenCalled()
  Object.assign(client, { recoveryError: undefined })
  // The shell's caller may write, so it gets copies, and what it writes stays in them.
  clone.mockClear()
  const shell = client.shell(), copied = shell.threadDrafts!.find(draft => draft.threadId === 'thread-1')!
  expect(clone).toHaveBeenCalled()
  expect(copied).not.toBe(unsaved)
  copied.text = 'changed in the copy'
  expect(client.view().threadDrafts!.find(draft => draft.threadId === 'thread-1')!.text).toBe(unsaved.text)
})

it.skipIf(!PERF_BENCH)('measures a read of a paired host\'s state while this desktop holds drafts there', () => {
  const report: Record<string, unknown> = {}
  for (const count of [40, 150]) {
    const { client } = clientWithDrafts(count)
    for (let n = 0; n < 20; n++) client.view()
    const times: number[] = []
    for (let n = 0; n < 200; n++) { const start = performance.now(); client.view(); times.push(performance.now() - start) }
    report[`${count} drafts`] = { medianMs: round(median(times), 3), minMs: round(Math.min(...times), 3) }
  }
  console.log(`REMOTE-DRAFT-VIEW ${JSON.stringify(report)}`)
})
