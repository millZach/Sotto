// @vitest-environment node
/**
 * Send to first words (#763). Drives a `manual-send` the way the Threads page does: through the host service and
 * the coordinator, the workspace host with `connectCheckpoints` wired in as the app wires it, Git status as the app
 * reads it, and the real Claude and Codex adapters over the fake clients in `tests/fixtures/`, each scripted to
 * answer every prompt at once. The thread works in a real Git working copy whose size is set here: a small one, and
 * one past the 64 MiB checkpoint limit shaped like this repository (3,843 files, 278 MiB).
 *
 * Each send's turn record says how long each step took (`SendStageTimings`); this reports their medians, the
 * median time to the provider hearing the prompt (admission, the read, the workspace and the adapter) and to the
 * first streamed words (those, the acknowledgement and the first output), and, measured from outside, the time to
 * the first reply text in the state the window is sent. It counts thread reads (the adapter's `refreshThread`),
 * Git processes and atomic store writes per send: up to the moment the prompt is written, and over the whole send
 * until the reply has finished. Counters, sizes and timers only; every prompt, reply and file is filler.
 *
 * It asserts no time, so it runs only under `SOTTO_PERF_BENCH=1` (`tests/fixtures/perfBench.ts`):
 *
 *   SOTTO_PERF_BENCH=1 npx vitest run tests/perf/sendToFirstWords.perf.test.ts --maxWorkers=1 --disable-console-intercept
 *
 * `SOTTO_PERF_LARGE_FILES` and `SOTTO_PERF_LARGE_MIB` change the large working copy (defaults 3843 and 278);
 * `SOTTO_PERF_SENDS` the number of timed sends after the first (default 7).
 */
import { initializeGitRepository } from '../fixtures/gitRepository'
import { testCredentials } from '../fixtures/testCredentials'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { threadSummaryOf, type AgentCommand, type AgentState, type ProviderId } from '../../src/shared/agents'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { SEND_STAGE_FIELDS, SendStageClock, type SendStageMark } from '../../src/main/agents/sendStages'
import type { TurnRecord } from '../../src/main/agents/turns'
import { AtomicJsonStore } from '../../src/main/storage/atomicJsonStore'
import { connectCheckpoints } from '../../src/main/tools/checkpointIntegration'
import { FilesService } from '../../src/main/files/service'
import { claudeFixture } from '../fixtures/claudeFixture'
import { codexFixture } from '../fixtures/codexFixture'
import { median, PERF_BENCH, round } from '../fixtures/perfBench'

/** Every Git process anything in the send path starts, counted where it is started. */
const counted = vi.hoisted(() => ({ git: 0 }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify: promisified } = await import('node:util')
  const isGit = (command: unknown): boolean => typeof command === 'string' && /(^|[\\/])git(\.exe)?$/iu.test(command)
  const spawn = ((...args: Parameters<typeof actual.spawn>) => { if (isGit(args[0])) counted.git++; return actual.spawn(...args) }) as typeof actual.spawn
  const execFile = ((...args: Parameters<typeof actual.execFile>) => { if (isGit(args[0])) counted.git++; return actual.execFile(...args) }) as typeof actual.execFile
  const custom = (actual.execFile as unknown as Record<symbol, (...args: unknown[]) => unknown>)[promisified.custom]!
  Object.assign(execFile, { [promisified.custom]: (...args: unknown[]) => { if (isGit(args[0])) counted.git++; return custom(...args) } })
  return { ...actual, spawn, execFile }
})

const SENDS = Number(process.env.SOTTO_PERF_SENDS ?? 7)
const LARGE = { files: Number(process.env.SOTTO_PERF_LARGE_FILES ?? 3843), mib: Number(process.env.SOTTO_PERF_LARGE_MIB ?? 278) }
const SIZES = [{ name: 'small', files: 50, mib: 1 }, { name: 'large', ...LARGE }] as const
const PROVIDERS = ['claude', 'codex'] as const satisfies readonly ProviderId[]
const PROMPT = 'Synthetic prompt'
const REPLY = 'Synthetic reply'

/** Fill `root` with a Git working copy of `files` committed filler files totalling about `mib` MiB, a hundred to a folder. */
async function workingCopy(root: string, files: number, mib: number): Promise<void> {
  const each = Math.max(1, Math.floor(mib * 1024 * 1024 / files))
  const line = 'Filler text for a send benchmark working copy.\n'
  const body = line.repeat(Math.ceil(each / line.length)).slice(0, each)
  for (let index = 0; index < files; index++) {
    const folder = join(root, `folder-${Math.floor(index / 100)}`)
    if (index % 100 === 0) await mkdir(folder, { recursive: true })
    // A header per file, so no two files are the same blob.
    await writeFile(join(folder, `file-${index}.txt`), `${index}\n${body}`)
  }
  await initializeGitRepository(root, { files: {}, message: 'Filler', identity: { name: 'Sotto benchmark', email: 'benchmark@example.invalid' } })
}

interface Counts { reads: number; git: number; writes: number; stores: Record<string, number>; checkpointMs: number }
const counts = (): Counts => ({ reads: 0, git: 0, writes: 0, stores: {}, checkpointMs: 0 })
/** What one send costs: the whole send, and the part before its prompt was written. */
let whole = counts()
let beforeWritten: Counts | undefined

function instrument(): void {
  const write = AtomicJsonStore.prototype.write
  vi.spyOn(AtomicJsonStore.prototype, 'write').mockImplementation(function (this: AtomicJsonStore<unknown>, value: unknown) {
    whole.writes++
    const store = basename((this as unknown as { filePath: string }).filePath)
    whole.stores[store] = (whole.stores[store] ?? 0) + 1
    return write.call(this, value)
  })
  const mark = SendStageClock.prototype.mark
  vi.spyOn(SendStageClock.prototype, 'mark').mockImplementation(function (this: SendStageClock, name: SendStageMark) {
    if (name === 'written' && !beforeWritten) beforeWritten = { ...whole, git: counted.git, stores: { ...whole.stores } }
    return mark.call(this, name)
  })
}

type Sample = { hearsMs: number; firstWordsMs: number; seenMs: number; commandMs: number; stages: TurnRecord['timings']; whole: Counts; beforeWritten: Counts }

async function bench(provider: typeof PROVIDERS[number], repository: string): Promise<{ first: Sample; samples: Sample[] }> {
  const f = provider === 'claude' ? await claudeFixture(undefined, 15_000) : await codexFixture(undefined, false, 15_000)
  // Count every read of the provider's thread, from the coordinator, the workspace, the checkpoint or the adapter itself.
  const adapter = f.adapter as unknown as { refreshThread: (...args: unknown[]) => Promise<unknown> }
  const refresh = adapter.refreshThread.bind(adapter)
  adapter.refreshThread = (...args: unknown[]) => { whole.reads++; return refresh(...args) }
  const credentials = await testCredentials(join(f.root, 'vault'), { mode: 'unavailable' })
  const runtime = await createAgentRuntime({
    directory: f.root, credentials, settings: () => DEFAULT_SETTINGS, writingSettings: async () => DEFAULT_SETTINGS,
    historyEnabled: () => true, coordinatorEnabled: () => false, openExternal: async () => undefined, reasoner: e2eAgentReasoner,
    providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost(), [provider]: f.adapter },
    gitStatus: { fetchIntervalMs: () => DEFAULT_SETTINGS.gitFetchIntervalSeconds * 1000, foreground: () => true },
  })
  // The checkpoint taken before the turn, timed inside the workspace's preparation.
  const setHooks = runtime.agentHost.setCheckpointHooks.bind(runtime.agentHost)
  runtime.agentHost.setCheckpointHooks = hooks => setHooks({ ...hooks, beforeTurn: async threadId => {
    const startedAt = performance.now()
    try { await hooks.beforeTurn(threadId) } finally { whole.checkpointMs += performance.now() - startedAt }
  } })
  // As `src/main/index.ts` wires them.
  const files = new FilesService({ resolveBinding: id => runtime.agentControl.filesBinding(id), copyPath: async () => undefined, reveal: () => undefined })
  const checkpoints = connectCheckpoints({ historyEnabled: () => true, files, directory: f.root, host: runtime.agentHost, control: runtime.agentControl,
    registry: runtime.threadRegistry, report: () => undefined })
  runtime.agentHost.setMutationGuard(checkpoints.canMutate)
  const client = desktopWindowClient('send-benchmark')
  const command = async (value: AgentCommand): Promise<AgentState> => {
    const state = await runtime.hostService.command(value, client)
    expect(state.error).toBeNull()
    return state
  }
  try {
    await command({ type: 'configure', patch: { provider, enabledProviders: [provider] } })
    await command({ type: 'connect', provider })
    const project = (await command({ type: 'create-project', provider, title: 'Benchmark', path: repository, useExisting: true }))
      .host.projects.find(item => resolve(item.path) === resolve(repository))!
    const modelId = runtime.agentControl.get().host.models.find(model => model.providerId === provider)!.id
    const threadId = randomUUID()
    await command({ type: 'create-thread', threadId, projectId: project.id, title: 'Benchmark', modelId, workingCopy: 'shared', managed: false })
    await command({ type: 'observe-threads', threadIds: [threadId] })
    await writeFile(join(f.root, 'script.json'), JSON.stringify({ reply: REPLY }))
    const thread = () => runtime.agentControl.get().host.threads.find(item => item.id === threadId)!
    const send = async (): Promise<Sample> => {
      const records = (await runtime.turns.recent(1_000)).length
      const before = threadSummaryOf(thread()).lastAssistant?.id
      let seenAt: number | undefined
      let finishedShown = false
      const unsubscribe = runtime.agentControl.subscribe(state => {
        const shown = state.host.threads.find(item => item.id === threadId)
        if (seenAt === undefined && shown && threadSummaryOf(shown).lastAssistant?.id !== before) seenAt = performance.now()
        if (seenAt !== undefined && shown?.status === 'idle' && shown.lastTurn && shown.lastTurn.status !== 'running') finishedShown = true
      })
      whole = counts(); beforeWritten = undefined; counted.git = 0
      const startedAt = performance.now()
      try {
        await command({ type: 'manual-send', threadId, text: PROMPT })
        const commandMs = performance.now() - startedAt
        // Finished when the reply is over, its record is written and the window has been sent the reply and its end.
        await expect.poll(async () => thread().status === 'idle' && finishedShown && (await runtime.turns.recent(1_000)).length > records,
          { timeout: 120_000, interval: 10 }).toBe(true)
        // The checkpoint that completes this turn was queued when its end was published; it is part of this send,
        // and the next send's checkpoint would otherwise wait behind it.
        await checkpoints.checkpoints.afterTurn(threadId)
        const [record] = await runtime.turns.recent(1)
        expect(record?.commandType).toBe('manual-send')
        const t = record!.timings
        // A step the send did not time fails the run rather than shortening the headline figures.
        const timed = (ms: number | null | undefined, step: string): number => { if (ms === null || ms === undefined) throw new Error(`The ${step} step was not timed.`); return ms }
        const hearsMs = timed(t.admissionMs, 'admission') + timed(t.readBeforeSendMs, 'read') + timed(t.preparationMs, 'preparation') + timed(t.adapterMs, 'adapter')
        return { hearsMs, firstWordsMs: hearsMs + timed(t.acknowledgementMs, 'acknowledgement') + timed(t.firstOutputMs, 'first output'), seenMs: (seenAt ?? Number.NaN) - startedAt, commandMs,
          stages: t, whole: { ...whole, git: counted.git }, beforeWritten: beforeWritten ?? counts() }
      } finally { unsubscribe() }
    }
    // The first send starts the provider's session; it is reported apart from the rest. Each send starts once the
    // one before it, its record and its completing checkpoint have finished.
    const first = await send()
    const samples: Sample[] = []
    for (let index = 0; index < SENDS; index++) samples.push(await send())
    return { first, samples }
  } finally {
    checkpoints.dispose()
    await runtime.close()
    await f.cleanup()
  }
}

const figures = (sample: Sample) => ({ hearsMs: round(sample.hearsMs), firstWordsMs: round(sample.firstWordsMs), seenMs: round(sample.seenMs), commandMs: round(sample.commandMs),
  ...Object.fromEntries(SEND_STAGE_FIELDS.map(field => [field, sample.stages[field]])), whole: sample.whole, beforeWritten: sample.beforeWritten })
/** A per-send count: its median, and its least and most, since some reads and writes race the reply. */
const spread = (values: number[]) => ({ median: median(values), min: Math.min(...values), max: Math.max(...values) })
const medians = (samples: readonly Sample[]) => ({
  hearsMs: round(median(samples.map(sample => sample.hearsMs))),
  firstWordsMs: round(median(samples.map(sample => sample.firstWordsMs))),
  seenMs: round(median(samples.map(sample => sample.seenMs))),
  commandMs: round(median(samples.map(sample => sample.commandMs))),
  ...Object.fromEntries(SEND_STAGE_FIELDS.map(field => [field, round(median(samples.map(sample => sample.stages[field] ?? Number.NaN)))])),
  checkpointBeforeTurnMs: round(median(samples.map(sample => sample.whole.checkpointMs))),
  threadReads: spread(samples.map(sample => sample.whole.reads)), threadReadsBeforeWritten: spread(samples.map(sample => sample.beforeWritten.reads)),
  gitProcesses: spread(samples.map(sample => sample.whole.git)), gitProcessesBeforeWritten: spread(samples.map(sample => sample.beforeWritten.git)),
  storeWrites: spread(samples.map(sample => sample.whole.writes)), storeWritesBeforeWritten: spread(samples.map(sample => sample.beforeWritten.writes)),
  storeWritesByFile: samples.at(-1)!.whole.stores, storeWritesBeforeWrittenByFile: samples.at(-1)!.beforeWritten.stores,
})

describe.skipIf(!PERF_BENCH)("Send to first words (timing benchmark; requires SOTTO_PERF_BENCH=1)", () => {
  const repositories = new Map<string, string>()
  beforeAll(async () => {
    instrument()
    for (const size of SIZES) {
      // Held before it is filled, so a failure part-way still removes it.
      const root = await mkdtemp(join(tmpdir(), `sotto-perf-repo-${size.name}-`))
      repositories.set(size.name, root)
      await workingCopy(root, size.files, size.mib)
    }
  }, 600_000)
  afterAll(async () => {
    vi.restoreAllMocks()
    for (const root of repositories.values()) {
      if (dirname(root) !== tmpdir() || !root.includes('sotto-perf-repo-')) throw new Error('Unexpected benchmark directory')
      await rm(root, { recursive: true, force: true })
    }
  }, 600_000)

  for (const size of SIZES) {
    for (const provider of PROVIDERS) {
      it(`${provider}, ${size.name} working copy`, async () => {
        const { first, samples } = await bench(provider, repositories.get(size.name)!)
        console.info(`send to first words: ${JSON.stringify({ provider, workingCopy: { files: size.files, mib: size.mib }, sends: samples.length,
          median: medians(samples), first: figures(first) })}`)
      }, 1_200_000)
    }
  }
})
