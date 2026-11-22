// @vitest-environment node
// Phase 4 cross-language live integration test: connects the compiled Rust `sotto-engine` binary
// to Sotto's real TypeScript `listenEngineServer` (`src/main/engine/transport.ts`) over a real
// Windows named pipe / Unix domain socket, verifying token authentication, RPC round-trips,
// live Codex turn execution & push broadcasts, ops, and clean shutdown (ADR-0210, ADR-0215).
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEngineEndpoint,
  generateEngineToken,
  listenEngineServer,
} from '../../src/main/engine/transport'
import { publicProviderEntityId } from '../../src/shared/agents'
import { fileListingSchema, filePreviewSchema } from '../../src/shared/files'
import { hostMachineReportSchema } from '../../src/shared/hostFacts'
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
})
