// @vitest-environment node
// Phase 4 cross-language live integration test: connects the compiled Rust `sotto-engine` binary
// to Sotto's real TypeScript `listenEngineServer` (`src/main/engine/transport.ts`) over a real
// Windows named pipe / Unix domain socket, verifying token authentication, RPC round-trips,
// live Codex turn execution & push broadcasts, ops, and clean shutdown (ADR-0210, ADR-0215).
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostFactsSource } from '../../src/main/agents/hostFacts'
import { GitStatusReader } from '../../src/main/agents/git/gitStatus'
import { PairedClients } from '../../src/main/agents/pairing'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { UsageService } from '../../src/main/agents/usageService'
import { UsageStore } from '../../src/main/agents/usageStore'
import type { AgentHost } from '../../src/main/agents/host'
import { PolicyStore } from '../../src/main/memory/policies'
import { MemoryStore } from '../../src/main/memory/store'
import { startRustLocalEngine } from '../../src/main/engine/rustLocalEngineClient'
import { CouncilStore } from '../../src/main/council/councilStore'
import { FilesService } from '../../src/main/files/service'
import { PluginAccounts, pluginAccountSlot } from '../../src/main/plugins/accounts'
import { MailGrants } from '../../src/main/plugins/mailGrants'
import { HeardSpending, monthOf } from '../../src/main/plugins/spending'
import { PluginUseRecord } from '../../src/main/plugins/useRecord'
import { CheckpointService } from '../../src/main/tools/checkpoints'
import type { CheckpointThread } from '../../src/main/tools/checkpointTypes'
import { SoundRecords } from '../../src/main/tools/elevenlabs/records'
import { GitChangesService } from '../../src/main/tools/gitChanges'
import { ModelRecords } from '../../src/main/tools/meshy/records'
import {
  createEngineEndpoint,
  generateEngineToken,
  listenEngineServer,
} from '../../src/main/engine/transport'
import { publicProviderEntityId } from '../../src/shared/agents'
import {
  councilChangedSchema,
  councilCommandResultSchema,
  councilEstimateSchema,
  councilViewsSchema,
} from '../../src/shared/council'
import { fileListingSchema, filePreviewSchema } from '../../src/shared/files'
import { hostMachineReportSchema } from '../../src/shared/hostFacts'
import { phonesStateSchema } from '../../src/shared/phones'
import {
  elevenLabsSpentSchema,
  meshyCreditsSchema,
  pluginAccountResultSchema,
  pluginAccountsSchema,
  pluginCopiesViewSchema,
  shownPluginUsesSchema,
  threadMailGrantsSchema,
} from '../../src/shared/plugins'
import { agentThreadWordsSchema } from '../../src/shared/threadWords'
import { toolsResultSchema } from '../../src/shared/tools'
import { drive, prepareFake } from '../referee/providers'
import { THREAD } from '../referee/scenario'

const RUN_RUST_HOST = process.env.SOTTO_TEST_RUST_HOST === '1'

async function findRustEngineBinary(): Promise<string> {
  const exe = process.platform === 'win32' ? 'sotto-engine.exe' : 'sotto-engine'
  const cargoTargetDir = process.env.CARGO_TARGET_DIR
  const candidates = [
    ...(cargoTargetDir ? [join(cargoTargetDir, 'debug', exe), join(cargoTargetDir, 'release', exe)] : []),
    resolve('target', 'debug', exe),
    resolve('target', 'release', exe),
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try next build location.
    }
  }
  throw new Error(`Could not find compiled Rust ${exe}. Run cargo build -p sotto-engine --bin sotto-engine first.`)
}

describe.skipIf(!RUN_RUST_HOST)('Rust local desktop engine (sotto-engine, Phase 4 / ADR-0215)', () => {
  it('authenticates over EngineTransport, runs a full Codex turn with live pushes, serves ops, and shuts down cleanly', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-engine-'))
    await prepareFake(dataDir, 'codex')
    await writeFile(join(dataDir, 'hello.txt'), 'Hello from local desktop engine', 'utf8')

    const endpoint = createEngineEndpoint('se')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)

    const child = spawn(
      binary,
      ['--data', dataDir, '--endpoint', endpoint, '--fake', 'codex', '--fixtures-dir', resolve('tests/fixtures')],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
      },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      const conn = await server.waitForClient(15_000)
      const pushes: { event: string; payload: unknown }[] = []
      conn.onPush((event, payload) => { pushes.push({ event, payload }) })

      // 1. Ping confirms Rust runtime.
      const ping = await conn.request<{ ok: boolean; runtime: string; pid: number }>('engine.ping')
      expect(ping.ok).toBe(true)
      expect(ping.runtime).toBe('rust')
      expect(ping.pid).toBeGreaterThan(0)

      // 2. Wait for Codex provider to connect inside `sotto-engine`.
      const deadline = Date.now() + 15_000
      let connected = false
      while (Date.now() < deadline) {
        const shell = await conn.request<{ host: { providers: { id: string; connection: string }[] } }>('agent.snapshot')
        if (shell.host.providers.some(p => p.id === 'codex' && p.connection === 'connected')) {
          connected = true
          break
        }
        await new Promise(r => setTimeout(r, 25))
      }
      expect(connected, `Codex never connected in sotto-engine: ${stderr}`).toBe(true)

      // 3. Create project + thread + send prompt via EngineTransport RPC.
      const afterProj = await conn.request<{ host: { projects: { id: string; path: string }[] } }>('agent.command', [{
        type: 'create-project',
        provider: 'codex',
        title: 'Local Engine Project',
        path: dataDir,
        useExisting: true,
      }])
      const projectId = afterProj.host.projects.find(p => p.path === dataDir)!.id

      await conn.request('agent.command', [{
        type: 'create-thread',
        threadId: THREAD,
        projectId,
        title: 'Local Engine Thread',
        titleSource: 'user',
        modelId: publicProviderEntityId('codex', 'model', 'fixture-model'),
        workingCopy: 'shared',
        managed: false,
      }])

      await conn.request('agent.command', [{
        type: 'manual-send',
        threadId: THREAD,
        text: 'Hello local Rust engine',
      }])

      await drive(dataDir, 'codex', { type: 'complete', thread: THREAD, text: 'Reply from local Rust engine' })

      // Wait for the live `detail` push itself (and stored detail) to carry the completed reply.
      const replyDeadline = Date.now() + 15_000
      let pushedReply = false
      while (Date.now() < replyDeadline) {
        pushedReply = pushes.some(p => {
          if (p.event !== 'detail' || !p.payload || typeof p.payload !== 'object') return false
          const detailPayload = p.payload as { threadId?: string; messages?: { role?: string; text?: string }[] }
          return detailPayload.threadId === THREAD && !!detailPayload.messages?.some(
            m => m.role === 'assistant' && typeof m.text === 'string' && m.text.includes('Reply from local Rust engine'),
          )
        })
        if (pushedReply) break
        await new Promise(r => setTimeout(r, 25))
      }
      expect(pushedReply).toBe(true)
      expect(pushes.some(p => p.event === 'shell')).toBe(true)
      const detail = await conn.request<{ messages: { role: string; text: string }[] }>('agent.detail', [THREAD])
      expect(detail?.messages?.some(m => m.role === 'assistant' && m.text.includes('Reply from local Rust engine'))).toBe(true)

      // 4. Native ops over EngineTransport validated against real TS Zod schemas.
      const facts = hostMachineReportSchema.parse(await conn.request('ops.hostFacts'))
      expect(facts.facts.logicalCpuCount).toBeGreaterThanOrEqual(1)

      const listing = toolsResultSchema(fileListingSchema).parse(
        await conn.request('ops.threadFiles', [THREAD, '']),
      )
      expect(listing.ok).toBe(true)
      if (!listing.ok) throw new Error('expected ok threadFiles listing')
      const preview = toolsResultSchema(filePreviewSchema).parse(
        await conn.request('ops.threadFilePreview', [THREAD, 'hello.txt', listing.value.workspace.workspaceId]),
      )
      expect(preview.ok).toBe(true)
      if (preview.ok && preview.value.content.kind === 'text') {
        expect(preview.value.content.text).toBe('Hello from local desktop engine')
      }

      // 5. Unknown RPC method returns a structured serialized error without tearing down the link.
      await expect(conn.request('engine.noSuchMethod')).rejects.toThrow(/ENGINE_METHOD_UNHANDLED/)

      // 6. Clean shutdown exits 0.
      const down = await conn.request<{ ok: boolean }>('engine.shutdown')
      expect(down.ok).toBe(true)
      const code = await exited
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited.catch(() => undefined)
      }
      await server.close()
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('rejects a sotto-engine client presenting the wrong authentication token', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-engine-auth-'))
    const endpoint = createEngineEndpoint('sea')
    const expectedToken = generateEngineToken()
    const wrongToken = generateEngineToken()
    const server = await listenEngineServer(endpoint, expectedToken)

    const child = spawn(binary, ['--data', dataDir, '--endpoint', endpoint], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      env: { ...process.env, SOTTO_ENGINE_TOKEN: wrongToken },
    })
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      await expect(server.waitForClient(2_000)).rejects.toThrow()
      // Server destroyed the unauthenticated socket, so sotto-engine observes EOF and exits cleanly.
      const code = await exited
      expect(code).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited.catch(() => undefined)
      }
      await server.close()
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 15_000)

  it('prints runtime and version JSON with --version', async () => {
    const binary = await findRustEngineBinary()
    const stdout = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
    const parsed = JSON.parse(stdout) as { runtime?: unknown; version?: unknown }
    expect(parsed.runtime).toBe('rust')
    expect(typeof parsed.version).toBe('string')
    expect((parsed.version as string).length).toBeGreaterThan(0)
  })

  it('runs --accelerator mode via startRustLocalEngine over EngineTransport without creating workspace.json or engine.lock', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-accel-'))

    const store = new ThreadStore(join(dataDir, 'threads.sqlite'), undefined, null)
    store.open({ onMain: true })
    store.append('thread-1', {
      kind: 'message-added',
      at: '2026-11-22T10:00:00.000Z',
      message: {
        id: 'msg-1',
        role: 'user',
        text: 'Looking for rust accelerator parity across stores',
        createdAt: '2026-11-22T10:00:00.000Z',
      },
    })
    store.append('thread-1', {
      kind: 'message-added',
      at: '2026-11-22T10:01:00.000Z',
      message: {
        id: 'msg-2',
        role: 'assistant',
        text: 'Confirmed rust accelerator parity works read-only',
        createdAt: '2026-11-22T10:01:00.000Z',
      },
    })
    store.append('thread-wakeup-only', {
      kind: 'message-added',
      at: '2026-11-22T10:02:00.000Z',
      message: {
        id: 'msg-wake',
        role: 'user',
        text: 'Internal wake-up mentioning rust accelerator parity',
        createdAt: '2026-11-22T10:02:00.000Z',
      },
    })
    store.addWakeUp('thread-wakeup-only', 'msg-wake')
    store.close()

    const logs: string[] = []
    const client = await startRustLocalEngine({
      userDataPath: dataDir,
      isPackaged: false,
      binaryPath: binary,
      log: code => { logs.push(code) },
    })

    try {
      expect(client).toBeDefined()
      expect(logs).toContain('rust-engine-started')

      const facts = await client!.hostFacts(3)
      expect(facts).toBeDefined()
      expect(facts!.facts.logicalCpuCount).toBeGreaterThanOrEqual(1)
      expect(facts!.runningThreads).toBe(3)

      const words = await client!.searchThreadWords('rust accelerator parity')
      expect(words).toBeDefined()
      const parsed = agentThreadWordsSchema.parse(words)
      expect(parsed.found).toHaveLength(1)
      expect(parsed.found[0]).toMatchObject({
        threadId: 'thread-1',
        messageId: 'msg-2',
        role: 'assistant',
        more: 1,
      })

      const refs = await client!.gitRefs(dataDir)
      expect(refs).toBeDefined()
      expect(refs!.isRepository).toBe(false)

      // Accelerator mode is strictly read-only and must never create workspace.json or engine.lock.
      await expect(access(join(dataDir, 'workspace.json'))).rejects.toThrow()
      await expect(access(join(dataDir, 'engine.lock'))).rejects.toThrow()

      await client!.close()
      // Closed client transparently returns undefined so callers fall back to TypeScript.
      expect(await client!.searchThreadWords('rust')).toBeUndefined()
    } finally {
      await client?.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  it('offloads gitRefs, threadFiles, threadFilePreview, threadChanges, threadChangesReview, and live hostFacts through TS services with clean fallback', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-stage4a-data-'))
    const repoDir = await mkdtemp(join(tmpdir(), 'sotto-rust-stage4a-repo-'))
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })

    // Seed a real repository with main + feature branch, committed file, modified file, untracked file, binary, and PNG.
    git(['init', '-b', 'main'])
    await mkdir(join(repoDir, 'src'), { recursive: true })
    await writeFile(join(repoDir, 'README.md'), '# Stage 4a\nline one\n', 'utf8')
    await writeFile(join(repoDir, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
    // Minimal 1x1 PNG header + bytes so magic-byte image detection succeeds.
    const tinyPng = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    )
    await writeFile(join(repoDir, 'dot.png'), tinyPng)
    await writeFile(join(repoDir, 'raw.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    git(['add', '.'])
    git(['commit', '-m', 'Initial commit'])
    git(['checkout', '-b', 'feature/accel'])
    await writeFile(join(repoDir, 'src', 'app.ts'), 'export const value = 2\n', 'utf8')
    git(['add', 'src/app.ts'])
    git(['commit', '-m', 'Feature branch change'])
    // Working-tree edits: modify README.md with UTF-8 BOM + whitespace + text change, add untracked file.
    await writeFile(join(repoDir, 'README.md'), '\uFEFF# Stage 4a\n  line one\nline two\n', 'utf8')
    await writeFile(join(repoDir, 'notes.txt'), 'Untracked note\n', 'utf8')

    const client = await startRustLocalEngine({
      userDataPath: dataDir,
      isPackaged: false,
      binaryPath: binary,
    })

    try {
      expect(client).toBeDefined()

      // 1. Live hostFacts with real OS/memory/CPU sampling via HostFactsSource.
      const factsSource = new HostFactsSource()
      let rustFactsCalls = 0
      factsSource.useAccelerator(async live => {
        rustFactsCalls++
        return client!.hostFacts(2, live)
      })
      const facts = await factsSource.read()
      expect(rustFactsCalls).toBe(1)
      expect(facts.totalMemoryBytes).toBeGreaterThan(0)
      expect(facts.freeMemoryBytes).not.toBeNull()
      expect(facts.logicalCpuCount).toBeGreaterThanOrEqual(1)
      // Direct Rust-vs-Node host facts parity check.
      const nodeFacts = await new HostFactsSource().read()
      expect(facts.os.family).toBe(nodeFacts.os.family)
      expect(facts.architecture).toBe(nodeFacts.architecture)
      expect(facts.logicalCpuCount).toBe(nodeFacts.logicalCpuCount)
      expect(facts.totalMemoryBytes).toBe(nodeFacts.totalMemoryBytes)
      const load = await factsSource.load()
      expect(rustFactsCalls).toBe(2)
      expect(load.windowMs).toBeGreaterThanOrEqual(1)
      expect(load.cpuBusyPercent === null || (load.cpuBusyPercent >= 0 && load.cpuBusyPercent <= 100)).toBe(true)

      // 2. gitRefsByFolder returns real repository branches with current/default ordering.
      const refs = await client!.gitRefs(repoDir, { refresh: true })
      expect(refs).toBeDefined()
      expect(refs!.isRepository).toBe(true)
      expect(refs!.refs[0]).toMatchObject({ name: 'feature/accel', current: true })
      expect(refs!.refs.some(r => r.name === 'main' && r.isDefault)).toBe(true)

      // 3. FilesService offloads list & preview (markdown, image, binary refusal) while preserving TS workspaceId.
      let rustFileCalls = 0
      const files = new FilesService({
        resolveBinding: threadId => threadId === 't-4a' ? { threadId, projectId: 'p-4a', workingDirectory: repoDir } : null,
        copyPath: () => undefined,
        reveal: () => undefined,
        accelerator: {
          list: (ws, path) => { rustFileCalls++; return client!.threadFiles(ws, path) },
          preview: (ws, path) => { rustFileCalls++; return client!.threadFilePreview(ws, path) },
        },
      })
      const rootList = await files.list({ threadId: 't-4a', path: '' })
      expect(rootList.ok).toBe(true)
      if (!rootList.ok) throw new Error('expected ok root list')
      expect(rustFileCalls).toBe(1)
      const wsId = rootList.value.workspace.workspaceId
      expect(rootList.value.entries.some(e => e.name === 'README.md' && e.kind === 'file')).toBe(true)
      expect(rootList.value.entries.some(e => e.name === 'src' && e.kind === 'directory')).toBe(true)

      const mdPreview = await files.preview({ threadId: 't-4a', workspaceId: wsId, path: 'README.md' })
      expect(mdPreview.ok).toBe(true)
      // UTF-8 BOM stripped matching TS TextDecoder('utf-8').
      if (mdPreview.ok) expect(mdPreview.value.content).toEqual({ kind: 'markdown', text: '# Stage 4a\n  line one\nline two\n' })

      const pngPreview = await files.preview({ threadId: 't-4a', workspaceId: wsId, path: 'dot.png' })
      expect(pngPreview.ok).toBe(true)
      if (pngPreview.ok) expect(pngPreview.value.content).toMatchObject({ kind: 'image', mime: 'image/png' })

      const binPreview = await files.preview({ threadId: 't-4a', workspaceId: wsId, path: 'raw.bin' })
      expect(binPreview.ok).toBe(false)
      if (!binPreview.ok) expect(binPreview.error.code).toBe('binary')

      // 4. GitChangesService offloads list & working/branch review (including untracked files & ignoreWhitespace).
      let rustGitCalls = 0
      const gitChanges = new GitChangesService({
        files,
        copyPath: () => undefined,
        reveal: () => undefined,
        emit: () => undefined,
        accelerator: {
          list: ws => { rustGitCalls++; return client!.threadChanges(ws) },
          review: (ws, scope, ignoreWhitespace) => { rustGitCalls++; return client!.threadChangesReview(ws, scope, ignoreWhitespace) },
        },
      })
      const changes = await gitChanges.list({ threadId: 't-4a', workspaceId: wsId })
      expect(changes.ok).toBe(true)
      if (!changes.ok) throw new Error('expected ok changes list')
      expect(rustGitCalls).toBe(1)
      expect(changes.value.branch).toBe('feature/accel')
      expect(changes.value.files.some(f => f.path === 'README.md' && f.status === 'modified')).toBe(true)
      expect(changes.value.files.some(f => f.path === 'notes.txt' && f.status === 'untracked')).toBe(true)

      const workingReview = await gitChanges.review({
        threadId: 't-4a',
        workspaceId: wsId,
        scope: { kind: 'working' },
        ignoreWhitespace: true,
      })
      expect(workingReview.ok).toBe(true)
      if (!workingReview.ok) throw new Error('expected ok working review')
      expect(rustGitCalls).toBe(2)
      const untrackedDiff = workingReview.value.files.find(f => f.path === 'notes.txt')
      expect(untrackedDiff?.status).toBe('untracked')
      expect(untrackedDiff?.content.kind).toBe('text')
      expect(workingReview.value.hiddenWhitespace).toBeDefined()

      const branchReview = await gitChanges.review({
        threadId: 't-4a',
        workspaceId: wsId,
        scope: { kind: 'branch', base: 'main' },
      })
      expect(branchReview.ok).toBe(true)
      if (!branchReview.ok) throw new Error('expected ok branch review')
      expect(branchReview.value.scope).toMatchObject({ kind: 'branch', base: 'main', head: 'feature/accel' })
      expect(branchReview.value.files.some(f => f.path === 'src/app.ts' && f.status === 'modified')).toBe(true)

      // 5. After Rust accelerator closes, every TS service transparently falls back and matches Rust parity.
      await client!.close()
      const fallbackFiles = await files.preview({ threadId: 't-4a', workspaceId: wsId, path: 'README.md' })
      expect(fallbackFiles.ok).toBe(true)
      if (fallbackFiles.ok && mdPreview.ok) {
        expect(fallbackFiles.value.content).toEqual(mdPreview.value.content)
      }
      const fallbackChanges = await gitChanges.list({ threadId: 't-4a', workspaceId: wsId })
      expect(fallbackChanges.ok).toBe(true)
      if (fallbackChanges.ok) {
        expect(fallbackChanges.value.files).toEqual(changes.value.files)
        expect(fallbackChanges.value.branch).toBe(changes.value.branch)
      }
      gitChanges.dispose()
    } finally {
      await client?.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('supports Phase 2 full-duplex EngineTransport reverse-RPC, binary boxing, credentials sync, and engine:close', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-duplex-'))
    const endpoint = createEngineEndpoint('sed')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)

    const child = spawn(binary, ['--data', dataDir, '--endpoint', endpoint], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
    })
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      const conn = await server.waitForClient(15_000)
      const pushes: { event: string; payload: unknown }[] = []
      const reverseCalls: { method: string; args: readonly unknown[] }[] = []
      conn.onPush((event, payload) => { pushes.push({ event, payload }) })
      conn.onRequest((method, args) => {
        reverseCalls.push({ method, args })
        switch (method) {
          case 'shell:readWritingSettings':
            return { historyEnabled: true, formatting: 'auto' }
          case 'shell:clipboardWrite':
            return true
          case 'shell:openExternal':
            return true
          case 'shell:credentialsSet': {
            const [slot, value] = args as [string, string]
            return {
              available: true,
              plaintext: { [slot]: value },
              sealed: { [slot]: `sealed:${value}` },
              unreadable: {},
            }
          }
          case 'shell:redrawPhoto': {
            const [raw, kind] = args as [Uint8Array, string]
            expect(raw).toBeInstanceOf(Uint8Array)
            return { bytes: new Uint8Array([...raw, 0x99]), kind }
          }
          default:
            throw new Error(`UNEXPECTED_SHELL_METHOD: ${method}`)
        }
      })

      // 1. Phase 2 engine:init registers ShellBridgeClient and emits shell:log push.
      const initResult = await conn.request<{ metadata: { localHostId: string }; channels: unknown[]; hasWatcherBridge: boolean }>('engine:init', [{
        options: { userDataPath: dataDir },
        credentials: { available: false, plaintext: {}, sealed: { existing: 'enc' }, unreadable: {} },
        downloadsFolder: dataDir,
        browserToolDefinitions: [],
        hasNotify: true,
        hasMediaThumbnail: false,
        hasRedrawPhoto: true,
      }])
      expect(typeof initResult.metadata.localHostId).toBe('string')
      expect(initResult.metadata.localHostId.length).toBeGreaterThan(0)
      expect(initResult.hasWatcherBridge).toBe(false)

      // Wait briefly for shell:log push emitted during init.
      const logDeadline = Date.now() + 5_000
      while (Date.now() < logDeadline && !pushes.some(p => p.event === 'shell:log' && p.payload === 'rust-engine-initialized')) {
        await new Promise(r => setTimeout(r, 15))
      }
      expect(pushes.some(p => p.event === 'shell:log' && p.payload === 'rust-engine-initialized')).toBe(true)

      // 2. Shell -> Engine push updates window focus and credentials cache.
      conn.sendPush('engine:setWindowFocus', { focused: true, showing: true, blurredAt: 0 })
      let focus: { focused: boolean; showing: boolean } | undefined
      const focusDeadline = Date.now() + 5_000
      while (Date.now() < focusDeadline) {
        focus = await conn.request<{ focused: boolean; showing: boolean }>('engine:windowFocus')
        if (focus.focused && focus.showing) break
        await new Promise(r => setTimeout(r, 15))
      }
      expect(focus).toMatchObject({ focused: true, showing: true })

      conn.sendPush('shell:credentialsSync', {
        available: true,
        plaintext: { synced: 'val' },
        sealed: { synced: 'enc-val' },
        unreadable: {},
      })
      const credsDeadline = Date.now() + 5_000
      let hasSynced = { available: false, has: false }
      while (Date.now() < credsDeadline) {
        hasSynced = await conn.request<{ available: boolean; has: boolean }>('engine:credentialsHas', ['synced'])
        if (hasSynced.available && hasSynced.has) break
        await new Promise(r => setTimeout(r, 15))
      }
      expect(hasSynced).toEqual({ available: true, has: true })

      // 3. Engine -> Shell reverse-RPC calls (including boxed Uint8Array photo round-trip).
      const writing = await conn.request<{ historyEnabled: boolean; formatting: string }>('engine:readWritingSettings')
      expect(writing).toEqual({ historyEnabled: true, formatting: 'auto' })
      await conn.request('engine:clipboardWrite', ['copied text'])
      await conn.request('engine:openExternal', ['https://example.com'])
      await conn.request('engine:credentialsSet', ['plugin:p1', 'secret-1'])
      expect(await conn.request('engine:credentialsHas', ['plugin:p1'])).toEqual({ available: true, has: true })

      const redrawn = await conn.request<{ bytes: Uint8Array; kind: string }>('engine:redrawPhoto', [
        new Uint8Array([1, 2, 3]),
        'image/png',
      ])
      expect(redrawn.kind).toBe('image/png')
      expect(redrawn.bytes).toBeInstanceOf(Uint8Array)
      expect(Array.from(redrawn.bytes)).toEqual([1, 2, 3, 0x99])
      expect(reverseCalls.map(c => c.method)).toEqual([
        'shell:readWritingSettings',
        'shell:clipboardWrite',
        'shell:openExternal',
        'shell:credentialsSet',
        'shell:redrawPhoto',
      ])

      // 4. Phase 2 engine:perfReading & N1 shutdown-with-in-flight-reverse-call drain.
      const perf = await conn.request<{ blockedShare: number; freezesOver100ms: number }>('engine:perfReading')
      expect(perf.blockedShare).toBe(0)
      expect(perf.freezesOver100ms).toBe(0)

      // Start a reverse-RPC request that the shell holds briefly while `engine:close` arrives.
      // Because `sotto-engine` drains `rpc_tasks` BEFORE aborting `reader_task`, the shell's reply
      // still lands cleanly and the reverse-RPC succeeds before shutdown finishes.
      let releaseSlowShell!: (value: unknown) => void
      let slowShellStarted = false
      conn.onRequest((method, args) => {
        if (method === 'shell:readWritingSettings') {
          slowShellStarted = true
          return new Promise(resolve => { releaseSlowShell = resolve })
        }
        return reverseCalls.push({ method, args })
      })
      const inFlightReverse = conn.request<{ drained: boolean }>('engine:readWritingSettings')
      while (!slowShellStarted) await new Promise(r => setTimeout(r, 10))
      const closePromise = conn.request<boolean>('engine:close')
      await new Promise(r => setTimeout(r, 30))
      releaseSlowShell({ drained: true })
      expect(await inFlightReverse).toEqual({ drained: true })
      expect(await closePromise).toBe(true)
      expect(await exited).toBe(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited.catch(() => undefined)
      }
      await server.close()
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  it('preserves GIT_CONFIG_GLOBAL excludes, model-row sum ordering, and read-only memory policy checks', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-parity-fix-data-'))
    const repoDir = await mkdtemp(join(tmpdir(), 'sotto-rust-parity-fix-repo-'))
    const cfgDir = await mkdtemp(join(tmpdir(), 'sotto-rust-parity-fix-cfg-'))
    const excludesFile = join(cfgDir, 'global-ignore')
    const globalConfig = join(cfgDir, 'gitconfig')
    await writeFile(excludesFile, '*.log\n', 'utf8')
    await writeFile(globalConfig, `[core]\n\texcludesFile = ${excludesFile.replace(/\\/g, '/')}\n`, 'utf8')

    const prevGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig

    const git = (args: string[]) => execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })
    git(['init', '-b', 'main'])
    await writeFile(join(repoDir, 'tracked.txt'), 'init\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    await writeFile(join(repoDir, 'ignored.log'), 'should be excluded by GIT_CONFIG_GLOBAL\n', 'utf8')
    await writeFile(join(repoDir, 'visible.txt'), 'kept\n', 'utf8')

    // N6: Seed multi-bucket rows for two models where model A has small single rows summing to 1000
    // and model B has one larger row of 600 — both TS and Rust must rank model A first.
    const usageStore = new UsageStore(join(dataDir, 'usage.sqlite'))
    usageStore.open()
    for (let i = 0; i < 4; i++) {
      usageStore.observeTokens({
        providerId: 'claude',
        threadId: 't-n6',
        recordKey: `${'a'.repeat(63)}${i}`,
        modelId: 'claude-small-rows-big-sum',
        tokens: { input: 200, output: 50 },
        at: `2026-11-21T0${i}:05:00.000Z`,
        phase: 'live',
        partial: false,
      })
    }
    usageStore.observeTokens({
      providerId: 'claude',
      threadId: 't-n6',
      recordKey: 'b'.repeat(64),
      modelId: 'claude-one-medium-row',
      tokens: { input: 500, output: 100 },
      at: '2026-11-21T05:05:00.000Z',
      phase: 'live',
      partial: false,
    })
    const tsUsage = usageStore.query({ timeZone: 'UTC' })
    usageStore.close()

    // N8: Seed memory.sqlite with a remote-answer grant and verify read-only query.
    const memoryStore = new MemoryStore(join(dataDir, 'memory.sqlite'))
    memoryStore.open()
    const policyStore = new PolicyStore(memoryStore)
    policyStore.setRemoteAnswers('client-ro-1', true, 'test grant')
    memoryStore.close()

    const endpoint = createEngineEndpoint('sep')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    const child = spawn(
      binary,
      ['--data', dataDir, '--endpoint', endpoint, '--accelerator'],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
        env: { ...process.env, SOTTO_ENGINE_TOKEN: token, GIT_CONFIG_GLOBAL: globalConfig },
      },
    )
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      const conn = await server.waitForClient(15_000)

      // L5: GIT_CONFIG_GLOBAL excludes `ignored.log` identically in Rust and TS.
      const gitStatus = new GitStatusReader({ fetchIntervalMs: () => 60_000 })
      const tsChanged = await gitStatus.listChangedFiles(repoDir)
      const rustChanged = await conn.request('ops.gitChangedFiles', [repoDir, { timeoutMs: 9_000 }])
      expect(tsChanged.files.map(f => f.path)).toEqual(['visible.txt'])
      expect(rustChanged).toEqual(tsChanged)

      // N6: Model ordering parity by true summed tokens.
      const rustUsage = await conn.request<{ models: { modelId: string }[] }>('ops.usageQuery', [{ timeZone: 'UTC' }])
      expect(tsUsage.models.map(m => m.modelId)).toEqual(['claude-small-rows-big-sum', 'claude-one-medium-row'])
      expect(rustUsage).toEqual(tsUsage)

      // N8: Read-only ops.memoryMayGrantRemote succeeds without write locks.
      expect(await conn.request('ops.memoryMayGrantRemote', ['client-ro-1'])).toEqual({ allowed: true })
      expect(await conn.request('ops.memoryMayGrantRemote', ['client-unknown'])).toEqual({ allowed: false })

      await conn.request('engine.shutdown')
      expect(await exited).toBe(0)
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await exited.catch(() => undefined)
      }
      await server.close()
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(cfgDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)

  it('offloads usageQuery and gitChangedFiles with exact TypeScript parity and transparent fallback', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-usage-git-data-'))
    const repoDir = await mkdtemp(join(tmpdir(), 'sotto-rust-usage-git-repo-'))
    const git = (args: string[]) => execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    })

    // Seed git repo with modified, renamed, untracked text, and untracked binary files.
    git(['init', '-b', 'main'])
    await writeFile(join(repoDir, 'z.txt'), 'line1\nline2\n', 'utf8')
    await writeFile(join(repoDir, 'orig.txt'), 'hello\n', 'utf8')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
    await writeFile(join(repoDir, 'z.txt'), 'line1\nline2\nline3\n', 'utf8')
    git(['mv', 'orig.txt', 'renamed.txt'])
    await writeFile(join(repoDir, 'a-new.txt'), 'one\ntwo\n', 'utf8')
    await writeFile(join(repoDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))

    // Seed usage.sqlite using the real TypeScript UsageStore.
    const store = new UsageStore(join(dataDir, 'usage.sqlite'))
    const usageService = new UsageService({
      directory: dataDir,
      host: { subscribe: () => () => undefined } as unknown as AgentHost,
      store,
    })
    usageService.start()
    usageService.submitPrompt({
      providerId: 'claude',
      threadId: 'thread-usage-1',
      messageId: 'msg-u1',
      modelId: 'claude-opus-4-6-20261101',
      at: '2026-11-21T02:05:00.000Z',
      kind: 'user',
      inputKind: 'send',
    })
    usageService.acceptPrompt('thread-usage-1', 'msg-u1')

    const client = await startRustLocalEngine({
      userDataPath: dataDir,
      isPackaged: false,
      binaryPath: binary,
    })

    try {
      expect(client).toBeDefined()

      // 1. Compare TS UsageService read vs Rust accelerated read.
      const tsRead = await usageService.read({ timeZone: 'America/Los_Angeles' })
      expect(tsRead.status).toBe('ready')

      let rustUsageCalls = 0
      usageService.useQueryAccelerator(async query => {
        rustUsageCalls++
        return client!.usageQuery(query)
      })
      const rustRead = await usageService.read({ timeZone: 'America/Los_Angeles' })
      expect(rustUsageCalls).toBe(1)
      expect(rustRead.status).toBe('ready')
      expect(rustRead.activity).toEqual(tsRead.activity)

      // 2. Compare TS GitStatusReader.listChangedFiles vs Rust client.gitChangedFiles.
      const gitStatus = new GitStatusReader({ fetchIntervalMs: () => 60_000 })
      const tsChanged = await gitStatus.listChangedFiles(repoDir)
      const rustChanged = await client!.gitChangedFiles(repoDir)
      expect(rustChanged).toEqual(tsChanged)

      // 3. After closing Rust client, UsageService transparently falls back to TypeScript.
      await client!.close()
      const afterCloseRead = await usageService.read({ timeZone: 'America/Los_Angeles' })
      expect(afterCloseRead.status).toBe('ready')
      expect(afterCloseRead.activity).toEqual(tsRead.activity)
      expect(await client!.gitChangedFiles(repoDir)).toBeUndefined()
    } finally {
      usageService.close()
      await client?.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('offloads checkpoint blob inspection and shares on-disk checkpoint storage bidirectionally between TypeScript and Rust', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-cp-data-'))
    const repoDir = await mkdtemp(join(tmpdir(), 'sotto-rust-cp-repo-'))
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    }
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, env: gitEnv })
    await writeFile(join(repoDir, 'app.txt'), 'line 1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: repoDir, env: gitEnv })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, env: gitEnv })

    const client = await startRustLocalEngine({
      userDataPath: dataDir,
      isPackaged: false,
      binaryPath: binary,
    })
    const files = new FilesService({
      resolveBinding: () => ({ threadId: 't-cp', projectId: 'p-cp', workingDirectory: repoDir }),
      copyPath: () => undefined,
      reveal: () => undefined,
      open: async () => undefined,
    })
    const resolvedWs = await files.resolveWorkspace('t-cp')
    expect(resolvedWs.ok).toBe(true)
    if (!resolvedWs.ok) throw new Error('expected ok workspace')
    const wsId = resolvedWs.value.workspaceId
    let userMessages = ['u1']
    const resolveThread = async (): Promise<CheckpointThread> => ({
      threadId: 't-cp',
      providerId: 'codex',
      bindingId: 'codex:cp-1',
      userMessageIds: [...userMessages],
      busy: false,
      running: false,
      rollbackSupported: true,
    })
    let rustInspectCalls = 0
    const tsCheckpoints = new CheckpointService({
      files,
      directory: join(dataDir, 'checkpoints'),
      resolveThread,
      rollback: async () => ({ accepted: true }),
      refresh: async () => undefined,
      inspectAccelerator: (blobsDir, pairs) => {
        rustInspectCalls++
        return client!.checkpointInspectBlobs(blobsDir, pairs)
      },
    })

    // Also test full-mode Rust engine reading TS-written checkpoints and writing Rust checkpoints back.
    const endpoint = createEngineEndpoint('secp')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    let child: ReturnType<typeof spawn> | undefined

    try {
      expect(client).toBeDefined()
      await tsCheckpoints.initialize()
      await tsCheckpoints.beforeTurn('t-cp')
      await writeFile(join(repoDir, 'app.txt'), 'line 1\nline 2\n', 'utf8')
      await writeFile(join(repoDir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
      userMessages = ['u1', 'u2']
      await tsCheckpoints.afterTurn('t-cp')

      const listed = await tsCheckpoints.checkpoints({ threadId: 't-cp', workspaceId: wsId })
      expect(listed.ok).toBe(true)
      if (!listed.ok) throw new Error('expected ok listing')
      const cpId = listed.value.checkpoints[0]!.id

      // 1. TS CheckpointService offloads blob verification & decoding to Rust --accelerator.
      const inspectedRust = await tsCheckpoints.inspectCheckpoint({
        threadId: 't-cp',
        workspaceId: wsId,
        checkpointId: cpId,
      })
      expect(rustInspectCalls).toBe(1)
      expect(inspectedRust.ok).toBe(true)
      if (!inspectedRust.ok) throw new Error('expected ok inspection')
      expect(inspectedRust.value.patches).toEqual([
        { path: 'app.txt', before: 'line 1\n', after: 'line 1\nline 2\n', binary: false },
        { path: 'bin.dat', before: null, after: null, binary: true },
      ])

      // 2. After closing the accelerator, TS transparently falls back with identical output.
      await client!.close()
      const inspectedTs = await tsCheckpoints.inspectCheckpoint({
        threadId: 't-cp',
        workspaceId: wsId,
        checkpointId: cpId,
      })
      expect(inspectedTs).toEqual(inspectedRust)
      if (!inspectedTs.ok) throw new Error('expected ok TS inspection')

      // 3. Full-mode Rust sotto-engine loads the exact TS-created checkpoints.json/blobs,
      // inspects it, restores files, and writes a new checkpoint that TS can read back.
      child = spawn(binary, ['--data', dataDir, '--endpoint', endpoint], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
      })
      const exited = new Promise<number | null>(resolveExit => child!.once('exit', code => resolveExit(code)))
      const conn = await server.waitForClient(15_000)

      const threadInfo = {
        threadId: 't-cp',
        providerId: 'codex',
        bindingId: 'codex:cp-1',
        userMessageIds: ['u1', 'u2'],
        busy: false,
        running: false,
        rollbackSupported: true,
      }
      const rustList = await conn.request<{ ok: boolean; value: { checkpoints: { id: string; status: string }[] } }>(
        'checkpoints.list',
        ['t-cp', wsId, threadInfo],
      )
      expect(rustList.ok).toBe(true)
      expect(rustList.value.checkpoints.some(c => c.id === cpId && c.status === 'ready')).toBe(true)

      const rustInspect = await conn.request<{ ok: boolean; value: { patches: unknown[] } }>(
        'checkpoints.inspect',
        ['t-cp', wsId, cpId, threadInfo],
      )
      expect(rustInspect.ok).toBe(true)
      expect(rustInspect.value.patches).toEqual(inspectedTs.value.patches)

      // Rust restores the TS-captured checkpoint back to initial repo state.
      const rustRestore = await conn.request<{ ok: boolean; value?: { record: { status: string } }; error?: unknown }>(
        'checkpoints.restore',
        [cpId],
      )
      expect(rustRestore.ok, `checkpoints.restore failed: ${JSON.stringify(rustRestore)}`).toBe(true)
      expect(rustRestore.value!.record.status).toBe('reverted')

      // Rust captures a brand-new checkpoint; a fresh TS CheckpointService reads & inspects it.
      const rustBefore = await conn.request<{ ok: boolean; error?: unknown }>('checkpoints.beforeTurn', [threadInfo, wsId, repoDir])
      expect(rustBefore.ok, `checkpoints.beforeTurn failed: ${JSON.stringify(rustBefore)}`).toBe(true)
      await writeFile(join(repoDir, 'app.txt'), 'written-for-rust-cp\n', 'utf8')
      const threadAfter = { ...threadInfo, userMessageIds: ['u1', 'u2', 'u3'] }
      const rustAfter = await conn.request<{ ok: boolean; value?: { record: { id: string; status: string } }; error?: unknown }>(
        'checkpoints.afterTurn',
        [threadAfter],
      )
      expect(rustAfter.ok, `checkpoints.afterTurn failed: ${JSON.stringify(rustAfter)}`).toBe(true)
      expect(rustAfter.value!.record.status).toBe('ready')
      const rustCpId = rustAfter.value!.record.id

      await conn.request('engine:close', [])
      expect(await exited).toBe(0)
      conn.close()

      userMessages = ['u1', 'u2', 'u3']
      const tsReloaded = new CheckpointService({
        files,
        directory: join(dataDir, 'checkpoints'),
        resolveThread,
        rollback: async () => ({ accepted: true }),
        refresh: async () => undefined,
      })
      try {
        await tsReloaded.initialize()
        const tsReadsRust = await tsReloaded.inspectCheckpoint({
          threadId: 't-cp',
          workspaceId: wsId,
          checkpointId: rustCpId,
        })
        expect(tsReadsRust.ok).toBe(true)
        if (tsReadsRust.ok) {
          expect(tsReadsRust.value.patches).toEqual([
            { path: 'app.txt', before: 'line 1\n', after: 'written-for-rust-cp\n', binary: false },
          ])
        }
      } finally {
        tsReloaded.dispose()
      }
    } finally {
      tsCheckpoints.dispose()
      await client?.close().catch(() => undefined)
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await server.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(repoDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('runs PhoneAccess and LocalApps natively in sotto-engine with TypeScript on-disk, HTTP, and policy parity', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-phones-'))

    // Pre-seed a phone paired by TypeScript `PairedClients` + `PolicyStore` in `memory.sqlite`.
    const tsPairing = new PairedClients(dataDir)
    await tsPairing.load()
    const tsCode = tsPairing.issuePairingCode()
    const tsPaired = await tsPairing.redeem(tsCode.code, 'TS Seeded iPhone')
    const memStore = new MemoryStore(join(dataDir, 'memory.sqlite'))
    memStore.open()
    const tsPolicy = new PolicyStore(memStore)
    tsPolicy.ensureRemoteAnswers(tsPaired.clientId, 'Seeded by TS test')
    memStore.close()

    const endpoint = createEngineEndpoint('seph')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    const child = spawn(binary, ['--data', dataDir, '--endpoint', endpoint], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
    })
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      const conn = await server.waitForClient(15_000)

      // 1. `phones:get` validates against `phonesStateSchema` and reads TS-seeded phone & policy.
      const rawPhones = await conn.request('phones:get', [])
      const parsedPhones = phonesStateSchema.parse(rawPhones)
      expect(parsedPhones.enabled).toBe(false)
      expect(parsedPhones.phase).toBe('off')
      expect(parsedPhones.phones).toHaveLength(1)
      expect(parsedPhones.phones[0]).toMatchObject({
        clientId: tsPaired.clientId,
        name: 'TS Seeded iPhone',
        canAnswer: true,
      })
      expect(await conn.request('engine:phoneAccessPagePort', [])).toBeNull()

      // 2. `phones:command({ type: 'remove' })` revokes both `paired-clients.json` and `memory.sqlite`.
      const afterRemove = phonesStateSchema.parse(
        await conn.request('phones:command', [{ type: 'remove', clientId: tsPaired.clientId }]),
      )
      expect(afterRemove.phones).toHaveLength(0)

      const tsPairingCheck = new PairedClients(dataDir)
      await tsPairingCheck.load()
      expect(tsPairingCheck.list()).toHaveLength(0)
      const memCheck1 = new MemoryStore(join(dataDir, 'memory.sqlite'))
      memCheck1.open()
      const polCheck1 = new PolicyStore(memCheck1)
      expect(polCheck1.mayGrant({ clientId: tsPaired.clientId, user: '', transport: 'socket' }).allowed).toBe(false)
      memCheck1.close()

      // 3. `local-apps:settingsChanged({ localApps: true })` opens loopback listener, writes `local-apps.json`
      // + `local-apps/paired-clients.json`, grants remote-answer policy, and serves protocol v1 HTTP.
      const laOn = await conn.request<{ phase: string; localHostRunning: boolean }>(
        'local-apps:settingsChanged',
        [{ localApps: true }],
      )
      expect(laOn).toEqual({ phase: 'on', localHostRunning: true })

      const laFile = JSON.parse(await readFile(join(dataDir, 'local-apps.json'), 'utf8')) as {
        version: number; port: number; token: string; clientId: string
      }
      expect(laFile.version).toBe(1)
      expect(laFile.port).toBeGreaterThan(0)

      // TypeScript PairedClients + PolicyStore agree with Rust's written files.
      const tsLaPairing = new PairedClients(join(dataDir, 'local-apps'))
      await tsLaPairing.load()
      expect(tsLaPairing.verifyToken(laFile.token)).toBe(laFile.clientId)
      const memCheck2 = new MemoryStore(join(dataDir, 'memory.sqlite'))
      memCheck2.open()
      expect(new PolicyStore(memCheck2).mayGrant({ clientId: laFile.clientId, user: '', transport: 'socket' }).allowed).toBe(true)
      memCheck2.close()

      // Live protocol v1 HTTP round-trip (`/v1/health`, `/v1/session`, `/v1/state`) against Rust listener.
      const healthRes = await fetch(`http://127.0.0.1:${laFile.port}/v1/health`)
      expect(healthRes.status).toBe(200)
      const health = await healthRes.json() as { ok: boolean; protocolVersion: number; pairing: boolean }
      expect(health.ok).toBe(true)
      expect(health.protocolVersion).toBe(1)
      expect(health.pairing).toBe(false)

      const sessRes = await fetch(`http://127.0.0.1:${laFile.port}/v1/session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${laFile.token}` },
      })
      expect(sessRes.status).toBe(200)
      const sess = await sessRes.json() as { session: string; clientId: string }
      expect(sess.clientId).toBe(laFile.clientId)

      const stateRes = await fetch(`http://127.0.0.1:${laFile.port}/v1/state`, {
        headers: { Authorization: `Bearer ${sess.session}` },
      })
      expect(stateRes.status).toBe(200)
      const stateJson = await stateRes.json() as { host?: { hostId?: string } }
      expect(typeof stateJson.host?.hostId).toBe('string')

      // 4. Turning LocalApps off revokes policy and deletes `local-apps.json`.
      const laOff = await conn.request<{ phase: string; localHostRunning: boolean }>(
        'local-apps:settingsChanged',
        [{ localApps: false }],
      )
      expect(laOff).toEqual({ phase: 'off', localHostRunning: true })
      await expect(access(join(dataDir, 'local-apps.json'))).rejects.toThrow()
      const memCheck3 = new MemoryStore(join(dataDir, 'memory.sqlite'))
      memCheck3.open()
      expect(new PolicyStore(memCheck3).mayGrant({ clientId: laFile.clientId, user: '', transport: 'socket' }).allowed).toBe(false)
      memCheck3.close()

      await conn.request('engine:close', [])
      expect(await exited).toBe(0)
      conn.close()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await server.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('serves local plugin accounts, use records, mail grants, copy choices, and spending parity across TS and Rust', async () => {
    const binary = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-plugins-'))
    const now = new Date()
    const nowIso = now.toISOString()
    const month = monthOf(now)

    // Seed plugin stores via TypeScript classes.
    const secrets = new Map<string, string>()
    const tsAccounts = new PluginAccounts(dataDir, {
      credentials: {
        has: slot => secrets.has(slot),
        get: slot => secrets.get(slot) ?? '',
        set: async (slot, value) => { if (value) secrets.set(slot, value); else secrets.delete(slot) },
      },
      check: async () => ({ ok: true, signedInAs: 'zach-user' }),
    })
    const addMail = await tsAccounts.add({
      plugin: 'gmail',
      name: 'Work Gmail',
      secret: 'abcd efgh ijkl mnop',
      address: 'zach@example.com',
    })
    expect(addMail.ok).toBe(true)
    const addMeshy = await tsAccounts.add({ plugin: 'meshy', name: 'Studio Meshy', secret: 'msy_key' })
    expect(addMeshy.ok).toBe(true)
    const addEleven = await tsAccounts.add({ plugin: 'elevenlabs', name: 'Voice Lab', secret: 'el_key' })
    expect(addEleven.ok).toBe(true)
    const seededAccounts = await tsAccounts.list()
    const mailAcc = seededAccounts.find(a => a.plugin === 'gmail')!
    const meshyAcc = seededAccounts.find(a => a.plugin === 'meshy')!
    const elevenAcc = seededAccounts.find(a => a.plugin === 'elevenlabs')!

    const tsUses = new PluginUseRecord(dataDir, { historyEnabled: () => true })
    await tsUses.add({ threadId: 't-plug', plugin: 'gmail', accountId: mailAcc.id, tool: 'plugin_read', kind: 'mail-search', outcome: 'done' })

    const tsGrants = new MailGrants(dataDir, { open: () => true })
    expect(await tsGrants.grant('t-plug', mailAcc.id)).toBe(true)
    tsGrants.close()

    const tsModels = new ModelRecords(dataDir, { historyEnabled: () => true })
    await tsModels.add({
      id: 'm-1',
      threadId: 't-plug',
      accountId: meshyAcc.id,
      name: 'Oak barrel',
      source: { kind: 'words', words: 'Oak barrel' },
      root: dataDir,
      folder: join(dataDir, 'models'),
      formats: ['glb', 'usdz'],
      state: 'done',
      credits: 30,
      askedAt: nowIso,
      endedAt: nowIso,
      files: ['oak-barrel.glb'],
      job: { preview: 'task-1' },
    })
    const tsSounds = new SoundRecords(dataDir, { historyEnabled: () => true })
    await tsSounds.add({
      id: 's-1',
      threadId: 't-plug',
      accountId: elevenAcc.id,
      kind: 'effect',
      name: 'Doorbell',
      words: 'Doorbell chime',
      folder: 'sounds',
      fileName: 'doorbell.mp3',
      bytes: 1234,
      cost: 0.25,
      askedAt: nowIso,
      state: 'made',
    })
    const tsMeshyHeard = new HeardSpending(join(dataDir, 'plugin-meshy-spending.json'))
    await tsMeshyHeard.hear('host-remote', [{
      accountId: meshyAcc.id,
      month,
      credits: 45,
      session: '11111111-1111-4111-8111-111111111111',
      revision: 1,
    }])
    const tsElevenHeard = new HeardSpending(join(dataDir, 'plugin-elevenlabs-spending.json'))
    await tsElevenHeard.hear('host-remote', [{
      accountId: elevenAcc.id,
      month,
      credits: 50, // cents = $0.50
      session: '22222222-2222-4222-8222-222222222222',
      revision: 1,
    }])

    const endpoint = createEngineEndpoint('sepl')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    const child = spawn(binary, ['--data', dataDir, '--endpoint', endpoint], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
    })
    const exited = new Promise<number | null>(resolveExit => child.once('exit', code => resolveExit(code)))

    try {
      const conn = await server.waitForClient(15_000)
      conn.onRequest((method, args) => {
        if (method === 'shell:credentialsSet') {
          const [slot, val] = args as [string, string]
          if (val) secrets.set(slot, val)
          else secrets.delete(slot)
          return {
            available: true,
            plaintext: Object.fromEntries(secrets),
            sealed: Object.fromEntries([...secrets].map(([k, v]) => [k, `sealed:${v}`])),
            unreadable: {},
          }
        }
        throw new Error(`UNEXPECTED_SHELL_METHOD: ${method}`)
      })

      // Sync credentials snapshot into Rust ShellBridgeClient.
      const initRes = await conn.request('engine:init', [{
        options: { userDataPath: dataDir },
        credentials: {
          available: true,
          plaintext: Object.fromEntries(secrets),
          sealed: Object.fromEntries([...secrets].map(([k, v]) => [k, `sealed:${v}`])),
          unreadable: {},
        },
        downloadsFolder: dataDir,
        browserToolDefinitions: [],
        hasNotify: false,
        hasMediaThumbnail: false,
        hasRedrawPhoto: false,
      }])
      expect(initRes).toBeDefined()

      // 1. Accounts read & update (including `projects: null` clearing and spending limit update).
      const rustAccounts = pluginAccountsSchema.parse(await conn.request('sotto:plugins:accounts', []))
      expect(rustAccounts).toHaveLength(3)
      const updatedRes = pluginAccountResultSchema.parse(
        await conn.request('sotto:plugins:account-update', [{
          id: meshyAcc.id,
          askBefore: false,
          monthlyLimit: 2500,
          projects: ['proj-a'],
        }]),
      )
      expect(updatedRes.ok).toBe(true)
      const clearedProjectsRes = pluginAccountResultSchema.parse(
        await conn.request('sotto:plugins:account-update', [{
          id: meshyAcc.id,
          projects: null,
        }]),
      )
      expect(clearedProjectsRes.ok).toBe(true)
      if (clearedProjectsRes.ok) {
        const updatedMeshy = clearedProjectsRes.accounts.find(a => a.id === meshyAcc.id)!
        expect(updatedMeshy.projects).toBeNull()
        expect(updatedMeshy.spending).toEqual({ askBefore: false, monthlyLimit: 2500 })
      }

      // 2. Recent use, mail grants & stop, copies, Meshy credits, ElevenLabs spent, 3D models & sounds.
      const recentUse = shownPluginUsesSchema.parse(await conn.request('sotto:plugins:recent-use', []))
      expect(recentUse).toHaveLength(1)
      expect(recentUse[0]!.plugin).toBe('gmail')

      const mailGrants = threadMailGrantsSchema.parse(
        await conn.request('sotto:plugins:mail-grants', [{ threadId: 't-plug' }]),
      )
      expect(mailGrants).toEqual([{ accountId: mailAcc.id, plugin: 'gmail', name: 'Work Gmail' }])

      expect(await conn.request('sotto:plugins:mail-grant-stop', [{ threadId: 't-plug', accountId: mailAcc.id }])).toBe(true)
      expect(await conn.request('sotto:plugins:mail-grants', [{ threadId: 't-plug' }])).toEqual([])

      const copies = pluginCopiesViewSchema.parse(
        await conn.request('sotto:plugins:copy-new-set', [{ copyNew: false }]),
      )
      expect(copies.copyNew).toBe(false)
      expect(copies.readable).toBe(true)

      const meshyCredits = meshyCreditsSchema.parse(await conn.request('sotto:plugins:meshy-credits', []))
      expect(meshyCredits[meshyAcc.id]).toEqual({ here: 30, credits: 75, across: ['host-remote'] })

      const elevenSpent = elevenLabsSpentSchema.parse(await conn.request('sotto:plugins:elevenlabs-spent', []))
      expect(elevenSpent[elevenAcc.id]!.spent).toBeCloseTo(0.75, 5)
      expect(elevenSpent[elevenAcc.id]!.across).toEqual(['host-remote'])

      const models = await conn.request<Array<{ id: string; job?: unknown }>>('sotto:plugins:models-3d', [{ threadId: 't-plug' }])
      expect(models).toHaveLength(1)
      expect(models[0]!.id).toBe('m-1')
      expect(models[0]!.job).toBeUndefined()

      const sound = await conn.request<{ id: string; name: string }>('sotto:plugins:sound', [{ id: 's-1' }])
      expect(sound.name).toBe('Doorbell')

      // 3. Removing an account clears its secret through `shell:credentialsSet` and persists cleanly for TS.
      const removedRes = pluginAccountResultSchema.parse(
        await conn.request('sotto:plugins:account-remove', [{ id: mailAcc.id }]),
      )
      expect(removedRes.ok).toBe(true)
      expect(secrets.has(pluginAccountSlot(mailAcc.id))).toBe(false)

      await conn.request('engine:close', [])
      expect(await exited).toBe(0)
      conn.close()

      // Fresh TS PluginAccounts + MailGrants agree with Rust's persisted files.
      const tsReloadedAccounts = new PluginAccounts(dataDir, {
        credentials: {
          has: slot => secrets.has(slot),
          get: slot => secrets.get(slot) ?? '',
          set: async () => undefined,
        },
        check: async () => ({ ok: true, signedInAs: null }),
      })
      const afterReload = await tsReloadedAccounts.list()
      expect(afterReload.map(a => a.id).sort()).toEqual([meshyAcc.id, elevenAcc.id].sort())
      expect(afterReload.find(a => a.id === meshyAcc.id)?.spending).toEqual({ askBefore: false, monthlyLimit: 2500 })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await server.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)

  it('migrates v1 councils.json, drives Council commands, strips words on privacy off, and hands off v2 to TS CouncilStore', async () => {
    const bin = await findRustEngineBinary()
    const dataDir = await mkdtemp(join(tmpdir(), 'sotto-rust-engine-council-'))
    const repoDir = join(dataDir, 'project')
    await mkdir(repoDir, { recursive: true })
    const endpoint = createEngineEndpoint('secn')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)

    const legacyId = '00000000-0000-4000-8000-000000000501'
    const legacyTurnId = '11111111-1111-4111-8111-111111111501'
    const legacyV1 = {
      version: 1,
      councils: [
        {
          id: legacyId,
          createdAt: '2026-11-01T10:00:00.000Z',
          originThread: 'origin-legacy',
          originTitle: 'Legacy thread',
          projectId: 'proj-legacy',
          history: { messages: 2, words: 40, tools: 0, parts: 1 },
          seats: [
            {
              seat: 'A', role: 'panelist', modelId: 'mock-model', modelName: 'Mock A',
              provider: 'claude', effort: 'high', thread: 't-a', formerThreads: [], started: true, context: true,
            },
            {
              seat: 'B', role: 'panelist', modelId: 'mock-model', modelName: 'Mock B',
              provider: 'codex', effort: 'high', thread: 't-b', formerThreads: [], started: true, context: true,
            },
            {
              seat: 'chair', role: 'chair', modelId: 'mock-model', modelName: 'Mock Chair',
              provider: 'grok', effort: 'high', thread: 't-chair', formerThreads: [], started: true, context: true,
            },
          ],
          rounds: [
            {
              index: 0, askedAt: '2026-11-01T10:00:00.000Z', stage: 'framing',
              leftOut: [], objections: [], question: 'Should we keep SQLite?',
            },
          ],
          turns: [
            {
              id: legacyTurnId, round: 0, seat: 'chair', thread: 't-chair', stage: 'framing',
              draftId: '22222222-2222-4222-8222-222222222501',
              messageId: '33333333-3333-4333-8333-333333333501',
              delivery: 'dispatching', queuedAt: '2026-11-01T10:00:00.000Z',
              sentAt: '2026-11-01T10:00:01.000Z', result: 'pending', summary: 'draft framing',
            },
          ],
          deadlineMinutes: 10,
        },
      ],
    }
    const rawV1 = JSON.stringify(legacyV1, null, 2)
    await writeFile(join(dataDir, 'councils.json'), rawV1, 'utf8')

    const child = spawn(bin, ['--data', dataDir, '--endpoint', endpoint, '--mock-provider', 'codex'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SOTTO_ENGINE_TOKEN: token },
      windowsHide: true,
    })

    try {
      const conn = await server.waitForClient(15_000)
      const exited = new Promise<number | null>(resolveExit => {
        child.once('exit', code => resolveExit(code))
      })

      const changedPushes: Array<{ councils: string[] }> = []
      conn.onPush((event: string, payload: unknown) => {
        if (event === 'shell:sendToMain') {
          const msg = payload as { channel?: string; payload?: unknown }
          if (msg.channel === 'sotto:council:changed') {
            changedPushes.push(councilChangedSchema.parse(msg.payload))
          }
        }
      })

      // 1. v1 -> v2 migration ran on startup, preserving .v1-backup and recovering dispatching turn.
      const initialViews = councilViewsSchema.parse(await conn.request('sotto:council:read', []))
      const backupText = await readFile(join(dataDir, 'councils.json.v1-backup'), 'utf8')
      expect(backupText).toBe(rawV1)
      expect(initialViews).toHaveLength(1)
      expect(initialViews[0]!.id).toBe(legacyId)
      expect(initialViews[0]!.status).toBe('waiting')
      expect(initialViews[0]!.origin.thread.startsWith('host:')).toBe(true)
      expect(initialViews[0]!.rounds[0]!.rows[0]!.state).toBe('unknown')
      expect(initialViews[0]!.rounds[0]!.rows[0]!.actions).toEqual(['retry', 'replace', 'skip'])

      // 2. Skip framing -> fallback advances to answers, then reframe updates kinds/research/criteria.
      const skipRes = councilCommandResultSchema.parse(
        await conn.request('sotto:council:command', [{ type: 'skip', council: legacyId, turn: legacyTurnId }]),
      )
      expect(skipRes).toEqual({ ok: true, council: legacyId })

      const afterSkip = councilViewsSchema.parse(await conn.request('sotto:council:read', []))
      expect(afterSkip[0]!.rounds[0]!.stage).toBe('answers')
      expect(afterSkip[0]!.rounds[0]!.framing?.fallback).toBe(true)
      expect(afterSkip[0]!.rounds[0]!.reframable).toBe(true)

      const reframeRes = councilCommandResultSchema.parse(
        await conn.request('sotto:council:command', [{
          type: 'reframe',
          council: legacyId,
          kinds: ['fact'],
          research: true,
          criteria: ['Latency under 5ms'],
        }]),
      )
      expect(reframeRes).toEqual({ ok: true, council: legacyId })

      const afterReframe = councilViewsSchema.parse(await conn.request('sotto:council:read', []))
      expect(afterReframe[0]!.rounds[0]!.framing?.kinds).toEqual(['fact'])
      expect(afterReframe[0]!.rounds[0]!.framing?.research.needed).toBe(true)
      expect(afterReframe[0]!.rounds[0]!.framing?.research.byUser).toBe(true)
      expect(afterReframe[0]!.rounds[0]!.framing?.criteria[0]?.text).toBe('Latency under 5ms')

      // 3. Create a real local project + thread, estimate it, start a fresh Council, stop and settle it.
      const projShell = await conn.request('agent.command', [{
        type: 'create-project',
        provider: 'codex',
        title: 'council-proj',
        path: repoDir,
        useExisting: true,
      }]) as {
        host: { hostId: string; projects: Array<{ id: string }>; models: Array<{ id: string; ready: boolean }> }
      }
      const projectId = projShell.host.projects[0]!.id
      const readyModelId = projShell.host.models.find(m => m.ready)!.id

      const threadShell = await conn.request('agent.command', [{
        type: 'create-thread',
        projectId,
        modelId: readyModelId,
        title: 'Local origin thread',
        titleSource: 'user',
        workingCopy: 'shared',
        managed: false,
      }]) as { host: { threads: Array<{ id: string }> } }
      const originThreadId = threadShell.host.threads[0]!.id
      const windowOriginKey = `host:${projShell.host.hostId}:${originThreadId}`

      const est = councilEstimateSchema.parse(
        await conn.request('sotto:council:estimate', [{ originThread: windowOriginKey }]),
      )
      expect('parts' in est && est.parts).toBe(1)

      const startRes = councilCommandResultSchema.parse(
        await conn.request('sotto:council:command', [{
          type: 'start',
          originThread: windowOriginKey,
          question: 'Which cache eviction policy fits best?',
          panelists: [
            { modelId: readyModelId, reasoningEffort: null },
            { modelId: readyModelId, reasoningEffort: null },
          ],
          chair: { modelId: readyModelId, reasoningEffort: null },
        }]),
      )
      expect(startRes.ok).toBe(true)
      const startedId = startRes.ok ? startRes.council : ''

      const settleRes = councilCommandResultSchema.parse(
        await conn.request('sotto:council:command', [{ type: 'settle', council: startedId }]),
      )
      expect(settleRes).toEqual({ ok: true, council: startedId })
      expect(changedPushes.some(p => p.councils.includes(startedId))).toBe(true)

      const allViews = councilViewsSchema.parse(await conn.request('sotto:council:read', []))
      expect(allViews.map(v => v.id)).toEqual([startedId, legacyId])
      expect(allViews[0]!.status).toBe('settled')

      // 4. Privacy off strips words on disk and deletes councils.json.v1-backup.
      await conn.request('council.privacyChanged', [false])
      await expect(access(join(dataDir, 'councils.json.v1-backup'))).rejects.toThrow()

      const ro = await conn.request('ops.councilsReadOnly', []) as {
        version: number
        councilCount: number
        climbCount: number
        hasV1Backup: boolean
        storageError: string | null
      }
      expect(ro).toEqual({ version: 2, councilCount: 2, climbCount: 0, hasV1Backup: false, storageError: null })

      await conn.request('engine:close', [])
      expect(await exited).toBe(0)
      conn.close()

      // 5. Fresh TS CouncilStore reads Rust's persisted v2 councils.json cleanly with words stripped.
      const tsStore = new CouncilStore(dataDir)
      const tsFile = await tsStore.read()
      expect(tsFile.version).toBe(2)
      expect(tsFile.councils).toHaveLength(2)
      const tsLegacy = tsFile.councils.find(c => c.id === legacyId)
      expect(tsLegacy && !('phase' in tsLegacy) && tsLegacy.rounds[0]?.question).toBeUndefined()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await server.close().catch(() => undefined)
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 45_000)
})
