// @vitest-environment node
// Phase 4 cross-language live integration test: connects the compiled Rust `sotto-engine` binary
// to Sotto's real TypeScript `listenEngineServer` (`src/main/engine/transport.ts`) over a real
// Windows named pipe / Unix domain socket, verifying token authentication, RPC round-trips,
// live Codex turn execution & push broadcasts, ops, and clean shutdown (ADR-0210, ADR-0215).
import { execFileSync, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostFactsSource } from '../../src/main/agents/hostFacts'
import { GitStatusReader } from '../../src/main/agents/git/gitStatus'
import { ThreadStore } from '../../src/main/agents/threadStore'
import { UsageService } from '../../src/main/agents/usageService'
import { UsageStore } from '../../src/main/agents/usageStore'
import type { AgentHost } from '../../src/main/agents/host'
import { startRustLocalEngine } from '../../src/main/engine/rustLocalEngineClient'
import { FilesService } from '../../src/main/files/service'
import { GitChangesService } from '../../src/main/tools/gitChanges'
import {
  createEngineEndpoint,
  generateEngineToken,
  listenEngineServer,
} from '../../src/main/engine/transport'
import { publicProviderEntityId } from '../../src/shared/agents'
import { fileListingSchema, filePreviewSchema } from '../../src/shared/files'
import { hostMachineReportSchema } from '../../src/shared/hostFacts'
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

      // 4. Phase 2 engine:perfReading & engine:close.
      const perf = await conn.request<{ blockedShare: number; freezesOver100ms: number }>('engine:perfReading')
      expect(perf.blockedShare).toBe(0)
      expect(perf.freezesOver100ms).toBe(0)

      const closed = await conn.request<boolean>('engine:close')
      expect(closed).toBe(true)
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
})
