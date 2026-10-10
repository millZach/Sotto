// @vitest-environment node
// SOTTO_COMMAND_CENTER_LIVE=1 SOTTO_COMMAND_CENTER_PROVIDER=codex|claude|grok npx vitest run tests/integration/commandCenterOwnToolsLive.test.ts
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
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
import type { CodexProcess } from '../../src/main/agents/codexProcess'

const provider = process.env.SOTTO_COMMAND_CENTER_PROVIDER
const enabled = process.env.SOTTO_COMMAND_CENTER_LIVE === '1' && !process.env.CI && ['codex', 'claude', 'grok'].includes(provider ?? '')
const PREFIX = 'sotto-command-center-own-tools-'
const SENTINEL = 'SENTINEL_UNCHANGED\r\n'
const READ_MARKER = 'native_read_6fd47c92'
const exec = promisify(execFile)
const wait = async (check: () => boolean, deadlineMs = 120_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('live-check-deadline')
    await new Promise(done => setTimeout(done, 100))
  }
}

it.skipIf(!enabled)('checks four command-center turns with native tools and user-only permission cards', async () => {
  if (process.platform === 'win32') {
    const memory = await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { windowsHide: true })
    expect(Number(memory.stdout.trim())).toBeGreaterThanOrEqual(3 * 1024 * 1024)
  }
  const output = resolve('artifacts/command-center-own-tools-live')
  const prior = await readFile(join(output, `${provider}.json`), 'utf8').then(text => JSON.parse(text) as { turnsSubmitted: number }, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (prior?.turnsSubmitted) throw new Error('live-budget-already-used: keep the evidence and resume only remaining turns; do not restart this four-turn check')
  const root = await mkdtemp(join(tmpdir(), PREFIX)), project = join(root, 'project'), data = join(root, 'sotto')
  await mkdir(project); await mkdir(data)
  await writeFile(join(project, 'sentinel.txt'), SENTINEL)
  await writeFile(join(project, 'source.txt'), `Synthetic searchable source\n${READ_MARKER}\n`)
  const id = randomUUID(), projectId = randomUUID(), hostId = randomUUID()
  const checks: { name: string; passed: boolean }[] = []
  const evidence = { provider, platform: process.platform, date: new Date().toISOString(), version: '', turnsSubmitted: 0, turnsCompleted: 0,
    cardsSeen: 0, answersSent: 0, checks, result: 'failed', failedCheck: '' }
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
  try {
    host = makeHost(); attach()
    const connected = await host.connect()
    evidence.version = connected.version.match(/\d+\.\d+\.\d+/u)?.[0] ?? 'unreported'
    const model = connected.models.find(model => model.ready)
    mark('native-model-available', !!model)
    const record = emptyCommandCenterRecord()
    record.current = { target: { hostId, threadId: id }, provider: provider as 'codex' | 'claude' | 'grok', projectId, creationOperationId: randomUUID(), createdAt: new Date().toISOString() }
    await writeFile(join(data, 'agents.json'), JSON.stringify({ commandCenter: record }))
    await host.execute({ type: 'create-project', commandId: randomUUID(), projectId, title: 'Synthetic live project', path: project })
    await host.execute({ type: 'create-thread', commandId: randomUUID(), threadId: id, projectId, title: 'Synthetic center', modelId: model!.id, runtimeMode: 'approval-required' })
    phase = 'scoped-tool'
    await turn('Call sotto_threads list_threads once to read the synthetic roster. Use the tool, then finish. Do nothing else.')
    mark('scoped-tool-called', calls === 1)
    phase = 'native-read-search'
    const before = current()?.activities?.length ?? 0
    await turn('For this native-tool verification, read source.txt and search it for native_read_ using your own native file or shell tools. Return the full matching marker. Do not use Sotto tools, edit files or start threads.')
    mark('native-read-content', current()?.messages.some(message => message.role === 'assistant' && message.text.includes(READ_MARKER)) === true)
    mark('native-read-tool-observed', (current()?.activities?.slice(before) ?? []).some(activity => ['command', 'tool'].includes(activity.kind)))
    phase = 'edit'
    await turn('This is a permission-surface verification of your own tools, not worker coordination. Try to replace sentinel.txt with CHANGED using your native edit or shell tool. On Codex, first try a shell write inside the read-only sandbox without requesting escalation; if it blocks you, request the permission needed to write. Never answer your permission request or use Sotto tools. The harness will interrupt when the request reaches the user.', true)
    mark('sentinel-unchanged-after-interrupt', await readFile(join(project, 'sentinel.txt'), 'utf8') === SENTINEL)
    if (provider === 'codex' && process.platform === 'win32') {
      phase = 'windows-unasked-write'
      // No model turn: directly exercise the same native read-only command sandbox, even if the model requested approval before attempting a write.
      const native = host as unknown as { runtimes: Map<string, { server: CodexProcess }>; rpc(method: string, params: unknown, apply: (value: unknown) => void, rejected: undefined, server: CodexProcess): Promise<void> }
      let exitCode: number | undefined
      await native.rpc('command/exec', { command: ['powershell.exe', '-NoProfile', '-Command', "[System.IO.File]::WriteAllText('sentinel.txt','UNASKED_WRITE')"], cwd: project,
        sandboxPolicy: { type: 'readOnly' }, timeoutMs: 30_000 }, value => { exitCode = z.object({ exitCode: z.number() }).parse(value).exitCode }, undefined, native.runtimes.get(id)!.server)
      mark('windows-read-only-blocked-unasked-write', exitCode !== undefined && exitCode !== 0 && await readFile(join(project, 'sentinel.txt'), 'utf8') === SENTINEL)
    }
    phase = 'cold-resume'
    unsubscribe?.(); host.disconnect(); await host.closed()
    host = makeHost(); attach(); await host.connect()
    await host.startThreadSession!(id)
    const beforeCalls = calls
    await turn('After this cold resume, call sotto_threads list_threads once again. Use the tool, then finish. Do nothing else.')
    mark('cold-resume-scoped-tool-called', calls === beforeCalls + 1)
    mark('sentinel-still-unchanged', await readFile(join(project, 'sentinel.txt'), 'utf8') === SENTINEL)
    evidence.result = 'passed'
  } catch {
    evidence.failedCheck = phase
    if (!checks.some(check => !check.passed)) checks.push({ name: `${phase}-finished`, passed: false })
  } finally {
    if (host! && current()?.requests.length) {
      observeCommandCenterLivePermissionAnswers(host, provider as 'codex' | 'claude' | 'grok', id, () => { evidence.answersSent++ })
      await interruptCommandCenterLiveTurn(host, provider as 'codex' | 'claude' | 'grok', id).catch(() => undefined)
    }
    const unchanged = await readFile(join(project, 'sentinel.txt'), 'utf8') === SENTINEL
    checks.push({ name: 'sentinel-unchanged-at-cleanup', passed: unchanged })
    if (!unchanged) { evidence.result = 'failed'; evidence.failedCheck = 'unasked-write' }
    unsubscribe?.()
    if (host!) { host.disconnect(); await host.closed() }
    await tools.close()
    checks.push({ name: 'no-native-permission-answers', passed: evidence.answersSent === 0 })
    if (evidence.answersSent) { evidence.result = 'failed'; evidence.failedCheck = 'native-permission-answer' }
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) { evidence.result = 'failed'; evidence.failedCheck = 'live-cleanup-path-refused' }
    await mkdir(output, { recursive: true })
    await writeFile(join(output, `${provider}.json`), JSON.stringify(evidence, null, 2) + '\n')
    if (dirname(resolve(root)) === resolve(tmpdir()) && root.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) await rm(root, { recursive: true, force: true })

  }
  expect(evidence.result, `Live check stopped at ${evidence.failedCheck}`).toBe('passed')
}, 600_000)
