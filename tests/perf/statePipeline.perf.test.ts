// @vitest-environment node
/**
 * Measures what one published state costs on the way from main to the window, using a copy of a real
 * Sotto data folder: clone, attachment preview decoration, the IPC serialisation both ways, and the
 * preload's schema parse. Skips when no data folder is available.
 *
 *   npx vitest run tests/perf/statePipeline.perf.test.ts
 *   SOTTO_PERF_DATA=<folder with workspace.json and attachment-previews.json> to point elsewhere.
 */
import { mkdtemp, readFile, copyFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deserialize, serialize } from 'node:v8'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentShell, agentStateSchema, defaultAgentConfiguration, type AgentHostSnapshot, type AgentState, type AgentThreadDetail } from '../../src/shared/agents'
import { applyAgentThreadDetailDelta, diffAgentThreadDetail } from '../../src/shared/agentThreadDetail'
import { AttachmentPreviews } from '../../src/main/agents/attachmentPreviews'

const ITERATIONS = 20
const dataDirectory = process.env.SOTTO_PERF_DATA ?? (process.env.APPDATA ? join(process.env.APPDATA, 'sotto') : '')

async function available(): Promise<boolean> {
  if (!dataDirectory) return false
  try { await access(join(dataDirectory, 'workspace.json')); return true } catch { return false }
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function time(work: () => void): number {
  const samples: number[] = []
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now()
    work()
    samples.push(performance.now() - started)
  }
  return median(samples)
}

function stateAround(host: AgentHostSnapshot): AgentState {
  return {
    configuration: defaultAgentConfiguration(), connection: 'connected', host,
    assignments: [], queue: [], activeThreadId: host.threads[0]?.id ?? null, activeProjectId: host.projects[0]?.id ?? null,
    draft: '', draftThreadId: null, composing: false, draftRequestId: null, draftAttachments: [], deliveredDrafts: [], threadDrafts: [], deliveries: [],
    pendingRequest: '', globalLaneBusy: false, notice: '', error: null, speech: { id: 0, text: '' },
    voice: { status: 'off', error: null, action: 'none', revision: 0 },
    credentials: { reasoning: false, grokSpeech: false, secure: true }, reasoningAccounts: [],
    membership: { status: 'beta', label: 'Beta', expiresAt: null },
  }
}

describe('state pipeline cost', async () => {
  const present = await available()
  let directory = ''
  beforeAll(async () => {
    if (!present) return
    // The measurement never touches the live folder: the previews store may tidy or rewrite its file.
    directory = await mkdtemp(join(tmpdir(), 'sotto-perf-'))
    for (const name of ['workspace.json', 'attachment-previews.json']) {
      await copyFile(join(dataDirectory, name), join(directory, name)).catch(() => undefined)
    }
  })
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

  it.skipIf(!present)('reports the cost of one published state', async () => {
    const workspace = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8')) as { snapshot: AgentHostSnapshot }
    const previews = new AttachmentPreviews(directory)
    await previews.load()
    const state = stateAround(workspace.snapshot)
    const messages = state.host.threads.reduce((count, thread) => count + thread.messages.length, 0)

    const clone = time(() => { structuredClone(state) })
    const decorated = structuredClone(state)
    const decorate = time(() => { previews.decorate(structuredClone(state).host) })
    previews.decorate(decorated.host)
    const bytes = serialize(decorated).byteLength
    const bare = serialize(state).byteLength
    const send = time(() => { serialize(decorated) })
    const wire = serialize(decorated)
    const receive = time(() => { deserialize(wire) })
    const received = deserialize(wire) as unknown
    // What preload does now: the state channel carries Sotto's own state from Sotto's own main
    // process, so it is checked for shape alone. The schema parse it replaced is still measured,
    // to keep what the structural guard buys visible.
    const guard = time(() => { void (typeof received === 'object' && received !== null && 'host' in received) })
    const parse = time(() => { agentStateSchema.safeParse(received) })
    const total = clone + decorate + send + receive + guard

    const report = {
      threads: state.host.threads.length, messages,
      payloadKB: Math.round(bytes / 1024), payloadWithoutPreviewsKB: Math.round(bare / 1024),
      ms: { clone: round(clone), decorate: round(decorate), serialize: round(send), deserialize: round(receive),
        schemaParse: round(guard), schemaParseSkipped: round(parse), total: round(total) },
    }
    console.info(`state pipeline: ${JSON.stringify(report)}`)
    expect(report.threads).toBeGreaterThan(0)

    // The shell alone: what every provider event now costs, with no thread's history in it and so
    // nothing for the preview decoration to do.
    const shellClone = time(() => { structuredClone(agentShell(state)) })
    const shell = structuredClone(agentShell(state))
    const shellBytes = serialize(shell).byteLength
    const shellSend = time(() => { serialize(shell) })
    const shellWire = serialize(shell)
    const shellReceive = time(() => { deserialize(shellWire) })
    const shellReceived = deserialize(shellWire) as unknown
    const shellGuard = time(() => { void (typeof shellReceived === 'object' && shellReceived !== null && 'host' in shellReceived) })
    const shellTotal = shellClone + shellSend + shellReceive + shellGuard

    // One viewed thread's history, which is what a streaming burst actually moves now.
    const weight = (thread: (typeof state.host.threads)[number]): number => thread.messages.length + (thread.activities?.length ?? 0)
    const busiest = [...state.host.threads].sort((first, second) => weight(second) - weight(first))[0]!
    const detail = { threadId: busiest.id, revision: 1, messages: structuredClone(busiest.messages), activities: structuredClone(busiest.activities ?? []) }
    previews.decorate({ ...state.host, threads: [{ ...busiest, messages: detail.messages }] })
    const detailClone = time(() => { structuredClone(detail) })
    const detailBytes = serialize(detail).byteLength

    const shellReport = {
      threads: shell.host.threads.length, messages: 0,
      payloadKB: Math.round(shellBytes / 1024),
      detailThread: busiest.id.slice(0, 8), detailMessages: busiest.messages.length,
      detailActivities: busiest.activities?.length ?? 0,
      detailPayloadKB: Math.round(detailBytes / 1024), detailCloneMs: round(detailClone),
      ms: { clone: round(shellClone), decorate: 0, serialize: round(shellSend), deserialize: round(shellReceive),
        schemaParse: round(shellGuard), total: round(shellTotal) },
    }
    console.info(`state pipeline (shell): ${JSON.stringify(shellReport)}`)
    expect(shellBytes).toBeLessThan(bare)

    // One streaming chunk into that thread. Before: the whole detail again, copied, sent and taken back
    // apart. After: the difference from the revision the window holds, diffed at the end of the window
    // and applied against what it already has.
    const held: AgentThreadDetail = { threadId: busiest.id, revision: 1, messages: detail.messages, activities: detail.activities }
    const chunk = 'x'.repeat(40)
    const last = held.messages.length - 1
    const grown = { messages: held.messages.map((message, index) => index === last ? { ...message, text: message.text + chunk } : message),
      activities: held.activities }
    const fullSend = time(() => { serialize(detail) })
    const fullWire = serialize(detail)
    const fullReceive = time(() => { deserialize(fullWire) })
    const diff = time(() => { diffAgentThreadDetail(held, grown, 2) })
    const streamed = diffAgentThreadDetail(held, grown, 2)!
    const streamedWire = serialize(streamed)
    const streamedSend = time(() => { serialize(streamed) })
    const streamedReceive = time(() => { deserialize(streamedWire) })
    const apply = time(() => { applyAgentThreadDetailDelta(held, streamed) })

    const streamingReport = {
      thread: busiest.id.slice(0, 8), messages: held.messages.length, activities: held.activities!.length,
      full: { payloadKB: Math.round(detailBytes / 1024), produceMs: round(detailClone), serializeMs: round(fullSend),
        deserializeMs: round(fullReceive), totalMs: round(detailClone + fullSend + fullReceive) },
      delta: { payloadBytes: streamedWire.byteLength, produceMs: round(diff), serializeMs: round(streamedSend),
        deserializeMs: round(streamedReceive), applyMs: round(apply),
        totalMs: round(diff + streamedSend + streamedReceive + apply) },
    }
    console.info(`state pipeline (streaming delta): ${JSON.stringify(streamingReport)}`)
    expect(streamedWire.byteLength).toBeLessThan(detailBytes)
    expect(applyAgentThreadDetailDelta(held, streamed)!.messages.at(-1)!.text.endsWith(chunk)).toBe(true)
  })
})

function round(value: number): number { return Math.round(value * 100) / 100 }
