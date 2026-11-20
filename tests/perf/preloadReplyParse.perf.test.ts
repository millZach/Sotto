// @vitest-environment node
/**
 * What the preload spends checking main's answers before the window sees them (#2733): a thread's history as the window
 * asks for it when a thread is picked, a command's answer, and a whole read of the state, which the owner's window made
 * 26 times in a minute of switching on November 20, 2026, each copied as the IPC copies it, then parsed with its
 * schema as the preload did, and checked as it does now: for its shape alone, as the state channels already are, with a
 * command's answer's catalogs parsed by their own small schema (ADR-0028). Uses an explicitly
 * selected data folder: `workspace.json`, and the stored histories in its `threads.sqlite`, which is only read.
 *
 *   Set SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA=<folder with workspace.json and threads.sqlite>.
 *   npx vitest run tests/perf/preloadReplyParse.perf.test.ts --maxWorkers=1 --disable-console-intercept
 */
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { describe, expect, it } from 'vitest'
import { round } from '../fixtures/perfBench'
import { perfDataDirectory } from '../fixtures/perfWorkspace'
import { upperMedian as median } from './support/statistics.mjs'
import { stateAround } from './support/transcriptState'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { AgentStateBroadcaster } from '../../src/main/agents/agentStateBroadcast'
import { agentCommandChangedThreadRecordsReceiptSchema, agentModelCatalogRevisionSchema, agentStateSchema, agentThreadDetailResultSchema, agentShell, type AgentHostSnapshot } from '../../src/shared/agents'

const RUNS = 9

function time(work: () => void): number {
  const samples: number[] = []
  for (let run = 0; run < RUNS; run++) { const started = performance.now(); work(); samples.push(performance.now() - started) }
  return median(samples)
}

/** What crosses the bridge: structured clone, as Electron's IPC copies a reply. */
const wire = (value: unknown): unknown => deserialize(serialize(value))
const shaped = (value: unknown, key: string): boolean => typeof value === 'object' && value !== null && key in value

describe('the preload’s checks of main’s answers', async () => {
  const dataDirectory = await perfDataDirectory()
  const store = dataDirectory === null ? null : await access(join(dataDirectory, 'threads.sqlite')).then(() => join(dataDirectory, 'threads.sqlite'), () => null)
  describe('requires SOTTO_PERF_BENCH=1 and SOTTO_PERF_DATA containing workspace.json and threads.sqlite', () => {
    it.skipIf(store === null)('reports the parse of a thread’s history and of a command’s answer at the owner’s scale', async () => {
      const workspace = JSON.parse(await readFile(join(dataDirectory!, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
      const threads = new ThreadStore(store!, undefined, null)
      threads.open()
      const histories: Record<string, unknown>[] = []
      try {
        for (const thread of workspace.snapshot.threads) {
          if (!threads.hasActivities(thread.id)) continue
          // The window's first look at a thread: its first window of messages and every activity record beside them.
          const detail = wire({ threadId: thread.id, revision: 1, messages: threads.readMessages(thread.id).messages, activities: threads.readActivities(thread.id) })
          const bytes = serialize(detail).byteLength
          const parse = time(() => { agentThreadDetailResultSchema.parse(detail) })
          const check = time(() => { void shaped(detail, 'threadId') })
          const shape = detail as { messages: unknown[]; activities: unknown[] }
          histories.push({ messages: shape.messages.length, activities: shape.activities.length, kb: Math.round(bytes / 1024), parseMs: round(parse, 2), checkMs: round(check, 3) })
        }
      } finally { threads.close() }
      expect(histories.length).toBeGreaterThan(0)

      // A selection's answer: the shell with three thread records changed since the broadcast the window holds.
      const state = agentShell(stateAround(workspace.snapshot, workspace.snapshot.threads[0]!.id))
      const broadcaster = new AgentStateBroadcaster()
      broadcaster.send(state, () => true)
      const next = { ...state, activeThreadId: state.host.threads[1]!.id,
        host: { ...state.host, threads: state.host.threads.map((thread, index) => index < 3 ? { ...thread, status: 'running' as const } : thread) } }
      const receipt = wire(broadcaster.encodeChangedThreadRecordsReceipt(next))
      const answer = { kb: Math.round(serialize(receipt).byteLength / 1024), parseMs: round(time(() => { agentCommandChangedThreadRecordsReceiptSchema.parse(receipt) }), 2),
        checkMs: round(time(() => { void (shaped(receipt, 'host') && agentModelCatalogRevisionSchema.safeParse((receipt as { host: { models: unknown } }).host.models).success) }), 3) }
      // A whole read: every thread record and every catalog in full.
      const read = wire(state)
      const wholeRead = { kb: Math.round(serialize(read).byteLength / 1024), parseMs: round(time(() => { agentStateSchema.parse(read) }), 2), checkMs: round(time(() => { void shaped(read, 'host') }), 3) }
      console.info(`preload reply parse: ${JSON.stringify({ threads: workspace.snapshot.threads.length, histories, selectionAnswer: answer, wholeRead })}`)
    }, 600_000)
  })
})
