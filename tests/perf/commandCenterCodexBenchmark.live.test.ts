// @vitest-environment node
/** Paid Codex benchmark. Never in CI; opt in with SOTTO_COMMAND_CENTER_BENCHMARK=1.
 * PowerShell: $env:SOTTO_COMMAND_CENTER_BENCHMARK='1';
 * npx vitest run tests/perf/commandCenterCodexBenchmark.live.test.ts --maxWorkers=1
 * Complete only the eight missing B cells: also set SOTTO_COMMAND_CENTER_BENCHMARK_COMPLETE=1.
 * Twenty serial, fresh threads; five minutes per send. No replies, tool arguments or protocol bodies saved.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, hostname, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import type { CodexProcess, RpcFrame } from '../../src/main/agents/codexProcess'
import type { AgentHostCommand, CommandCenterLaunchProfile } from '../../src/main/agents/host'
import type { AgentThread } from '../../src/shared/agents'
import type { ThreadUsage } from '../../src/shared/threadUsage'
import { COMMAND_CENTER_CODEX_VERSION } from '../../src/main/agents/commandCenterCodexProfile'
import { needsPerson } from '../../src/main/agents/nativeRequests'
import { clientVersionOf } from '../../src/main/agents/clientVersions'
import { commandCenterLiveFailure } from '../fixtures/commandCenterLiveProbe'
import { BenchmarkStandIns, BENCHMARK_TASKS, benchmarkKeys, createBenchmarkCopies, FILE_TOOL_NAMES, THREAD_TOOL_NAMES,
  type BenchmarkArm, type BenchmarkCopies, type BenchmarkTask, type BenchmarkToolName } from '../fixtures/commandCenterBenchmark'

const LIVE = process.env.SOTTO_COMMAND_CENTER_BENCHMARK === '1' && !process.env.CI
const COMPLETE = process.env.SOTTO_COMMAND_CENTER_BENCHMARK_COMPLETE === '1'
const OPERATION_MS = 30_000, TURN_MS = 5 * 60_000
const ARTIFACTS = join(process.cwd(), 'artifacts', 'command-center-benchmark')
const exec = promisify(execFile)
type Reason = 'client-start-failed' | 'setup-timeout' | 'setup-refused' | 'send-refused' | 'turn-failed' | 'turn-timeout' | 'request-raised' | 'profile-revoked' | 'unexpected-native-tool' | 'missing-reply' | 'missing-usage' | 'copy-changed' | 'cleanup-failed'
interface Run {
  sequence: number; task: BenchmarkTask; arm: BenchmarkArm; repetition: number; extra: boolean
  outcome: 'passed' | 'wrong-answer' | 'failed' | 'timed-out'; reason?: Reason
  wallMs: number | null; firstModelReply: boolean; keys: Record<string, boolean>
  calls: Record<BenchmarkToolName, number> & { nativeCommands: number; nativeReads: number; nativeOther: number }
  tokens: { input: number | null; output: number | null; cached: number | null }
  requests: Record<string, number>; model: string; effort: string; clientVersion: string
  usageNotifications: number; usagePartial: boolean | null; effectivePolicyVerified: boolean; toolsVerified: boolean
  setupStage?: 'connect' | 'defaults' | 'inherited' | 'projects' | 'thread' | 'tools' | 'read'
  suppliedToolCount?: number
  originalKeys?: Record<string, boolean>; originalOutcome?: Run['outcome']; rechecked?: boolean
  nativeMcpKinds?: string[]
  profile?: 'sotto-only' | 'read-only-never-isolated' | 'asking-inherited'
  replacesSequence?: number
}
interface Evidence {
  startedAt: string; completedAt?: string; sourceCommit: string; machine: { hostname: string; platform: string; release: string; cpu: string; cores: number; ramGiB: number; node: string }
  copies: { files: number; bytes: number }; freeMemoryBeforeKB: number[]; model: string; effort: string; clientVersion: string
  runs: Run[]; extraRuns: number; summary?: unknown
  firstPassRuns?: Run[]
  completion?: { startedAt: string; completedAt?: string; runs: Run[]; retries: number }
}
/** Test-only view, following the live compatibility suite's private frame interposition.
 * No product interface is widened. Never exposes a provider home or credential contents.
 */
interface ObservedHost {
  frame(server: CodexProcess, frame: RpcFrame): Promise<void>
  rpc(method: string, params: unknown, apply?: (value: unknown) => void, rejected?: undefined, target?: CodexProcess): Promise<void>
  watcher?: { stop(): void }
  options: { args?: string[] }
  runtimes: Map<string, { server: CodexProcess }>
  processes: Set<CodexProcess>
  provider?: CodexProcess
  usage: { get(id: string): ThreadUsage | undefined }
}
class BudgetError extends Error {}
async function bounded<T>(operation: Promise<T>, ms: number, abort: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_done, reject) => {
    timer = setTimeout(() => { abort(); reject(new BudgetError('Benchmark operation timed out.')) }, ms)
  })]) } finally { if (timer) clearTimeout(timer) }
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
// JSON strings are used inside TOML, never interpolated into a shell command.
function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(', ')} }`
  return JSON.stringify(value)
}
function nativeArguments(profile: Pick<CommandCenterLaunchProfile, 'server'>): string[] {
  // Ordinary host launch defaults, plus only our supplied server. A dotted override merges
  // this server into the user's configuration instead of replacing their MCP server table.
  // The public approval-required mode supplies untrusted/read-only on thread/start and turns.
  return ['app-server', '--stdio', ...Object.entries({
    model_provider: 'openai', approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
    'mcp_servers.sotto_threads': { url: profile.server.url,
      http_headers: Object.fromEntries(profile.server.headers.map(header => [header.name, header.value])),
      default_tools_approval_mode: 'approve' },
  }).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])]
}
/** The model catalog's isDefault does not survive the adapter projection, so ask the client itself. */
async function defaults(host: CodexAppServerHost): Promise<{ model: string; effort: string }> {
  const internal = host as unknown as ObservedHost, ready = (await host.snapshot()).models.filter(model => model.ready)
  const catalog: Record<string, unknown>[] = [], seen = new Set<string>()
  let cursor: string | undefined
  do {
    await internal.rpc('model/list', { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) }, value => {
      const page = object(value)
      if (!Array.isArray(page.data)) throw new Error('Benchmark model catalog unavailable.')
      catalog.push(...page.data.map(object)); cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
    })
    if (cursor) { if (seen.has(cursor)) throw new Error('Benchmark model catalog repeated a page.'); seen.add(cursor) }
  } while (cursor)
  const selected = catalog.find(model => model.isDefault === true && ready.some(item => item.id === model.model))
  if (!selected || typeof selected.model !== 'string' || typeof selected.defaultReasoningEffort !== 'string') throw new Error('Benchmark default ready model unavailable.')
  return { model: selected.model, effort: selected.defaultReasoningEffort }
}
async function freeMemory(): Promise<number> {
  const result = await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'])
  const value = Number(result.stdout.trim())
  if (!Number.isFinite(value) || value <= 0) throw new Error('Benchmark memory check unavailable.')
  return value
}
async function waitForMemory(evidence: Evidence): Promise<void> {
  while (true) {
    const available = await freeMemory(); evidence.freeMemoryBeforeKB.push(available)
    if (available >= 3 * 1_024 * 1_024) return
    console.info('Benchmark waiting for 3 GiB free memory.')
    await new Promise(done => setTimeout(done, 30_000))
  }
}
const requests = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'])
async function run(copies: BenchmarkCopies, evidence: Evidence, sequence: number, task: typeof BENCHMARK_TASKS[number], arm: BenchmarkArm, repetition: number, extra: boolean): Promise<Run> {
  const result: Run = { sequence, task: task.id, arm, repetition, extra, outcome: 'failed', wallMs: null, firstModelReply: false,
    keys: benchmarkKeys(task.id, '', [], 0), calls: { ...Object.fromEntries([...THREAD_TOOL_NAMES, ...FILE_TOOL_NAMES].map(name => [name, 0])), nativeCommands: 0, nativeReads: 0, nativeOther: 0 } as Run['calls'],
    tokens: { input: null, output: null, cached: null }, requests: {}, model: evidence.model, effort: evidence.effort, clientVersion: evidence.clientVersion,
    usageNotifications: 0, usagePartial: null, effectivePolicyVerified: false, toolsVerified: false,
    profile: arm === 'A' ? 'sotto-only' : 'asking-inherited' }
  const data = join(copies.root, `run-${sequence}`), threadId = randomUUID()
  await mkdir(data)
  let host: CodexAppServerHost | undefined, unsubscribe: (() => void) | undefined, aborted = false, started: number | undefined
  let phase: 'connect' | 'setup' | 'send' | 'turn' = 'connect', idleAt: number | undefined, latest: AgentThread | undefined
  const preserveUsage = (): void => {
    const usage = host ? (host as unknown as ObservedHost).usage.get(threadId) : undefined
    if (!usage?.total) return
    result.tokens = { input: usage.total.input ?? null, output: usage.total.output ?? null, cached: usage.total.cached ?? null }
    result.usagePartial = usage.partial
  }
  const abort = (): void => { if (aborted) return; preserveUsage(); aborted = true; host?.disconnect() }
  const failure = commandCenterLiveFailure(abort)
  const standIn = new BenchmarkStandIns(copies, threadId, arm, () => failure.reason === undefined)
  const fail = (reason: Reason): void => failure.fail(reason)
  const requireAccepted = async (command: AgentHostCommand): Promise<void> => {
    const accepted = await bounded(host!.execute(command), OPERATION_MS, abort)
    if (!accepted.accepted || accepted.uncertain) { fail(phase === 'send' ? 'send-refused' : 'setup-refused'); throw new Error('Benchmark operation refused.') }
  }
  try {
    result.setupStage = 'connect'
    await waitForMemory(evidence)
    const server = await standIn.tools.mcpServer(threadId)
    host = new CodexAppServerHost({ userDataPath: data, requestTimeoutMs: OPERATION_MS, pollIntervalMs: 250,
      commandCenterAdmissions: [{ provider: 'codex', platform: 'win32', version: COMMAND_CENTER_CODEX_VERSION, verificationNote: 'Benchmark injection only; no production admission.' }] })
    const internal = host as unknown as ObservedHost, originalFrame = internal.frame.bind(host)
    const seenTools = new Set<string>()
    internal.frame = async (from, frame) => {
      // Only a permission/question request fails B, not a user's own native MCP tool call.
      // Stop before the real handler could hold or answer the request.
      if (frame.id !== undefined && frame.method !== undefined && (requests.has(frame.method) || needsPerson(frame.method))) {
        const kind = requests.has(frame.method) ? frame.method : 'other-request'
        result.requests[kind] = (result.requests[kind] ?? 0) + 1
        fail('request-raised'); return
      }
      const params = object(frame.params), item = object(params.item)
      if (started !== undefined) {
        if (frame.method === 'thread/tokenUsage/updated') result.usageNotifications++
        if (frame.method === 'item/agentMessage/delta' || frame.method?.startsWith('item/reasoning/')
          || ['item/started', 'item/completed'].includes(frame.method ?? '') && ['agentMessage', 'reasoning', 'mcpToolCall', 'commandExecution', 'fileRead', 'fileSearch', 'directoryList', 'fileChange', 'webSearch', 'collabAgentToolCall', 'dynamicToolCall', 'codeModeToolCall'].includes(String(item.type))) result.firstModelReply = true
        if (['item/started', 'item/completed'].includes(frame.method ?? '') && typeof item.id === 'string' && !seenTools.has(item.id)) {
          const type = String(item.type)
          if (type === 'commandExecution') { seenTools.add(item.id); result.calls.nativeCommands++ }
          else if (['fileRead', 'fileSearch', 'directoryList', 'imageView'].includes(type)) { seenTools.add(item.id); result.calls.nativeReads++ }
          else if (['fileChange', 'webSearch', 'collabAgentToolCall', 'dynamicToolCall', 'codeModeToolCall'].includes(type)) { seenTools.add(item.id); result.calls.nativeOther++ }
          else if (type === 'mcpToolCall' && item.server !== 'sotto_threads') {
            seenTools.add(item.id); result.calls.nativeOther++
            // User-configured MCP servers belong to B's native tool surface too.
          }
          if (arm === 'A' && result.calls.nativeCommands + result.calls.nativeReads + result.calls.nativeOther > 0) { fail('unexpected-native-tool'); return }
        }
      }
      await originalFrame(from, frame)
      if (frame.method === 'thread/tokenUsage/updated') preserveUsage()
    }
    if (arm === 'B') {
      host.useThreadTools([{ name: server.name, definitions: standIn.tools.definitions, async mcpServer(id) { return id === threadId ? server : undefined } }])
    } else {
      const profile: CommandCenterLaunchProfile = { kind: 'command-center', server, toolNames: standIn.toolNames,
        revoke() { standIn.tools.revoke(threadId); fail('profile-revoked') } }
      host.useLaunchProfiles({ async profileFor(id) { return id === threadId ? profile : undefined } })
    }
    const initial = await bounded(host.connect(), OPERATION_MS, abort)
    // Fresh userData has no aliases, so connect's watcher observes nothing. Stop it before thread creation.
    internal.watcher?.stop(); delete internal.watcher
    if (!initial.connected) { fail('client-start-failed'); throw new Error('Benchmark client unavailable.') }
    result.clientVersion = clientVersionOf(initial.version)
    result.setupStage = 'defaults'
    const selected = await bounded(defaults(host), OPERATION_MS, abort)
    result.model = selected.model; result.effort = selected.effort
    if (!evidence.model) { evidence.model = selected.model; evidence.effort = selected.effort; evidence.clientVersion = result.clientVersion }
    if (selected.model !== evidence.model || selected.effort !== evidence.effort || result.clientVersion !== evidence.clientVersion) throw new Error('Benchmark client or defaults changed during the run.')
    phase = 'setup'
    if (arm === 'B') {
      result.setupStage = 'inherited'
      internal.options.args = nativeArguments({ server })
    }
    result.setupStage = 'projects'
    await requireAccepted({ type: 'create-project', commandId: randomUUID(), projectId: 'sotto', title: 'Sotto', path: copies.sotto })
    await requireAccepted({ type: 'create-project', commandId: randomUUID(), projectId: 'relay', title: 'Relay', path: copies.relay })
    result.setupStage = 'thread'
    await requireAccepted({ type: 'create-thread', commandId: randomUUID(), threadId, projectId: 'sotto', title: `Benchmark ${arm} ${task.id}`, modelId: selected.model, reasoningEffort: selected.effort, workingDirectory: copies.sotto, workingCopy: 'shared', ...(arm === 'B' ? { runtimeMode: 'approval-required' as const } : {}) })
    const runtime = internal.runtimes.get(threadId)
    if (!runtime) throw new Error('Benchmark runtime unavailable.')
    result.setupStage = 'tools'
    const statuses: Record<string, unknown>[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    do {
      await bounded(internal.rpc('mcpServerStatus/list', { limit: 100, ...(cursor ? { cursor } : {}) }, value => {
        const page = object(value)
        if (!Array.isArray(page.data)) throw new Error('Benchmark tool status unavailable.')
        statuses.push(...page.data.map(object)); cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined
      }, undefined, runtime.server), OPERATION_MS, abort)
      if (cursor) { if (cursors.has(cursor)) throw new Error('Benchmark tool status repeated a page.'); cursors.add(cursor) }
    } while (cursor)
    const supplied = statuses.filter(status => status.name === 'sotto_threads')
    const actualNames = Object.values(object(supplied[0]?.tools)).map(value => String(object(value).name).replace(/^mcp__sotto_threads__/u, ''))
    result.suppliedToolCount = actualNames.length
    result.toolsVerified = supplied.length === 1 && actualNames.length === standIn.toolNames.length && standIn.toolNames.every(name => actualNames.includes(name))
      && (arm === 'B' || statuses.every(status => status.name === 'sotto_threads' || Object.keys(object(status.tools)).length === 0))
    if (!result.toolsVerified) throw new Error('Benchmark tool catalog did not match.')
    // The adapter validated thread/start's effective policy; also check the protocol directly.
    result.setupStage = 'read'
    await bounded(internal.rpc('thread/read', { threadId: (host as unknown as { aliases: Record<string, { codexThreadId: string }> }).aliases[threadId]!.codexThreadId, includeTurns: false }, () => undefined, undefined, runtime.server), OPERATION_MS, abort)
    result.effectivePolicyVerified = true
    if (process.env.SOTTO_COMMAND_CENTER_BENCHMARK_SETUP_ONLY === '1') { result.outcome = 'passed'; return result }
    unsubscribe = host.subscribe(snapshot => {
      const thread = snapshot.threads.find(item => item.id === threadId)
      if (!thread) return
      latest = thread
      if (thread.requests.length) { result.requests['projected-request'] = thread.requests.length; fail('request-raised') }
      if (started !== undefined && thread.status === 'idle' && thread.lastTurn?.status === 'completed' && idleAt === undefined) idleAt = performance.now()
    })
    phase = 'send'; started = performance.now()
    const turn = async (): Promise<void> => {
      await requireAccepted({ type: 'send', commandId: randomUUID(), messageId: randomUUID(), threadId, text: standIn.context(copies, selected.model, selected.effort) + task.prompt })
      phase = 'turn'
      while (!failure.reason) {
        const snapshot = await host!.snapshot(), thread = snapshot.threads.find(item => item.id === threadId)
        if (thread) latest = thread
        if (thread?.status === 'idle' && thread.lastTurn?.status === 'completed') { idleAt ??= performance.now(); return }
        await new Promise(done => setTimeout(done, 100))
      }
    }
    await bounded(turn(), TURN_MS, () => fail('turn-timeout'))
    if (failure.reason) throw new Error('Benchmark turn failed.')
    result.wallMs = Math.round((idleAt ?? performance.now()) - started)
    const reply = latest?.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? ''
    result.keys = benchmarkKeys(task.id, reply, standIn.starts, standIn.calls.start_thread)
    if (!reply) fail('missing-reply')
    const total = latest?.usage?.total
    result.tokens = { input: total?.input ?? null, output: total?.output ?? null, cached: total?.cached ?? null }
    result.usagePartial = latest?.usage?.partial ?? null
    if (!result.usageNotifications || Object.values(result.tokens).some(value => value === null)) fail('missing-usage')
    result.outcome = failure.reason ? 'failed' : Object.values(result.keys).every(Boolean) ? 'passed' : 'wrong-answer'
  } catch (error) {
    if (!failure.reason) fail(error instanceof BudgetError ? phase === 'connect' || phase === 'setup' ? 'setup-timeout' : 'turn-timeout' : phase === 'connect' ? 'client-start-failed' : phase === 'setup' ? 'setup-refused' : 'turn-failed')
    if (started !== undefined) result.wallMs ??= Math.round(performance.now() - started)
    result.outcome = failure.reason === 'turn-timeout' ? 'timed-out' : 'failed'
  } finally {
    if (failure.reason) result.reason = failure.reason as Reason
    preserveUsage()
    for (const name of [...THREAD_TOOL_NAMES, ...FILE_TOOL_NAMES]) result.calls[name] = standIn.calls[name]
    unsubscribe?.()
    try { host?.disconnect(); if (host) await bounded(host.closed(), OPERATION_MS, abort); await standIn.tools.close() }
    catch { result.reason ??= 'cleanup-failed'; result.outcome = 'failed' }
    try { await copies.assertUnchanged() }
    catch { result.reason ??= 'copy-changed'; result.outcome = 'failed' }
  }
  return result
}
function measure(values: (number | null)[]): { median: number | null; min: number | null; max: number | null } {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
  if (!sorted.length) return { median: null, min: null, max: null }
  const middle = Math.floor(sorted.length / 2)
  return { median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2, min: sorted[0]!, max: sorted.at(-1)! }
}
function summarize(runs: Run[]): unknown {
  const summary = (selected: Run[]) => ({ n: selected.length, passed: selected.filter(run => run.outcome === 'passed').length,
    completed: selected.filter(run => run.outcome === 'passed' || run.outcome === 'wrong-answer').length,
    // A stop-to-request duration is never a send-to-idle observation.
    timeMs: measure(selected.filter(run => run.outcome === 'passed' || run.outcome === 'wrong-answer').map(run => run.wallMs)),
    stoppedTimeMs: measure(selected.filter(run => run.outcome === 'failed' || run.outcome === 'timed-out').map(run => run.wallMs)),
    calls: Object.fromEntries(Object.keys(selected[0]?.calls ?? {}).map(kind => [kind, measure(selected.map(run => run.calls[kind as keyof Run['calls']]))])),
    tokens: Object.fromEntries((['input', 'output', 'cached'] as const).map(kind => [kind, measure(selected.map(run => run.tokens[kind]))])),
    keys: Object.fromEntries([...new Set(selected.flatMap(run => Object.keys(run.keys)))].map(key => [key, { passed: selected.filter(run => run.keys[key] === true).length, total: selected.filter(run => key in run.keys).length }])) })
  return Object.fromEntries((['A', 'B'] as const).map(arm => [arm, { overall: summary(runs.filter(run => run.arm === arm)), tasks: Object.fromEntries(BENCHMARK_TASKS.map(task => [task.id, summary(runs.filter(run => run.arm === arm && run.task === task.id))])) }]))
}

/** Exercise the stand-in bounds before charging a model turn. These calls are not benchmark runs. */
async function preflight(copies: BenchmarkCopies): Promise<void> {
  const id = randomUUID(), standIn = new BenchmarkStandIns(copies, id, 'A', () => true)
  const project = { hostId: '00000000-0000-4000-8000-000000000001', projectId: 'sotto' }
  const call = async (name: BenchmarkToolName, args: unknown): Promise<Record<string, unknown>> => {
    const result = await standIn.tools.call(id, name, args)
    const content = result.content[0]
    expect(result.isError).not.toBe(true)
    if (!content || content.type !== 'text') throw new Error('Benchmark preflight returned no result.')
    return object(JSON.parse(content.text))
  }
  try {
    expect((await call('list_threads', {})).rows).toHaveLength(8)
    expect((await call('read_thread', { target: { hostId: project.hostId, threadId: 'android-storage' } })).messages).toHaveLength(2)
    for (const path of ['../AGENTS.md', copies.sotto, 'C:/outside', 'file:stream', '.env', '.env.local', 'private.pem', 'id_dsa', 'private.ppk', '.git/config', 'node_modules/example', 'out/example', 'release/example', 'artifacts/example']) {
      expect((await call('read_project_file', { project, path })).status).toBe('refused')
    }
    expect((await call('read_project_file', { project, path: 'src/shared/settings.ts', lineLimit: 201 })).status).toBe('refused')
    const read = await call('read_project_file', { project, path: 'src/shared/settings.ts' })
    expect(read.status).toBe('ok'); expect(String(read.text).split('\n').length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(JSON.stringify(read), 'utf8')).toBeLessThanOrEqual(64 * 1_024)
    const search = await call('search_project_files', { project, text: 'Codex stopped before this reply finished', directory: 'src/main/agents', limit: 1 })
    expect(search.status).toBe('ok'); expect(search.matches).toHaveLength(1)
    expect((search.matches as { path: string }[])[0]?.path).toBe('src/main/agents/codex.ts')
    const files = await call('list_project_files', { project, directory: 'src/main/agents', limit: 2 })
    expect(files.entries).toHaveLength(2); expect(files.nextCursor).not.toBeNull()
    expect(benchmarkKeys('across', 'Sotto does not declare zod as a runtime dependency in package.json. Its settings are in src/shared/settings.ts. Relay has no runtime dependencies, and its configuration is in src/config.ts.', [], 0).sottoZod).toBe(false)
    expect(benchmarkKeys('across', 'Sotto declares zod as a runtime dependency in package.json; settings are in src/shared/settings.ts. Relay has no runtime dependencies; configuration is in src/config.ts.', [], 0).sottoZod).toBe(true)
    expect(benchmarkKeys('across', 'Sotto declares zod in package.json; settings are in src/shared/settings.ts. Relay does not use Python. It declares zod; configuration is in src/config.ts.', [], 0).relayNoZod).toBe(false)
    expect(benchmarkKeys('roster', 'Choose Android storage needs you. PR #42 is ready for review.', [], 0).readyPullRequest).toBe(true)
  } finally { await standIn.tools.close() }
}

it.skipIf(!LIVE || COMPLETE || process.env.SOTTO_COMMAND_CENTER_BENCHMARK_RECHECK === '1')('benchmarks twenty command-center Codex turns with and without native code tools', async () => {
  expect(process.platform).toBe('win32')
  const copies = await createBenchmarkCopies()
  let evidence: Evidence = { startedAt: new Date().toISOString(), sourceCommit: copies.sourceCommit,
    machine: { hostname: hostname(), platform: process.platform, release: release(), cpu: cpus()[0]?.model ?? '', cores: cpus().length, ramGiB: totalmem() / 1_024 ** 3, node: process.version },
    copies: { files: copies.files, bytes: copies.bytes }, freeMemoryBeforeKB: [], model: '', effort: '', clientVersion: '', runs: [], extraRuns: 0 }
  const save = async (): Promise<void> => {
    await mkdir(ARTIFACTS, { recursive: true })
    // Explicit numeric/enum evidence only: no replies, worker arguments, headers, account or frames.
    await writeFile(join(ARTIFACTS, 'results.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  }
  const retryable: Run[] = []
  try {
    await preflight(copies)
    if (process.env.SOTTO_COMMAND_CENTER_BENCHMARK_SETUP_ONLY === '1') {
      const setup = await run(copies, evidence, 1, BENCHMARK_TASKS[0], 'B', 1, false)
      await mkdir(ARTIFACTS, { recursive: true })
      await writeFile(join(ARTIFACTS, 'setup.json'), JSON.stringify(setup, null, 2) + '\n')
    expect(setup.outcome, `Benchmark B setup at ${setup.setupStage}; supplied tool count ${setup.suppliedToolCount ?? 0}.`).toBe('passed')
      return
    }
    // Explicit recovery after an interrupted process; retain every completed attempt and key failure.
    if (process.env.SOTTO_COMMAND_CENTER_BENCHMARK_RESUME === '1') {
      const previous = JSON.parse(await readFile(join(ARTIFACTS, 'results.json'), 'utf8')) as Evidence
      if (previous.sourceCommit !== copies.sourceCommit || previous.machine.hostname !== evidence.machine.hostname) throw new Error('Benchmark resume refused different source or machine.')
      evidence = previous
      delete evidence.completedAt; delete evidence.summary
    }
    let sequence = 0
    for (let index = 0; index < BENCHMARK_TASKS.length; index++) {
      const task = BENCHMARK_TASKS[index]!
      // ABBA, then BAAB: arms stay balanced across first/second runs and adjacent task boundaries.
      const arms: BenchmarkArm[] = index % 2 === 0 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B']
      const repetitions = { A: 0, B: 0 }
      for (const arm of arms) {
        const current = ++sequence, repetition = ++repetitions[arm]
        const previous = evidence.runs.find(run => run.sequence === current && !run.extra)
        if (previous) continue
        const result = await run(copies, evidence, current, task, arm, repetition, false)
        evidence.runs.push(result)
        if (result.reason === 'client-start-failed' || !result.firstModelReply && (result.reason === 'turn-timeout' || result.reason === 'setup-timeout')) retryable.push(result)
        await save()
        console.info(`Benchmark run ${sequence}/20 ${arm} ${task.id}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}.`)
        if (result.reason === 'copy-changed' || result.reason === 'cleanup-failed') throw new Error('Benchmark copy or process cleanup failed; stopped.')
      }
    }
    // Never retry a wrong answer, request, model failure, or timeout after any model output.
    for (const original of process.env.SOTTO_COMMAND_CENTER_BENCHMARK_NO_EXTRAS === '1' ? [] : retryable.slice(0, 4 - evidence.extraRuns)) {
      const task = BENCHMARK_TASKS.find(task => task.id === original.task)!
      evidence.extraRuns++
      evidence.runs.push(await run(copies, evidence, ++sequence, task, original.arm, original.repetition, true)); await save()
      console.info(`Benchmark infrastructure extra run ${evidence.extraRuns}/4 completed.`)
    }
    evidence.summary = summarize(evidence.runs)
    evidence.completedAt = new Date().toISOString(); await save()
    expect(evidence.runs.filter(run => !run.extra)).toHaveLength(20)
  } finally {
    if (process.env.SOTTO_COMMAND_CENTER_BENCHMARK_SETUP_ONLY !== '1') await save()
    await copies.close()
  }
}, 150 * 60_000)

/** Preserve A and the two graded B briefs. Keep every superseded attempt as numeric history.
 * Eight replacements in the original B order, at most two client-start retries; never retry a
 * harness failure, request, timeout or wrong answer. An interrupted invocation consumes its saved budget.
 */
it.skipIf(!LIVE || !COMPLETE)('completes the eight ungraded B trials with asking mode and inherited tools', async () => {
  const evidence = JSON.parse(await readFile(join(ARTIFACTS, 'results.json'), 'utf8')) as Evidence
  expect(evidence.machine.hostname).toBe(hostname())
  expect(evidence.runs).toHaveLength(20)
  if (!evidence.firstPassRuns) {
    evidence.firstPassRuns = structuredClone(evidence.runs)
    for (const original of evidence.firstPassRuns) original.profile = original.arm === 'A' ? 'sotto-only' : 'read-only-never-isolated'
  }
  const originals = evidence.firstPassRuns.filter(run => run.arm === 'B' && run.task !== 'brief').sort((a, b) => a.sequence - b.sequence)
  expect(originals).toHaveLength(8)
  expect(originals.every(run => run.outcome === 'failed')).toBe(true)
  evidence.completion ??= { startedAt: new Date().toISOString(), runs: [], retries: 0 }
  const completion = evidence.completion, copies = await createBenchmarkCopies(evidence.sourceCommit)
  const save = async (): Promise<void> => {
    evidence.summary = summarize(evidence.runs)
    await writeFile(join(ARTIFACTS, 'results.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  }
  const attempt = async (original: Run, extra: boolean): Promise<Run> => {
    const sequence = 21 + completion.runs.length
    const task = BENCHMARK_TASKS.find(task => task.id === original.task)!
    const result = await run(copies, evidence, sequence, task, 'B', original.repetition, extra)
    result.replacesSequence = original.sequence
    completion.runs.push(result)
    const slot = evidence.runs.findIndex(run => (run.replacesSequence ?? run.sequence) === original.sequence)
    if (slot < 0) throw new Error('Benchmark completion lost its scheduled cell.')
    evidence.runs[slot] = result
    await save()
    console.info(`Benchmark completion run ${completion.runs.length}: B ${task.id} ${result.outcome}${result.reason ? ` (${result.reason})` : ''}.`)
    if (result.reason === 'copy-changed' || result.reason === 'cleanup-failed') throw new Error('Benchmark copy or process cleanup failed; stopped.')
    return result
  }
  try {
    await preflight(copies)
    for (const original of originals) {
      if (!completion.runs.some(run => run.replacesSequence === original.sequence && !run.extra)) await attempt(original, false)
    }
    // Consume retries only for a client that never started, including a retry of that same failure.
    while (completion.retries < 2) {
      const failed = evidence.runs.find(run => run.replacesSequence !== undefined && run.reason === 'client-start-failed')
      if (!failed) break
      completion.retries++
      await attempt(originals.find(run => run.sequence === failed.replacesSequence)!, true)
    }
    completion.completedAt = new Date().toISOString()
    evidence.completedAt = completion.completedAt
    expect(completion.runs.filter(run => !run.extra)).toHaveLength(8)
    expect(completion.runs.filter(run => run.extra)).toHaveLength(completion.retries)
    const preserved = evidence.firstPassRuns.filter(run => run.arm === 'A' || run.task === 'brief').map(original => {
      const copy = { ...original }; delete copy.profile; return copy
    })
    expect(evidence.runs.filter(run => run.arm === 'A' || run.task === 'brief')).toEqual(preserved)
  } finally { await save(); await copies.close() }
}, 65 * 60_000)

/** Recheck stored native answers through the client, without a model turn or direct session-file reads.
 * Replies remain in this callback only. Original grades are retained so a scorer fix is visible.
 */
it.skipIf(!LIVE || process.env.SOTTO_COMMAND_CENTER_BENCHMARK_RECHECK !== '1')('verifies benchmark keys through Codex protocol without sending prompts', async () => {
  const evidence = JSON.parse(await readFile(join(ARTIFACTS, 'results.json'), 'utf8')) as Evidence
  const identities = JSON.parse(await readFile(join(ARTIFACTS, 'identities.json'), 'utf8')) as Record<string, { sottoId: string; nativeId: string }>
  const data = await mkdtemp(join(tmpdir(), 'sotto-command-center-key-check-'))
  const host = new CodexAppServerHost({ userDataPath: data, requestTimeoutMs: OPERATION_MS })
  const internal = host as unknown as ObservedHost, originalFrame = internal.frame.bind(host)
  internal.frame = async (server, frame) => {
    if (frame.id !== undefined && frame.method !== undefined) { host.disconnect(); throw new Error('Protocol key check raised a request; nothing answered.') }
    await originalFrame(server, frame)
  }
  const cleanup = async (): Promise<void> => {
    if (dirname(resolve(data)) !== resolve(tmpdir()) || !data.split(/[\\/]/u).at(-1)?.startsWith('sotto-command-center-key-check-')) throw new Error('Key-check cleanup refused unexpected folder.')
    await rm(data, { recursive: true, force: true })
  }
  try {
    await bounded(host.connect(), OPERATION_MS, () => host.disconnect())
    internal.watcher?.stop(); delete internal.watcher
    // A recovery helper for the last completed thread when cleanup won the metadata capture race.
    if (process.env.SOTTO_COMMAND_CENTER_BENCHMARK_RECOVER_LAST_CWD && !identities['20']) {
      const cwd = process.env.SOTTO_COMMAND_CENTER_BENCHMARK_RECOVER_LAST_CWD
      await bounded(internal.rpc('thread/list', { limit: 100, sortKey: 'created_at', sortDirection: 'desc' }, value => {
        const data = object(value).data
        if (!Array.isArray(data)) throw new Error('Protocol thread metadata unavailable.')
        const found = data.map(object).find(thread => thread.cwd === cwd)
        if (typeof found?.id !== 'string') throw new Error('Last benchmark thread metadata unavailable.')
        identities['20'] = { sottoId: 'protocol-key-check-only', nativeId: found.id }
      }), OPERATION_MS, () => host.disconnect())
    }
    for (const run of evidence.runs) {
      const identity = identities[String(run.sequence)]
      if (!identity || run.wallMs === null || run.task === 'brief') continue
      await bounded(internal.rpc('thread/read', { threadId: identity.nativeId, includeTurns: true }, value => {
        const thread = object(object(value).thread), turns = Array.isArray(thread.turns) ? thread.turns.map(object) : []
        const items = turns.flatMap(turn => Array.isArray(turn.items) ? turn.items.map(object) : [])
        const reply = items.filter(item => item.type === 'agentMessage' && typeof item.text === 'string').at(-1)?.text
        run.nativeMcpKinds = [...new Set(items.filter(item => item.type === 'mcpToolCall').map(item => String(item.server)).filter(name => /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/u.test(name)))]
        if (typeof reply !== 'string' || run.outcome === 'failed' || run.outcome === 'timed-out') return
        run.originalKeys ??= run.keys; run.originalOutcome ??= run.outcome
        run.keys = benchmarkKeys(run.task, reply, [], 0)
        run.outcome = Object.values(run.keys).every(Boolean) ? 'passed' : 'wrong-answer'; run.rechecked = true
      }, undefined, internal.provider), OPERATION_MS, () => host.disconnect())
    }
    evidence.summary = summarize(evidence.runs)
    await writeFile(join(ARTIFACTS, 'results.json'), JSON.stringify(evidence, null, 2) + '\n')
  } finally {
    host.disconnect(); await bounded(host.closed(), OPERATION_MS, () => host.disconnect())
    await cleanup()
  }
}, 5 * 60_000)
