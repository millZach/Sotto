// @vitest-environment node
// SOTTO_COMMAND_CENTER_LIVE=1 SOTTO_COMMAND_CENTER_PROVIDER=codex|claude|grok npx vitest run tests/integration/commandCenterOwnToolsLive.test.ts
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readdir, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { ClaudeStreamJsonHost } from '../../src/main/agents/claude'
import { GrokAcpHost } from '../../src/main/agents/grok'
import { CommandCenterLaunchProfiles } from '../../src/main/agents/commandCenterLaunchProfiles'
import { ThreadToolServer } from '../../src/main/agents/threadToolServer'
import type { AgentHost } from '../../src/main/agents/host'
import type { AgentHostSnapshot, AgentThread } from '../../src/shared/agents'
import { commandCenterToolSchemas, emptyCommandCenterRecord } from '../../src/shared/commandCenter'
import { interruptCommandCenterLiveTurn, observeCommandCenterLivePermissionAnswers } from '../fixtures/commandCenterLiveInterrupt'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import { commandCenterNativeReadProof } from '../fixtures/commandCenterNativeReadProof'
import { commandCenterGrokSearchProof } from '../fixtures/commandCenterGrokSearchProof'
import { recoverCommandCenterLiveCodex } from '../fixtures/commandCenterLiveRecovery'
import { CODEX_SANDBOX_WRITE_DENIED, codexSandboxWriteProbe } from '../../src/main/agents/commandCenterCodexSandbox'

const provider = process.env.SOTTO_COMMAND_CENTER_PROVIDER
const enabled = process.env.SOTTO_COMMAND_CENTER_LIVE === '1' && !process.env.CI && ['codex', 'claude', 'grok'].includes(provider ?? '')
const PREFIX = 'sotto-command-center-own-tools-'
const SENTINEL = 'SENTINEL_UNCHANGED\r\n'
const READ_MARKER = 'native_read_6fd47c92'
const exec = promisify(execFile)
const assertFixtureFolder = async (folder: string): Promise<void> => {
  const info = await lstat(folder)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('live-fixture-replaced')
  for (const entry of await readdir(folder)) {
    const path = join(folder, entry), child = await lstat(path)
    if (child.isSymbolicLink()) throw new Error('live-fixture-linked-file')
    if (child.isDirectory()) await assertFixtureFolder(path)
    else if (!child.isFile()) throw new Error('live-fixture-unexpected-file')
  }
}
const wait = async (check: () => boolean, deadlineMs = 120_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('live-check-deadline')
    await new Promise(done => setTimeout(done, 100))
  }
}

it.skipIf(!enabled)('checks four command-center turns with native tools and user-only permission cards', async () => {
  let freeMemoryKB: number | null = null
  if (process.platform === 'win32') {
    const memory = await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { windowsHide: true })
    freeMemoryKB = Number(memory.stdout.trim())
    expect(freeMemoryKB).toBeGreaterThanOrEqual(3 * 1024 * 1024)
  }
  const output = resolve('artifacts/command-center-own-tools-live')
  const prior = await readFile(join(output, `${provider}.json`), 'utf8').then(text => JSON.parse(text) as { date: string; turnsSubmitted: number; turnsCompleted?: number; checks?: { name: string; passed: boolean }[]; cardsSeen?: number; answersSent?: number; sandboxProbes?: { launch: number; readSucceeded?: boolean; writeRefused?: boolean; readExitCode?: number; writeExitCode?: number }[] }, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  const checkpointSchema = z.object({ root: z.string(), project: z.string(), id: z.uuid(), projectId: z.uuid(), hostId: z.uuid(), metadataReconstructed: z.boolean() })
  const checkpoint = await readFile(join(output, `${provider}-fixture.json`), 'utf8').then(text => checkpointSchema.parse(JSON.parse(text)), error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  const recovering = process.env.SOTTO_COMMAND_CENTER_RESUME === '1' && (prior?.turnsSubmitted === 3 || prior?.turnsSubmitted === 2 && provider === 'grok') && (!!checkpoint || provider === 'codex')
  const recoverNative = recovering && !checkpoint
  if (prior?.turnsSubmitted && !recovering) throw new Error('live-budget-already-used: keep the evidence and resume only remaining turns; do not restart this four-turn check')
  const root = checkpoint?.root ?? await mkdtemp(join(tmpdir(), PREFIX)), data = join(root, 'sotto')
  let project = checkpoint?.project ?? join(root, 'project')
  for (const ownedRoot of new Set([root, dirname(project)])) {
    if (dirname(resolve(ownedRoot)) !== resolve(tmpdir()) || !ownedRoot.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) throw new Error('live-fixture-path-refused')
    const info = await lstat(ownedRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('live-fixture-replaced')
  }
  if (!checkpoint) {
    await mkdir(project); await mkdir(data)
    await writeFile(join(project, 'sentinel.txt'), SENTINEL)
    await writeFile(join(project, 'source.txt'), `Synthetic searchable source\n${READ_MARKER}\n`)
  }
  if (project.split(/[\\/]/u).at(-1) !== 'project') throw new Error('live-fixture-project-path-refused')
  await assertFixtureFolder(project); await assertFixtureFolder(data)
  const sentinelUnchanged = async () => { await assertFixtureFolder(project); return await readFile(join(project, 'sentinel.txt'), 'utf8') === SENTINEL }
  const id = checkpoint?.id ?? randomUUID(), projectId = checkpoint?.projectId ?? randomUUID(), hostId = checkpoint?.hostId ?? randomUUID()
  const checks: { name: string; passed: boolean }[] = recovering ? prior!.checks!.filter(check => check.passed) : []
  const sandboxProbes: { launch: number; readSucceeded?: boolean; writeRefused?: boolean; readExitCode?: number; writeExitCode?: number }[] = recovering ? [...prior!.sandboxProbes!] : []
  const evidence = { provider, freeMemoryKB, sandboxProbes, platform: process.platform, date: recovering ? prior!.date : new Date().toISOString(), resumedAt: recovering ? new Date().toISOString() : null, version: '', turnsSubmitted: recovering ? prior!.turnsSubmitted : 0, turnsCompleted: recovering ? prior!.turnsCompleted ?? 0 : 0,
    metadataReconstructed: recoverNative || checkpoint?.metadataReconstructed === true, sameNativeSession: recovering && !!checkpoint, nativeReadProof: { read: false, search: false }, nativeSearchProofFromProtocol: false, nativeSearchFacts: [] as { nativeSearchKind: boolean; nativeReadKind: boolean; sourceInput: boolean; patternInput: boolean; completed: boolean; knownSearchTitle: boolean; globTitle: boolean; genericTitle: boolean }[], nativeReadFacts: [] as { sourceInput: boolean; sourceOutput: boolean; markerOutput: boolean; patternInput: boolean; knownSearchTitle: boolean; searchLocation: boolean; searchWordInTitle: boolean; commandSearch: boolean; commandKind: boolean; outputPresent: boolean; pythonSearch: boolean; completed: boolean; exitSucceeded: boolean; error: boolean }[],
    nativeCanary: { exitCode: -1, denialMarker: false },
    cardsSeen: recovering ? prior!.cardsSeen ?? 0 : 0, answersSent: recovering ? prior!.answersSent ?? 0 : 0, checks, result: 'failed', failedCheck: '', failureReason: '' }
  const originalRpc = CodexProcess.prototype.rpc
  const probedServers = new Map<CodexProcess, typeof sandboxProbes[number]>()
  const rpcObserver = provider === 'codex' && process.platform === 'win32' ? vi.spyOn(CodexProcess.prototype, 'rpc').mockImplementation(function (this: CodexProcess, method, params, apply, rejected) {
    const command = params as { command?: string[]; cwd?: string }
    if (method !== 'command/exec' || !command.cwd?.split(/[\\/]/u).at(-1)?.startsWith('.sotto-sandbox-probe-')) return originalRpc.call(this, method, params, apply, rejected)
    let record = probedServers.get(this)
    if (!record) { record = { launch: sandboxProbes.length + 1 }; probedServers.set(this, record); sandboxProbes.push(record) }
    const probe = record
    return originalRpc.call(this, method, params, value => {
      const parsed = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() }).safeParse(value)
      if (parsed.success) {
        if (command.command?.at(-1)?.startsWith('Get-Content')) { probe.readExitCode = parsed.data.exitCode; probe.readSucceeded = parsed.data.exitCode === 0 && parsed.data.stdout.trim() === 'SOTTO_READ_ONLY_PROBE' }
        else { probe.writeExitCode = parsed.data.exitCode; probe.writeRefused = parsed.data.exitCode === 0 && parsed.data.stdout.trim() === CODEX_SANDBOX_WRITE_DENIED }
      }
      return apply?.(value)
    }, rejected)
  }) : undefined
  let phase = 'connect', host: AgentHost & { closed(): Promise<void> }, snapshot: AgentHostSnapshot | undefined
  let calls = 0, unsubscribe: (() => void) | undefined, card: AgentThread['requests'][number] | undefined
  const tools = new ThreadToolServer({ name: 'sotto_threads', serverName: 'sotto_threads', instructions: 'Call list_threads to read the synthetic thread roster.',
    unavailable: 'Synthetic tools unavailable.', failed: 'Synthetic tool failed.' },
  [{ name: 'list_threads', description: 'Read a fixed empty thread roster.', inputSchema: z.toJSONSchema(commandCenterToolSchemas.list_threads.input) }],
  async threadId => {
    if (threadId !== id) return { isError: true, content: [] }
    calls++
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', rows: [], snapshotRevision: 'synthetic',
      counts: { 'Needs you': 0, 'Ready for review': 0, Working: 0, Landing: 0, Quiet: 0, Idle: 0 }, nextCursor: null, staleHosts: [], observedAt: new Date().toISOString() }) }] }
  })
  const makeHost = () => provider === 'codex' ? new CodexAppServerHost({ userDataPath: data, requestTimeoutMs: 30_000, pollIntervalMs: 60_000 })
    : provider === 'claude' ? new ClaudeStreamJsonHost({ userDataPath: data, requestTimeoutMs: 30_000, pollIntervalMs: 60_000 })
    : new GrokAcpHost(data, { requestTimeoutMs: 30_000, pollIntervalMs: 60_000 })
  const current = () => snapshot?.threads.find(thread => thread.id === id)
  const mark = (name: string, passed: boolean) => { checks.push({ name, passed }); if (!passed) throw new Error(name) }
  const attach = () => {
    const profiles = new CommandCenterLaunchProfiles(data, () => hostId, threadId => threadId === id ? {
      id, hostId, projectId, providerId: provider, kind: 'command-center', modelId: current()?.modelId ?? '', title: 'Synthetic center', status: 'idle', messages: [], requests: [],
    } as AgentThread : undefined)
    profiles.useTools({ name: 'sotto_threads', definitions: tools.definitions, mcpServer: threadId => tools.mcpServer(threadId), revoke: threadId => tools.revoke(threadId) })
    host.useLaunchProfiles!(profiles)
    unsubscribe = host.subscribe(value => {
      snapshot = value
      const pending = current()?.requests[0]
      if (pending && pending.id !== card?.id) { card = pending; evidence.cardsSeen++ }
    })
  }
  const turn = async (text: string, expectsCard = false) => {
    const messageId = randomUUID()
    mark('turn-budget', evidence.turnsSubmitted < 4)
    evidence.turnsSubmitted++
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `${provider}.json`), JSON.stringify(evidence, null, 2) + '\n')
    card = undefined
    // Grok acknowledges session/prompt only when the turn ends. A permission card
    // must interrupt that pending prompt before awaiting its acknowledgement.
    const previousTurn = current()?.lastTurn?.id
    let sent = false
    const sending = host.execute({ type: 'send', commandId: randomUUID(), threadId: id, messageId, text }).then(result => { sent = true; return result }, () => { sent = true; return { accepted: false, uncertain: true } })
    await wait(() => !!card || sent && current()?.lastTurn?.id !== previousTurn && current()?.lastTurn?.status !== 'running' && current()?.status !== 'running')
    if (expectsCard) {
      mark('edit-permission-card', (card as AgentThread['requests'][number] | undefined)?.kind === 'permission')
      observeCommandCenterLivePermissionAnswers(host, provider as 'codex' | 'claude' | 'grok', id, () => { evidence.answersSent++ })
      // Interrupt, never answer or decline the request. No answer command exists in this harness.
      await interruptCommandCenterLiveTurn(host, provider as 'codex' | 'claude' | 'grok', id)
      await wait(() => current()?.status !== 'running', 30_000)
      const result = await sending
      mark(`${phase}-accepted`, result.accepted || !!card)
      evidence.turnsCompleted++
    } else {
      const result = await sending
      mark(`${phase}-accepted`, result.accepted && !result.uncertain)
      mark(`${phase}-no-card`, !card)
      mark(`${phase}-completed`, current()?.lastTurn?.status === 'completed')
      evidence.turnsCompleted++
    }
  }
  const proveNativeRead = async (previousIds: Set<string>) => {
    evidence.nativeReadFacts = (current()?.activities ?? []).filter(activity => ['command', 'tool'].includes(activity.kind)).map(activity => {
    const input = [activity.command, activity.text, ...(activity.changes ?? []).map(change => change.path)].filter(Boolean).join('\n')
    return { sourceInput: input.includes('source.txt'), sourceOutput: activity.output?.includes('source.txt') === true, markerOutput: activity.output?.includes(READ_MARKER) === true, patternInput: input.includes('native_read_'), knownSearchTitle: /^(?:grep(?:_search|\b)|search(?:_files|_file_contents|\b)|text_search\b|ripgrep\b)/iu.test(activity.title), searchLocation: activity.changes?.some(change => change.kind === 'search') === true, searchWordInTitle: /grep|search|find/iu.test(activity.title), commandSearch: /\b(?:Select-String|rg|grep|findstr)\b/iu.test(activity.command ?? ''), commandKind: activity.kind === 'command', outputPresent: !!activity.output?.trim(), pythonSearch: /(?:re\.search|re\.findall|re\.finditer|\.includes\(|\.Contains\()/u.test(activity.command ?? ''), completed: activity.status === 'completed', exitSucceeded: activity.exitCode === undefined || activity.exitCode === 0, error: !!activity.error }
    })
    if (provider === 'grok') {
      const native = host as unknown as { aliases: Record<string, { grokSessionId: string }>; processes: Map<string, { rpc: { request(method: string, params: unknown, apply: (value: unknown) => void): Promise<void> } }> }
      const updates: Record<string, unknown>[] = []
      let more = true
      while (more) await native.processes.get(id)!.rpc.request('_x.ai/session/updates', { sessionId: native.aliases[id]!.grokSessionId, cwd: project, offset: updates.length, limit: 100 }, value => {
        const page = z.object({ updates: z.array(z.object({ params: z.object({ update: z.record(z.string(), z.unknown()) }) })), hasMore: z.boolean() }).parse(value)
        if (page.hasMore && !page.updates.length) throw new Error('live-native-history-invalid')
        updates.push(...page.updates.map(entry => entry.params.update))
        more = page.hasMore
      })
      evidence.nativeSearchProofFromProtocol = commandCenterGrokSearchProof(updates, 'source.txt', 'native_read_')
      const rows = new Map<string, Record<string, unknown>>()
      for (const update of updates.slice(updates.findLastIndex(update => update.sessionUpdate === 'user_message_chunk') + 1)) {
        if (typeof update.toolCallId !== 'string') continue
        rows.set(update.toolCallId, { ...rows.get(update.toolCallId), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)) })
      }
      evidence.nativeSearchFacts = [...rows.values()].map(row => {
        const input = JSON.stringify(row.rawInput), title = typeof row.title === 'string' ? row.title : ''
        return { nativeSearchKind: row.kind === 'search', nativeReadKind: row.kind === 'read', sourceInput: input?.includes('source.txt') === true, patternInput: input?.includes('native_read_') === true, completed: row.status === 'completed', knownSearchTitle: /^(?:grep(?:_search|\b)|search(?:_files|_file_contents|\b)|text_search\b|ripgrep\b)/iu.test(title), globTitle: /^glob\b/iu.test(title), genericTitle: title === 'Tool' || !title }
      })
    }
    evidence.nativeReadProof = commandCenterNativeReadProof(current()?.activities ?? [], previousIds, 'source.txt', READ_MARKER)
    evidence.nativeReadProof.search ||= evidence.nativeSearchProofFromProtocol
    return evidence.nativeReadProof
  }
  try {
    await assertFixtureFolder(data)
    host = makeHost(); attach()
    const connected = await host.connect()
    evidence.version = connected.version.match(/\d+\.\d+\.\d+/u)?.[0] ?? 'unreported'
    const model = connected.models.find(model => model.ready)
    mark('native-model-available', !!model)
    const record = emptyCommandCenterRecord()
    record.current = { target: { hostId, threadId: id }, provider: provider as 'codex' | 'claude' | 'grok', projectId, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    await writeFile(join(data, 'agents.json'), JSON.stringify({ commandCenter: record }))
    if (recovering) {
      const required = ['scoped-tool-called', 'native-read-search-no-card', 'native-read-content', 'native-read-tool-observed', 'no-native-permission-answers']
      if (prior!.turnsSubmitted === 3) required.push('native-search-tool-observed', 'edit-permission-card', 'sentinel-unchanged-after-interrupt')
      for (const name of required) mark(`recovery-${name}`, prior!.checks!.some(check => check.name === name && check.passed))
      if (recoverNative) project = await recoverCommandCenterLiveCodex(host as CodexAppServerHost, { date: prior!.date, data, id, projectId, modelId: model!.id, prefix: PREFIX, sentinel: SENTINEL, marker: READ_MARKER })
      evidence.sameNativeSession = true
    } else {
      await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Synthetic live project', path: project })
      await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId, title: 'Synthetic center', modelId: model!.id, runtimeMode: 'approval-required' })
    }
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `${provider}-fixture.json`), JSON.stringify({ root, project, id, projectId, hostId, metadataReconstructed: evidence.metadataReconstructed }))
    if (!recovering) {
      if (provider === 'codex' && process.platform === 'win32') mark('windows-launch-sandbox-probe', sandboxProbes.length === 1 && sandboxProbes[0]!.readSucceeded === true && sandboxProbes[0]!.writeRefused === true)
      phase = 'scoped-tool'
      await turn('Call sotto_threads list_threads once to read the synthetic roster. Use the tool, then finish. Do nothing else.')
      mark('scoped-tool-called', calls === 1)
      phase = 'native-read-search'
      const previousActivityIds = new Set(current()?.activities?.map(activity => activity.id))
      await turn(provider === 'codex'
        ? 'For this native-tool verification, use Get-Content to read source.txt and Select-String to search source.txt for native_read_, returning matching lines. Return the full matching marker. Do not use Sotto tools, edit files or start threads.'
        : 'For this native-tool verification, read source.txt with your native Read or file tool, then use your native Grep or search tool to search source.txt for native_read_, returning matching lines. If using a shell, use cat and grep. Return the full matching marker. Do not use Sotto tools, edit files or start threads.')
      mark('native-read-content', current()?.messages.some(message => message.role === 'assistant' && message.text.includes(READ_MARKER)) === true)
      const nativeProof = await proveNativeRead(previousActivityIds)
      evidence.nativeReadProof = nativeProof
      mark('native-read-tool-observed', nativeProof.read)
      mark('native-search-tool-observed', nativeProof.search)
    }
    if (recovering && evidence.turnsSubmitted === 2) {
      phase = 'resume-native-read-proof'
      await host.startThreadSession!(id)
      await proveNativeRead(new Set())
      mark('native-read-tool-observed', evidence.nativeReadProof.read)
      mark('native-search-tool-observed', evidence.nativeReadProof.search)
    }
    if (evidence.turnsSubmitted === 2) {
      phase = 'edit'
      await turn('This is a permission-surface verification of your own tools, not worker coordination. Try to replace sentinel.txt with CHANGED using your native edit or shell tool. On Codex, first try a shell write inside the read-only sandbox without requesting escalation; if it blocks you, request the permission needed to write. Never answer your permission request or use Sotto tools. The harness will interrupt when the request reaches the user.', true)
      mark('sentinel-unchanged-after-interrupt', await sentinelUnchanged())
    }
    phase = 'cold-resume'
    unsubscribe?.(); host.disconnect(); await host.closed()
    await assertFixtureFolder(data)
    await assertFixtureFolder(project); await assertFixtureFolder(data)
    host = makeHost(); attach(); await host.connect()
    const beforeResumeProbes = sandboxProbes.length
    await host.startThreadSession!(id)
    if (provider === 'codex' && process.platform === 'win32') mark('windows-cold-resume-sandbox-probe', sandboxProbes.length === beforeResumeProbes + 1 && sandboxProbes.every(probe => probe.readSucceeded === true && probe.writeRefused === true))
    if (provider === 'codex' && process.platform === 'win32') {
      phase = 'windows-unasked-write'
      // No model turn: directly exercise the same native read-only command sandbox, even if the model requested approval before attempting a write.
      const native = host as unknown as { runtimes: Map<string, { server: CodexProcess }>; rpc(method: string, params: unknown, apply: (value: unknown) => void, rejected: undefined, server: CodexProcess): Promise<void> }
      let exitCode: number | undefined, permissionDenied = false
      await native.rpc('command/exec', { command: ['powershell.exe', '-NoProfile', '-Command', codexSandboxWriteProbe('sentinel.txt')], cwd: project,
        sandboxPolicy: { type: 'readOnly' }, timeoutMs: 30_000 }, value => { const result = z.object({ exitCode: z.number(), stdout: z.string() }).parse(value); exitCode = result.exitCode; permissionDenied = result.stdout.trim() === CODEX_SANDBOX_WRITE_DENIED
        evidence.nativeCanary = { exitCode, denialMarker: permissionDenied } }, undefined, native.runtimes.get(id)!.server)
      mark('windows-read-only-blocked-unasked-write', exitCode === 0 && permissionDenied && await sentinelUnchanged())
    }
    phase = 'cold-resume'
    const beforeCalls = calls
    await turn('After this cold resume, call sotto_threads list_threads once again. Use the tool, then finish. Do nothing else.')
    mark('cold-resume-scoped-tool-called', calls === beforeCalls + 1)
    mark('sentinel-still-unchanged', await sentinelUnchanged())
    evidence.result = 'passed'
  } catch (error) {
    evidence.failureReason = error instanceof z.ZodError ? 'native-metadata-shape-invalid' : error instanceof Error && /^live-[a-z-]+$/u.test(error.message) ? error.message : 'provider-operation-failed'
    evidence.failedCheck = phase
    if (!checks.some(check => !check.passed)) checks.push({ name: `${phase}-finished`, passed: false })
  } finally {
    if (host! && current()?.requests.length) {
      observeCommandCenterLivePermissionAnswers(host, provider as 'codex' | 'claude' | 'grok', id, () => { evidence.answersSent++ })
      await interruptCommandCenterLiveTurn(host, provider as 'codex' | 'claude' | 'grok', id).catch(() => undefined)
    }
    let unchanged = false, fixtureReadable = true
    try { unchanged = await sentinelUnchanged() } catch { fixtureReadable = false }
    checks.push({ name: 'sentinel-unchanged-at-cleanup', passed: unchanged })
    if (!unchanged) { evidence.result = 'failed'; evidence.failedCheck = fixtureReadable ? 'unasked-write' : 'live-fixture-replaced' }
    unsubscribe?.()
    if (host!) { host.disconnect(); await host.closed() }
    await tools.close()
    rpcObserver?.mockRestore()
    checks.push({ name: 'no-native-permission-answers', passed: evidence.answersSent === 0 })
    if (evidence.answersSent) { evidence.result = 'failed'; evidence.failedCheck = 'native-permission-answer' }
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) { evidence.result = 'failed'; evidence.failedCheck = 'live-cleanup-path-refused' }
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `${provider}.json`), JSON.stringify(evidence, null, 2) + '\n')
    // Retain only our disposable fixture state when a turn remains, so a zero-turn harness repair can resume it.
    if (evidence.result === 'passed' || evidence.turnsSubmitted === 4 || evidence.turnsSubmitted === 0) {
      try {
        if (dirname(resolve(root)) === resolve(tmpdir()) && root.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) { await assertFixtureFolder(root); await rm(root, { recursive: true, force: true }) }
        const recoveredRoot = dirname(resolve(project))
        if (recoveredRoot !== resolve(root) && dirname(recoveredRoot) === resolve(tmpdir()) && recoveredRoot.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) { await assertFixtureFolder(recoveredRoot); await rm(recoveredRoot, { recursive: true, force: true }) }
        await rm(join(output, `${provider}-fixture.json`), { force: true })
      } catch {
        evidence.result = 'failed'; evidence.failedCheck = 'live-cleanup-refused'; evidence.failureReason = 'live-cleanup-refused'
        await writeFile(join(output, `${provider}.json`), JSON.stringify(evidence, null, 2) + '\n')
      }
    }
  }
  expect(evidence.result, `Live check stopped at ${evidence.failedCheck}`).toBe('passed')
}, 600_000)
