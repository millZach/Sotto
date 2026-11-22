// @vitest-environment node
/**
 * Out-of-process engine hang watchdog (#2733, ADR-0098, ADR-0210):
 * - starts only when `main-freeze` is enabled, tagging recordings with `kind: 'engine'`
 * - forwards `quitReceived()` on shutdown and terminates the worker cleanly on `engine:close` or failed init
 * - in a real bundled child engine process with Rollup chunk splitting (`out/main/chunks/`), catches a blocked
 *   engine event loop with stack frames and exits cleanly with zero leaked timers or workers
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngineEndpoint, generateEngineToken, listenEngineServer, type EngineRpcConnection } from '../../../../src/main/engine/transport'
import type { DesktopEngineOptions } from '../../../../src/main/engine/types'
import { HANG_FILE, type HangRecord } from '../../../../src/main/performance/hangRecording'
import { HangWatchdog } from '../../../../src/main/performance/hangWatchdog'

const engineMock = vi.hoisted(() => ({
  failInit: false,
  closeCalls: 0,
  prepareCalls: 0,
  onClose: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('../../../../src/main/engine/createDesktopEngine', () => ({
  createDesktopEngine: async () => {
    if (engineMock.failInit) throw new Error('INIT_FAILED')
    return {
      metadata: { localHostId: 'local', hasOwnServers: false, hasOwnServerCleanup: false, hasCouncil: false, hasWatcher: false, keepMainCurrentEnabled: false },
      channels: () => [],
      watcherBridge: undefined,
      prepareForShutdown: () => { engineMock.prepareCalls += 1 },
      close: async () => { engineMock.closeCalls += 1; await engineMock.onClose?.() },
    }
  },
}))

const { attachEngineProcessServer } = await import('../../../../src/main/engine/engineProcess')

const tempDirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  engineMock.failInit = false
  engineMock.closeCalls = 0
  engineMock.prepareCalls = 0
  engineMock.onClose = undefined
  for (const dir of tempDirs.splice(0).reverse()) {
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Unexpected temp directory')
    await rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 })
  }
})

function fakeConnection(options: Partial<DesktopEngineOptions>) {
  let reqHandler: (method: string, args: readonly unknown[]) => unknown = () => undefined
  let pushHandler: (event: string, payload: unknown) => void = () => undefined
  const pushes: Array<{ event: string; payload: unknown }> = []
  const closeListeners: Array<(error?: Error) => void> = []
  const initPayload = {
    credentials: { available: true, plaintext: {}, sealed: {}, unreadable: {} },
    browserToolDefinitions: [],
    options: {
      userDataPath: '/tmp/user-data',
      appRunningVersion: '0.1.44-owl.20261122.3',
      appVersion: '0.1.44',
      isPackaged: false,
      platform: process.platform,
      owlFeatures: { 'main-freeze': true },
      startupSettings: {},
      phoneCompression: false,
      desktopNotificationsEnabled: false,
      e2eConfiguration: null,
      env: {},
      ...options,
    },
    downloadsFolder: '',
    hasNotify: false,
  }
  const connection = {
    isClosed: false,
    onRequest: (next: typeof reqHandler) => { reqHandler = next },
    onPush: (next: typeof pushHandler) => { pushHandler = next },
    onClose: (listener: (error?: Error) => void) => { closeListeners.push(listener); return () => undefined },
    sendPush: (event: string, payload: unknown) => { pushes.push({ event, payload }) },
    request: async () => undefined,
    close: () => { (connection as { isClosed: boolean }).isClosed = true },
  } as unknown as EngineRpcConnection
  return {
    connection,
    pushes,
    request: async (method: string, args: readonly unknown[] = []) => reqHandler(method, method === 'engine:init' ? [initPayload] : args),
    push: (event: string, payload?: unknown) => pushHandler(event, payload),
  }
}

describe('attachEngineProcessServer hang watchdog lifecycle (#2733)', () => {
  it('does not start the hang watchdog when main-freeze is off', async () => {
    const startSpy = vi.spyOn(HangWatchdog, 'start')
    const { connection, request } = fakeConnection({ owlFeatures: { 'main-freeze': false } as DesktopEngineOptions['owlFeatures'] })
    attachEngineProcessServer(connection)

    await request('engine:init')
    expect(startSpy).not.toHaveBeenCalled()
    await request('engine:close')
  })

  it('starts with kind "engine", forwards log events and quitReceived, and stops cleanly on close', async () => {
    const quitReceived = vi.fn()
    const stop = vi.fn(async () => undefined)
    let logFn: ((event: 'hang-recording-saved' | 'hang-recording-failed' | 'quit-forced') => void) | undefined
    const startSpy = vi.spyOn(HangWatchdog, 'start').mockImplementation((_data, log) => {
      logFn = log
      return { quitReceived, quitCancelled: vi.fn(), dispose: vi.fn(), stop } as unknown as HangWatchdog
    })

    const { connection, pushes, request, push } = fakeConnection({
      hangWatchdog: { directory: '/tmp/perf', appRoots: ['/app'], devOrigins: [], hangMs: 2_000, quitForceMs: 4_000 },
    })
    attachEngineProcessServer(connection)

    await request('engine:init')
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(startSpy.mock.calls[0]![0]).toMatchObject({
      kind: 'engine',
      directory: '/tmp/perf',
      appRoots: ['/app'],
      sottoVersion: '0.1.44-owl.20261122.3',
      hangMs: 2_000,
      quitForceMs: 4_000,
    })

    logFn?.('hang-recording-saved')
    expect(pushes).toContainEqual({ event: 'shell:log', payload: 'engine-hang-recording-saved' })

    push('engine:prepareForShutdown', null)
    expect(quitReceived).toHaveBeenCalledTimes(1)

    const order: string[] = []
    engineMock.onClose = async () => { order.push('engine.close') }
    stop.mockImplementation(async () => { order.push('watchdog.stop') })

    await request('engine:close')
    expect(order).toEqual(['engine.close', 'watchdog.stop'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the hang watchdog if createDesktopEngine throws during engine:init', async () => {
    const stop = vi.fn(async () => undefined)
    vi.spyOn(HangWatchdog, 'start').mockReturnValue({ quitReceived: vi.fn(), quitCancelled: vi.fn(), dispose: vi.fn(), stop } as unknown as HangWatchdog)
    engineMock.failInit = true

    const { connection, request } = fakeConnection({})
    attachEngineProcessServer(connection)

    await expect(request('engine:init')).rejects.toThrow('INIT_FAILED')
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('bundled out-of-process engine hang watchdog integration (#2733)', () => {
  it('captures a blocked engine event loop with kind "engine" and stacks, then exits cleanly with no leaked worker or timers', async () => {
    const repoRoot = resolve(__dirname, '../../../..')
    const workDir = await mkdtemp(join(tmpdir(), 'sotto-engine-watchdog-'))
    tempDirs.push(workDir)
    const recordingsDir = join(workDir, 'performance-recordings')
    const outMain = join(workDir, 'out', 'main')

    // Build two entries that both import HangWatchdog (mirroring index.ts + engineProcess.ts) alongside
    // hangWatchdogWorker.ts so Rollup extracts hangWatchdog into out/main/chunks/ exactly as electron-vite does.
    const fakeCreateEngine = join(workDir, 'fakeCreateDesktopEngine.ts')
    await writeFile(fakeCreateEngine, `
export function blockEngineLoopOnPurpose(ms: number): number {
  const end = Date.now() + ms
  let spin = 0
  while (Date.now() < end) spin += 1
  return spin
}
export async function createDesktopEngine() {
  return {
    metadata: { localHostId: 'local', hasOwnServers: false, hasOwnServerCleanup: false, hasCouncil: false, hasWatcher: false, keepMainCurrentEnabled: false },
    channels: () => ['test:block'],
    watcherBridge: undefined,
    invokeIpc: async (channel: string, _role: string, args: readonly unknown[]) => {
      if (channel === 'test:block') return blockEngineLoopOnPurpose(Number(args[0] ?? 1500))
      throw new Error('UNKNOWN')
    },
    prepareForShutdown: () => undefined,
    close: async () => undefined,
  }
}
`, 'utf8')

    const fakeInterfaceLanguage = join(workDir, 'fakeInterfaceLanguage.ts')
    await writeFile(fakeInterfaceLanguage, `
export class MainInterfaceLanguage {
  async apply(): Promise<void> {}
}
`, 'utf8')

    const fakeIndex = join(workDir, 'fakeIndex.ts')
    await writeFile(fakeIndex, `
export { HangWatchdog } from ${JSON.stringify(resolve(repoRoot, 'src/main/performance/hangWatchdog.ts'))}
`, 'utf8')

    const engineEntry = join(workDir, 'engineChildEntry.ts')
    await writeFile(engineEntry, `
import { attachEngineProcessServer } from ${JSON.stringify(resolve(repoRoot, 'src/main/engine/engineProcess.ts'))}
import { connectEngineClient } from ${JSON.stringify(resolve(repoRoot, 'src/main/engine/transport.ts'))}

async function run() {
  const endpoint = process.env['TEST_ENGINE_ENDPOINT']!
  const token = process.env['TEST_ENGINE_TOKEN']!
  const connection = await connectEngineClient(endpoint, token)
  // Intentionally close only the connection on exit (no process.exit): if the watchdog leaked any timer or worker,
  // this child process would fail to exit cleanly.
  attachEngineProcessServer(connection, () => { connection.close() })
}
void run()
`, 'utf8')

    await build({
      root: repoRoot,
      configFile: false,
      logLevel: 'silent',
      resolve: {
        alias: [
          { find: /^\.\/createDesktopEngine$/u, replacement: fakeCreateEngine },
          { find: resolve(repoRoot, 'src/main/engine/createDesktopEngine.ts'), replacement: fakeCreateEngine },
          { find: /^\.\.\/interfaceLanguage$/u, replacement: fakeInterfaceLanguage },
          { find: resolve(repoRoot, 'src/main/interfaceLanguage.ts'), replacement: fakeInterfaceLanguage },
        ],
      },
      ssr: { noExternal: true },
      build: {
        ssr: true,
        target: 'node24',
        outDir: outMain,
        emptyOutDir: true,
        minify: false,
        copyPublicDir: false,
        rollupOptions: {
          input: {
            index: fakeIndex,
            engineProcess: engineEntry,
            hangWatchdogWorker: resolve(repoRoot, 'src/main/performance/hangWatchdogWorker.ts'),
          },
          external: id => isBuiltin(id),
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },
    })

    // Confirm Rollup emitted a shared chunk under out/main/chunks/ so this test covers chunk path resolution.
    const chunkFiles = await readdir(join(outMain, 'chunks'))
    expect(chunkFiles.length).toBeGreaterThan(0)

    const endpoint = createEngineEndpoint('sotto-engine-wd-test')
    const token = generateEngineToken()
    const server = await listenEngineServer(endpoint, token)
    const child = spawn(process.execPath, [join(outMain, 'engineProcess.js')], {
      env: { ...process.env, TEST_ENGINE_ENDPOINT: endpoint, TEST_ENGINE_TOKEN: token },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })

    try {
      const connection = await server.waitForClient(10_000)
      const logs: string[] = []
      connection.onPush((event, payload) => {
        if (event === 'shell:log' && typeof payload === 'string') logs.push(payload)
      })

      await connection.request('engine:init', [{
        options: {
          userDataPath: workDir,
          appRunningVersion: '0.1.44-owl.test',
          appVersion: '0.1.44',
          isPackaged: false,
          platform: process.platform,
          owlFeatures: { 'main-freeze': true },
          startupSettings: {},
          phoneCompression: false,
          desktopNotificationsEnabled: false,
          e2eConfiguration: null,
          hangWatchdog: {
            directory: recordingsDir,
            appRoots: [workDir, repoRoot],
            devOrigins: [],
            hangMs: 3_000,
            quitForceMs: 10_000,
          },
          env: {},
        },
        credentials: { available: true, plaintext: {}, sealed: {}, unreadable: {} },
        downloadsFolder: workDir,
        browserToolDefinitions: [],
        hasNotify: false,
      }], 10_000)

      // Let the watchdog worker start and record an initial heartbeat before blocking the engine loop.
      await new Promise(resolveWait => setTimeout(resolveWait, 400))

      await connection.request('engine:invokeIpc', ['test:block', 'main', [1_600]], 10_000)

      const readEngineHangs = async (): Promise<HangRecord[]> => {
        const names = (await readdir(recordingsDir).catch(() => [])).filter(name => /^sotto-hang-[\d-]+$/u.test(name))
        return Promise.all(names.map(async name => JSON.parse(await readFile(join(recordingsDir, name, HANG_FILE), 'utf8')) as HangRecord))
      }

      await vi.waitFor(async () => {
        const records = await readEngineHangs()
        const engineHang = records.find(record => record.kind === 'engine')
        expect(engineHang, `stderr: ${stderr}`).toBeDefined()
        expect(engineHang!.answeredAfterMs).not.toBeNull()
        expect(engineHang!.answeredAfterMs!).toBeGreaterThanOrEqual(1_200)
      }, { timeout: 10_000, interval: 100 })

      const saved = (await readEngineHangs()).find(record => record.kind === 'engine')!
      expect(saved.format).toBe(1)
      expect(saved.kind).toBe('engine')
      expect(saved.sottoVersion).toBe('0.1.44-owl.test')
      expect(saved.platform).toBe(process.platform)
      expect(saved.stacks!.length).toBeGreaterThan(0)
      expect(saved.stacks!.flatMap(stack => stack.frames).some(frame => frame.functionName === 'blockEngineLoopOnPurpose')).toBe(true)
      expect(logs).toContain('engine-hang-recording-saved')

      await connection.request('engine:close', [], 10_000)
      connection.close()

      const exit = await Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Engine child failed to exit cleanly (leaked handle). stderr: ${stderr}`)), 5_000)),
      ])
      expect(exit).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await server.close().catch(() => undefined)
    }
  }, 30_000)
})
