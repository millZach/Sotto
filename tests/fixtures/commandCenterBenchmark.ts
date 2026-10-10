/** Measurement stand-ins, not the ticket 3 broker. All reads belong to disposable project copies. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { commandCenterToolSchemas, type CommandCenterToolInput, type CommandCenterProjectTarget } from '../../src/shared/commandCenter'
import { COMMAND_CENTER_GROUPS } from '../../src/shared/commandCenterOverview'
import { ThreadToolServer } from '../../src/main/agents/threadToolServer'

const exec = promisify(execFile)
const PREFIX = 'sotto-command-center-benchmark-'
const AT = '2026-10-09T00:00:00.000Z'
export const BENCHMARK_HOST_ID = '00000000-0000-4000-8000-000000000001'
export const THREAD_TOOL_NAMES = ['list_threads', 'read_thread', 'start_thread'] as const
export const FILE_TOOL_NAMES = ['list_project_files', 'search_project_files', 'read_project_file'] as const
export type BenchmarkToolName = typeof THREAD_TOOL_NAMES[number] | typeof FILE_TOOL_NAMES[number]
export type BenchmarkArm = 'A' | 'B'
export const BENCHMARK_TASKS = [
  { id: 'roster', prompt: "What needs me right now, and what's ready for review?" },
  { id: 'locate', prompt: "Where does Sotto decide which providers may run the command center, and what's admitted today? Include the exact file path, platform and client version." },
  { id: 'trace', prompt: "If a Codex thread's app-server stops in the middle of a reply, what does the user see? Include the exact user-facing sentence and its source file." },
  { id: 'brief', prompt: 'Start a thread in Sotto to add a new setting called demoFlag. Find what a new setting must touch first and brief the worker properly. Use the shared working copy.' },
  { id: 'across', prompt: 'Compare Sotto and Relay: which declares zod as a runtime dependency, and where does each keep its settings or configuration types and defaults? Give exact paths for both projects.' },
] as const
export type BenchmarkTask = typeof BENCHMARK_TASKS[number]['id']

const target = (threadId: string) => ({ hostId: BENCHMARK_HOST_ID, threadId })
const projectTarget = (projectId: string): CommandCenterProjectTarget => ({ hostId: BENCHMARK_HOST_ID, projectId })
const descriptions: Record<BenchmarkToolName, string> = {
  list_threads: 'List the fixed benchmark roster, including pending questions and linked pull requests.',
  read_thread: 'Read the short fixture history and evidence of a roster thread.',
  start_thread: 'Record a worker brief and return a fixed new thread ID. Starts nothing.',
  list_project_files: 'List immediate entries in a project directory, with 100 entries per page.',
  search_project_files: 'Search literal text in project files, optionally under a subdirectory; at most 100 matches.',
  read_project_file: 'Read a relative source file window: at most 200 lines and 64 KiB; files at most 1 MiB.',
}
const seed = [
  ['android-storage', 'Choose Android storage', 'relay', 'claude', 'Needs you'],
  ['theme-review', 'Theme contrast review', 'sotto', 'codex', 'Ready for review'],
  ['codex-recovery', 'Codex recovery', 'sotto', 'codex', 'Working'],
  ['relay-config', 'Relay config', 'relay', 'grok', 'Working'],
  ['dictation-cleanup', 'Dictation cleanup', 'sotto', 'claude', 'Quiet'],
  ['relay-tests', 'Relay tests', 'relay', 'codex', 'Quiet'],
  ['settings-notes', 'Settings notes', 'sotto', 'grok', 'Idle'],
  ['relay-docs', 'Relay docs', 'relay', 'claude', 'Idle'],
] as const
const rows = seed.map(([threadId, title, projectId, provider, group]) => ({
  target: target(threadId), title, projectId, provider, modelId: `fixture-${provider}`,
  status: group === 'Working' ? 'running' : 'idle', group,
  waitsOn: threadId === 'android-storage' ? [{ id: 'storage-question', kind: 'question', label: 'Should drafts survive an app restart?', openTarget: target(threadId) }] : [],
  branch: null, workingCopy: { kind: 'shared' },
  pullRequests: threadId === 'theme-review' ? [{ number: 42, url: 'https://github.com/example/synthetic/pull/42', title: 'Improve theme contrast', state: 'open', draft: false }] : [],
  evidence: threadId === 'theme-review' ? [{ id: 'checks-42', source: 'github', observedAt: AT, target: target(threadId), freshness: 'fresh', availability: 'available', fact: 'checks-passed', referenceId: 'pr-42' }] : [],
  lastActivityAt: AT, observedAt: AT, connected: true, freshness: 'fresh', userReadAt: null, commandCenterReadAt: null, participation: [], protected: false,
}))
// Validate the stand-in against ticket 1, including every row/evidence shape.
commandCenterToolSchemas.list_threads.output.parse({ status: 'ok', rows, snapshotRevision: 'fixed',
  counts: Object.fromEntries(COMMAND_CENTER_GROUPS.map(group => [group, rows.filter(row => row.group === group).length])), nextCursor: null, observedAt: AT, staleHosts: [] })

const skipped = new Set(['.git', 'node_modules', 'out', 'release', 'artifacts', '.codex', '.claude', '.grok', '.sotto'])
const sensitive = (name: string): boolean => /^\.env/iu.test(name) || /^(?:id_rsa|id_dsa|id_ed25519|id_ecdsa|credentials|auth\.json)$/iu.test(name)
  || /\.(?:pem|key|ppk|p12|pfx)$/iu.test(name)
const denied = (path: string): boolean => path.split(/[\\/]/u).some(part => skipped.has(part.toLowerCase()) || sensitive(part))
class FileRefusal extends Error {
  constructor(readonly code: 'UNSAFE_PATH' | 'SENSITIVE_FILE' | 'FILE_TOO_LARGE' | 'BINARY_FILE' | 'UNKNOWN_TARGET' | 'SCAN_LIMIT') { super(code) }
}

export interface BenchmarkCopies {
  root: string
  sotto: string
  relay: string
  sourceCommit: string
  files: number
  bytes: number
  assertUnchanged(): Promise<void>
  close(): Promise<void>
}
async function filesUnder(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Benchmark copy contains a link.')
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await filesUnder(root, path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}
export async function createBenchmarkCopies(revision = 'HEAD'): Promise<BenchmarkCopies> {
  const root = await mkdtemp(join(tmpdir(), PREFIX)), sotto = join(root, 'Sotto'), relay = join(root, 'Relay')
  const baseline = new Map<string, string>()
  let files = 0, bytes = 0
  let stage = 'mkdir'
  const close = async (): Promise<void> => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.split(/[\\/]/u).at(-1)?.startsWith(PREFIX)) throw new Error('Benchmark cleanup refused an unexpected folder.')
    // Windows refuses deleting read-only files; restore permissions only after both clients have stopped.
    for (const project of [sotto, relay]) {
      for (const path of await filesUnder(project).catch(() => [])) await chmod(join(project, path), 0o600)
    }
    await rm(root, { recursive: true, force: true })
  }
  try {
    await mkdir(sotto); await mkdir(relay)
    const sourceCommit = (await exec('git', ['rev-parse', '--verify', revision], { cwd: process.cwd() })).stdout.trim()
    const archive = join(root, 'source.tar')
    stage = 'archive'
    await exec('git', ['archive', '--format=tar', `--output=${archive}`, sourceCommit], { cwd: process.cwd() })
    stage = 'extract'
    // Git's GNU tar interprets a Windows drive colon as a remote archive. Relative arguments avoid it.
    await exec('tar', ['-xf', 'source.tar', '-C', 'Sotto'], { cwd: root })
    await rm(archive)
    await mkdir(join(relay, 'src'))
    await writeFile(join(relay, 'package.json'), JSON.stringify({ name: 'relay', private: true, type: 'module', dependencies: {}, devDependencies: { typescript: '5.9.3' } }, null, 2) + '\n')
    await writeFile(join(relay, 'README.md'), '# Relay\nA synthetic local reminder project for the command-center benchmark.\nConfiguration types and defaults live in src/config.ts. No runtime dependencies.\n')
    await writeFile(join(relay, 'src/config.ts'), 'export interface RelayConfig { reminderMinutes: number; keepDrafts: boolean }\nexport const defaultConfig: RelayConfig = { reminderMinutes: 15, keepDrafts: true }\n')
    for (let index = 0; index < 36; index++) await writeFile(join(relay, 'src', `reminder${index}.ts`), `export const reminder${index} = { id: ${index}, enabled: true }\n`)
    stage = 'hash-and-protect'
    for (const project of [sotto, relay]) {
      for (const path of await filesUnder(project)) {
        const data = await readFile(join(project, path))
        baseline.set(`${project}/${path}`, createHash('sha256').update(data).digest('hex'))
        files++; bytes += data.length
        await chmod(join(project, path), 0o444)
      }
    }
    return { root, sotto, relay, sourceCommit, files, bytes, close, async assertUnchanged() {
      const current: string[] = []
      for (const project of [sotto, relay]) for (const path of await filesUnder(project)) current.push(`${project}/${path}`)
      if (current.length !== baseline.size) throw new Error('Benchmark project file set changed.')
      for (const path of current) if (createHash('sha256').update(await readFile(path)).digest('hex') !== baseline.get(path)) throw new Error('Benchmark project bytes changed.')
    } }
  } catch (error) {
    await close()
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(`Benchmark project copy setup failed at ${stage}${typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? ` (${code})` : ''}.`, { cause: error })
  }
}

export class BenchmarkStandIns {
  readonly calls: Record<BenchmarkToolName, number> = Object.fromEntries([...THREAD_TOOL_NAMES, ...FILE_TOOL_NAMES].map(name => [name, 0])) as Record<BenchmarkToolName, number>
  /** Worker arguments are checked only in memory, never logged or serialized. */
  readonly starts: CommandCenterToolInput<'start_thread'>[] = []
  readonly tools: ThreadToolServer
  private readonly roots: Map<string, string>
  private readonly names: readonly BenchmarkToolName[]
  constructor(copies: BenchmarkCopies, readonly threadId: string, arm: BenchmarkArm, beforeTool: () => boolean) {
    this.roots = new Map([['sotto', copies.sotto], ['relay', copies.relay]])
    this.names = arm === 'A' ? [...THREAD_TOOL_NAMES, ...FILE_TOOL_NAMES] : THREAD_TOOL_NAMES
    this.tools = new ThreadToolServer({ name: 'sotto_threads', serverName: 'sotto_threads', instructions: 'Fixed benchmark thread roster. start_thread records a brief only; it starts nothing.', unavailable: 'Benchmark tool unavailable.', failed: 'Benchmark tool failed.' },
      this.names.map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(commandCenterToolSchemas[name].input) })),
      async (id, name, args) => {
        if (id !== threadId || !this.names.includes(name as BenchmarkToolName) || !beforeTool()) return { isError: true, content: [] }
        this.calls[name as BenchmarkToolName]++
        const result = await this.invoke(name as BenchmarkToolName, args)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      })
  }
  get toolNames(): readonly BenchmarkToolName[] { return this.names }
  private async path(project: CommandCenterProjectTarget, path: string): Promise<string> {
    const root = this.roots.get(project.projectId)
    if (!root || project.hostId !== BENCHMARK_HOST_ID) throw new FileRefusal('UNKNOWN_TARGET')
    if (isAbsolute(path) || /^(?:[\\/]|[a-z]:)/iu.test(path) || path.includes(':') || /[\p{Cc}]/u.test(path) || path.split(/[\\/]/u).includes('..')) throw new FileRefusal('UNSAFE_PATH')
    if (denied(path)) throw new FileRefusal(sensitive(path.split(/[\\/]/u).at(-1) ?? '') ? 'SENSITIVE_FILE' : 'UNSAFE_PATH')
    let current = root
    for (const part of path.split(/[\\/]/u).filter(Boolean)) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw new FileRefusal('UNSAFE_PATH')
    }
    const actual = await realpath(current), within = relative(await realpath(root), actual)
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new FileRefusal('UNSAFE_PATH')
    return actual
  }
  private async source(project: CommandCenterProjectTarget, path: string): Promise<{ text: string; size: number }> {
    const full = await this.path(project, path), info = await lstat(full)
    if (!info.isFile() || info.isSymbolicLink()) throw new FileRefusal('UNSAFE_PATH')
    if (info.size > 1_024 * 1_024) throw new FileRefusal('FILE_TOO_LARGE')
    const bytes = await readFile(full)
    if (bytes.includes(0)) throw new FileRefusal('BINARY_FILE')
    return { text: bytes.toString('utf8'), size: bytes.length }
  }
  private async invoke(name: BenchmarkToolName, args: unknown): Promise<unknown> {
    const parsed = commandCenterToolSchemas[name].input.safeParse(args)
    if (!parsed.success) return { status: 'refused', code: 'INVALID_INPUT', message: 'Use the benchmark tool schema.', retryable: false }
    let result: unknown
    try { result = await this.dispatch(name, parsed.data) }
    catch (error) { result = { status: 'refused', code: error instanceof FileRefusal ? error.code : 'UNSAFE_PATH', message: 'The benchmark could not read that path.', retryable: false } }
    return commandCenterToolSchemas[name].output.parse(result)
  }
  private async dispatch(name: BenchmarkToolName, value: unknown): Promise<unknown> {
    if (name === 'list_threads') {
      const args = value as CommandCenterToolInput<'list_threads'>
      const filtered = rows.filter(row => (!args.hostId || row.target.hostId === args.hostId) && (!args.project || row.projectId === args.project.projectId && row.target.hostId === args.project.hostId) && (!args.group || row.group === args.group))
      const offset = this.cursor(args.cursor), page = filtered.slice(offset, offset + args.limit)
      return { status: 'ok', rows: page, snapshotRevision: 'fixed', counts: Object.fromEntries(COMMAND_CENTER_GROUPS.map(group => [group, filtered.filter(row => row.group === group).length])), nextCursor: offset + page.length < filtered.length ? String(offset + page.length) : null, observedAt: AT, staleHosts: [] }
    }
    if (name === 'read_thread') {
      const args = value as CommandCenterToolInput<'read_thread'>
      const row = rows.find(row => row.target.threadId === args.target.threadId && args.target.hostId === BENCHMARK_HOST_ID)
      if (!row) throw new FileRefusal('UNKNOWN_TARGET')
      const messages = [{ id: `${row.target.threadId}-user`, position: 0, role: 'user', text: `Work on ${row.title}.`, createdAt: AT },
        { id: `${row.target.threadId}-assistant`, position: 1, role: 'assistant', text: row.group === 'Needs you' ? 'Should drafts survive an app restart?' : row.group === 'Ready for review' ? 'PR #42 is ready for review. The checks passed.' : 'The fixture work is in its reported group.', createdAt: AT }]
        .filter(message => !args.position || message.position > args.position.afterPosition).slice(-args.limit)
      return { status: 'ok', target: row.target, messages, waitsOn: row.waitsOn, activities: [], evidence: row.evidence, historyEpoch: 'fixed-history', firstPosition: messages[0]?.position ?? null, lastPosition: messages.at(-1)?.position ?? null, nextPosition: null, truncated: messages.length < 2, earlierAvailable: false, observedAt: AT }
    }
    if (name === 'start_thread') {
      const args = value as CommandCenterToolInput<'start_thread'>
      if (args.project.hostId !== BENCHMARK_HOST_ID || !this.roots.has(args.project.projectId)) throw new FileRefusal('UNKNOWN_TARGET')
      this.starts.push(args)
      return { status: 'ok', target: target('benchmark-new-thread'), receipt: { operationId: '00000000-0000-4000-8000-000000000002', target: target('benchmark-new-thread'), requestId: args.requestId, deliveryState: 'accepted', receiptId: 'benchmark-receipt', cardId: 'benchmark-card' }, limits: { inFlight: 1, inFlightLimit: 4, promptCount: 1, promptLimit: 4 }, effectiveChoices: { modelId: args.modelId, reasoningEffort: args.reasoningEffort ?? null, permission: args.permission ?? { kind: 'runtime', mode: 'approval-required' }, workingCopy: args.workingCopy }, creationReceiptId: 'benchmark-creation', firstPromptReceiptId: 'benchmark-first-prompt' }
    }
    if (name === 'list_project_files') {
      const args = value as CommandCenterToolInput<'list_project_files'>, full = await this.path(args.project, args.directory)
      const children = (await readdir(full, { withFileTypes: true })).filter(entry => !denied(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile())).sort((a, b) => a.name.localeCompare(b.name))
      const offset = this.cursor(args.cursor), page = children.slice(offset, offset + args.limit)
      const entries = await Promise.all(page.map(async entry => {
        const info = await lstat(join(full, entry.name))
        return { path: args.directory ? `${args.directory.replace(/\\/gu, '/')}/${entry.name}` : entry.name, kind: entry.isDirectory() ? 'directory' : 'file', sizeBytes: entry.isFile() ? info.size : null, modifiedAt: info.mtime.toISOString() }
      }))
      return { status: 'ok', project: args.project, entries, nextCursor: offset + page.length < children.length ? String(offset + page.length) : null, truncated: offset + page.length < children.length }
    }
    if (name === 'read_project_file') {
      const args = value as CommandCenterToolInput<'read_project_file'>, source = await this.source(args.project, args.path)
      const lines = source.text.split(/\r?\n/u), window: string[] = []
      for (const line of lines.slice(args.startLine - 1, args.startLine - 1 + args.lineLimit)) {
        if (Buffer.byteLength(JSON.stringify({ text: [...window, line].join('\n') }), 'utf8') > 60 * 1_024) break
        window.push(line)
      }
      const next = args.startLine + window.length, truncated = next <= lines.length
      return { status: 'ok', project: args.project, path: args.path.replace(/\\/gu, '/'), text: window.join('\n'), sizeBytes: source.size, readAt: AT, contentRevision: createHash('sha256').update(source.text).digest('hex'), startLine: args.startLine, nextLine: truncated ? next : null, truncated }
    }
    const args = value as CommandCenterToolInput<'search_project_files'>
    const started = performance.now(), matches: { path: string; line: number; snippet: string }[] = []
    let filesScanned = 0, bytesScanned = 0, directoriesScanned = 0, entriesScanned = 0, truncated = false
    if (args.glob) return { status: 'refused', code: 'INVALID_INPUT', message: 'This stand-in supports literal text and an optional directory, without globs.', retryable: false }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 24 || entriesScanned >= 20_000 || bytesScanned >= 64 * 1_024 * 1_024 || performance.now() - started > 10_000) { truncated = true; return }
      const full = await this.path(args.project, directory); directoriesScanned++
      for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (matches.length >= args.limit || entriesScanned++ >= 20_000 || bytesScanned >= 64 * 1_024 * 1_024 || performance.now() - started > 10_000) { truncated = true; return }
        if (denied(entry.name) || entry.isSymbolicLink()) continue
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path, depth + 1)
        else if (entry.isFile()) {
          let source: { text: string; size: number }
          try { source = await this.source(args.project, path) } catch { continue }
          filesScanned++; bytesScanned += source.size
          const lines = source.text.split(/\r?\n/u)
          for (let index = 0; index < lines.length; index++) if (lines[index]!.includes(args.text)) {
            const match = { path, line: index + 1, snippet: lines[index]!.slice(0, 400) }
            if (Buffer.byteLength(JSON.stringify([...matches, match]), 'utf8') > 60 * 1_024) { truncated = true; return }
            matches.push(match)
            if (matches.length >= args.limit) { truncated = true; break }
          }
          if (filesScanned % 32 === 0) await new Promise<void>(done => setImmediate(done))
        }
      }
    }
    await walk(args.directory ?? '', 0)
    return { status: 'ok', project: args.project, matches, coverage: { filesScanned, bytesScanned, directoriesScanned, elapsedMs: Math.round(performance.now() - started), complete: !truncated }, truncated }
  }
  private cursor(value: string | undefined): number {
    if (value !== undefined && !/^\d{1,6}$/u.test(value)) throw new FileRefusal('UNSAFE_PATH')
    return value === undefined ? 0 : Number(value)
  }
  context(copies: BenchmarkCopies, model: string, effort: string): string {
    return `You are measuring a command center. Answer the user task using the supplied tools and project copies. Read only these two roots; do not read your home, credentials, other projects, network pages or live repositories. Do not edit files or run workers yourself. Do not request clarification or permission; choose a reasonable default. A supplied start_thread records a brief only.\nRegistered projects: Sotto ${JSON.stringify(projectTarget('sotto'))}, root ${copies.sotto}; Relay ${JSON.stringify(projectTarget('relay'))}, root ${copies.relay}. Worker model: ${model}; default effort: ${effort}. For start_thread use requestId ${randomUUID()}, a fresh UUID retryKey and workingCopy {"kind":"shared"}.\n\n`
  }
}

/** Keep only key booleans; the model's reply and worker brief never leave memory. */
export function benchmarkKeys(task: BenchmarkTask, reply: string, starts: readonly CommandCenterToolInput<'start_thread'>[], startCalls: number): Record<string, boolean> {
  const text = reply.replace(/\\/gu, '/').replace(/[`*]/gu, '')
  const has = (path: string) => text.includes(path)
  if (task === 'roster') return { pendingQuestion: /Choose Android storage|android-storage/iu.test(text), readyPullRequest: /Theme contrast review|theme-review|#42|\bPR\s*42\b/iu.test(text) }
  if (task === 'locate') return { admissionFile: has('src/main/agents/commandCenterAdmission.ts'), codexWindowsVersion: /Codex/iu.test(text) && /Windows|win32/iu.test(text) && /0\.162\.0/u.test(text) }
  if (task === 'trace') return { sourceFile: has('src/main/agents/codex.ts'), exactNotice: text.includes('Codex stopped before this reply finished, so it may be cut short. Send a message to carry on.') }
  if (task === 'brief') {
    const start = starts[0], prompt = start?.firstPrompt.replace(/\\/gu, '/') ?? ''
    return { startedOnce: startCalls === 1 && starts.length === 1, correctProject: start?.project.projectId === 'sotto' && start.project.hostId === BENCHMARK_HOST_ID,
      demoFlag: prompt.includes('demoFlag'), settingsFile: prompt.includes('src/shared/settings.ts'), patchAllowList: prompt.includes('src/main/ipc/registerIpc.ts') && /allow.?list/iu.test(prompt), ipcTest: /tests\/integration\/(?:ipc\.test\.ts|ipc\/settings[^\s`]*\.test\.ts)/u.test(prompt) }
  }
  const sottoSections = [...text.matchAll(/\bSotto\b(?:(?!\bRelay\b)[\s\S]){0,800}/giu)].map(match => match[0])
  const sottoZod = sottoSections.some(section => /\bzod\b/iu.test(section) && /runtime|dependenc|declares?|uses?|depends/iu.test(section)
    && !/\b(?:does not|doesn't|no|not|without|neither)\b[^.\n]{0,80}\bzod\b|\bzod\b[^.\n]{0,80}\b(?:absent|missing|not a runtime)\b/iu.test(section))
  const relaySections = [...text.matchAll(/\bRelay\b(?:(?!\bSotto\b)[\s\S]){0,800}/giu)].map(match => match[0].replace(/[*_]/gu, ''))
  const relayNoZod = relaySections.some(section => /no runtime dependencies|no (?:runtime )?dependency|\bno\b[^.\n]{0,80}\bzod\b|(?:does not|doesn.t) (?:declare|use|include|list|have)[^.\n]{0,80}\bzod\b|\bzod\b[^.\n]{0,80}(?:not (?:declared|listed|present)|absent|missing)|^Relay\s*[:|–-]\s*No\b|dependencies[^\n]{0,30}\{\s*\}/iu.test(section))
  return { sottoZod: sottoZod && has('package.json'), sottoSettings: has('src/shared/settings.ts'), relayNoZod, relayConfig: has('src/config.ts') }
}
