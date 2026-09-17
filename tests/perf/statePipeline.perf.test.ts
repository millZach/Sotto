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
import { agentStateSchema, defaultAgentConfiguration, type AgentHostSnapshot, type AgentState } from '../../src/shared/agents'
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
    pendingRequest: '', busy: false, notice: '', error: null, speech: { id: 0, text: '' },
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
    const parse = time(() => { agentStateSchema.safeParse(received) })
    const total = clone + decorate + send + receive + parse

    const report = {
      threads: state.host.threads.length, messages,
      payloadKB: Math.round(bytes / 1024), payloadWithoutPreviewsKB: Math.round(bare / 1024),
      ms: { clone: round(clone), decorate: round(decorate), serialize: round(send), deserialize: round(receive), schemaParse: round(parse), total: round(total) },
    }
    console.info(`state pipeline: ${JSON.stringify(report)}`)
    expect(report.threads).toBeGreaterThan(0)
  })
})

function round(value: number): number { return Math.round(value * 100) / 100 }
