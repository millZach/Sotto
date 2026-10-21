// @vitest-environment node
// SOTTO_WATCHER_PAIRED_LIVE=1 npx vitest run tests/integration/watcherPairedHostsLive.test.ts --maxWorkers=2
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isBuiltin } from 'node:module'
import { build } from 'vite'
import { expect, it, vi } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { CodexProcess } from '../../src/main/agents/codexProcess'
import { createAgentRuntime } from '../../src/main/agents/runtime'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { DEFAULT_SETTINGS } from '../../src/shared/settings'
import { defaultAgentConfiguration } from '../../src/shared/agents'
import { FakeProviderHost } from '../fixtures/fakeProviderHost'
import { testCredentials } from '../fixtures/testCredentials'

const enabled = process.env.SOTTO_WATCHER_PAIRED_LIVE === '1' && !process.env.CI
const run = promisify(execFile)
const wait = async (check: () => boolean | Promise<boolean>, ms = 120_000) => {
  const deadline = Date.now() + ms
  while (!await check()) { if (Date.now() >= deadline) throw new Error('live-deadline'); await new Promise(done => setTimeout(done, 100)) }
}
it.skipIf(!enabled)('proves a Windows native Watcher against isolated current and older forge host builds', async () => {
  const output = resolve('artifacts/watcher-paired-hosts'), evidencePath = join(output, 'live.json')
  await mkdir(output, { recursive: true })
  if (await readFile(evidencePath).then(() => true, () => false)) throw new Error('live-budget-already-recorded')
  const suffix = randomUUID(), remoteRoot = `/home/zach/tmp/sotto-watcher-hosts-${suffix}`
  const evidence = { date: new Date().toISOString(), masterTurns: 0, workerTurns: 0, maxTurns: 6, freeMemoryKB: 0,
    started: false, sent: false, read: false, stopped: false, olderRefused: false, selectionUnchanged: false,
    toolCalls: [] as { name: string; status: string; code?: string }[], remotePids: [] as number[], localPids: [] as number[], cleanup: false, result: 'not verified', phase: 'prepare', failureFrames: [] as string[] }
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  await save()
  const tunnels: ChildProcess[] = [], sockets: SocketHostService[] = []
  let runtime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined
  const originalRpc = CodexProcess.prototype.rpc
  const observer = vi.spyOn(CodexProcess.prototype, 'rpc').mockImplementation(function (this: CodexProcess, method, params, apply, rejected, beforeWrite) {
    if (method === 'turn/start') { if (evidence.masterTurns >= 4) throw new Error('live-master-turn-budget'); evidence.masterTurns++; void save() }
    return originalRpc.call(this, method, params, apply, rejected, beforeWrite)
  })
  try {
    evidence.freeMemoryKB = Number((await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { windowsHide: true })).stdout.trim())
    if (evidence.freeMemoryKB < 3 * 1024 * 1024) throw new Error('live-memory-below-three-gib')
    const ssh = async (command: string) => {
      const result = await run('ssh', ['forge', command], { windowsHide: true, timeout: 30_000 })
      if (/https:\/\/.*(?:check|auth)/iu.test(result.stderr)) throw new Error('tailscale-check-required')
      return result.stdout
    }
    await run(process.execPath, ['scripts/build-host.mjs'], { windowsHide: true, env: { ...process.env, SOTTO_HOST_OUT_DIR: join(output, 'current') } })
    evidence.phase = 'build-older'
    const olderSource = join(output, 'older-source'); await mkdir(olderSource, { recursive: true })
    await run('git', ['archive', '1a00332ce', 'src', 'package.json', '-o', join(output, 'older.tar')], { windowsHide: true })
    await run('tar', ['-xf', 'artifacts/watcher-paired-hosts/older.tar', '-C', 'artifacts/watcher-paired-hosts/older-source'], { windowsHide: true })
    await build({ root: olderSource, configFile: false, logLevel: 'silent', build: { ssr: join(olderSource, 'src/host/index.ts'), target: 'node24', outDir: join(output, 'older'), emptyOutDir: true,
      rollupOptions: { external: id => isBuiltin(id) || id === 'zod' || id === 'node-pty', output: { format: 'cjs', entryFileNames: 'index.js' } } } })
    await writeFile(join(output, 'initial-agents.json'), JSON.stringify({ configuration: { ...defaultAgentConfiguration(), provider: 'codex', enabledProviders: ['codex'], disconnectedProviders: ['claude', 'grok', 'devin'] },
      activeThreadId: null, activeProjectId: null, draft: '', draftThreadId: null, composing: false, outbox: [] }))
    evidence.phase = 'copy-bundles'
    await run('tar', ['-czf', 'artifacts/watcher-paired-hosts/zod.tar.gz', '-C', 'node_modules', 'zod'], { windowsHide: true })
    await ssh(`mkdir -p '${remoteRoot}/node_modules' '${remoteRoot}/current' '${remoteRoot}/older'`)
    await run('scp', [join(output, 'current', 'index.js'), `forge:${remoteRoot}/current/index.js`], { windowsHide: true })
    await run('scp', [join(output, 'older', 'index.js'), `forge:${remoteRoot}/older/index.js`], { windowsHide: true })
    await run('scp', [resolve('tests/fixtures/watcherPairedHostLauncher.mjs'), join(output, 'initial-agents.json'), join(output, 'zod.tar.gz'), `forge:${remoteRoot}/`], { windowsHide: true })
    await ssh(`tar -xzf '${remoteRoot}/zod.tar.gz' -C '${remoteRoot}/node_modules'`)
    const router = new DesktopHostRouter(emptyDesktopState, { watcherEnabled: true })
    let currentProjectId = '', currentModelId = '', olderHostId = '', olderProjectId = '', olderModelId = ''
    for (const [index, variant] of ['current', 'older'].entries()) {
      evidence.phase = `start-${variant}`; await save()
      const pid = Number((await ssh(`nohup mise exec node@24.21.0 -- node '${remoteRoot}/watcherPairedHostLauncher.mjs' '${remoteRoot}' '${variant}' > '${remoteRoot}/${variant}/host.log' 2>&1 < /dev/null & echo $!`)).trim())
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('live-pid-unavailable')
      evidence.remotePids.push(pid)
      const localConnection = join(output, `${variant}-connection.json`)
      await wait(async () => {
        try { await run('scp', [`forge:${remoteRoot}/${variant}/connection.json`, localConnection], { windowsHide: true }); return true } catch { return false }
      }, 60_000)
      const paired = JSON.parse(await readFile(localConnection, 'utf8')) as { token: string; hostId: string; port: number; pid: number }
      await unlink(localConnection)
      if (paired.pid !== pid) evidence.remotePids.push(paired.pid)
      const port = 49731 + index
      const tunnel = spawn('ssh', ['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${paired.port}`, 'forge'], { windowsHide: true, stdio: 'ignore' })
      tunnels.push(tunnel); evidence.localPids.push(tunnel.pid!)
      await wait(async () => { try { return (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok } catch { return false } }, 30_000)
      const socket = new SocketHostService({ url: `http://127.0.0.1:${port}`, token: paired.token, expectedHostId: paired.hostId, watcherEnabled: true }); sockets.push(socket)
      evidence.phase = `connect-${variant}`; await save()
      await socket.connect()
      evidence.phase = `provider-connect-${variant}`; await save()
      await socket.command({ type: 'connect', provider: 'codex' })
      const projectPath = `${remoteRoot}/${variant}/project`
      await ssh(`mkdir -p '${projectPath}'`)
      evidence.phase = `project-${variant}`; await save()
      await socket.command({ type: 'create-project', provider: 'codex', title: 'Disposable Watcher live project', path: projectPath, useExisting: true })
      const project = socket.shell().host.projects.find(item => item.path === projectPath), model = socket.shell().host.models.find(item => item.providerId === 'codex' && item.ready)
      if (!project || !model) { evidence.phase = `provider-unavailable-${variant}`; throw new Error('live-forge-provider-unavailable') }
      evidence.phase = `router-${variant}`; await save()
      router.add({ hostId: paired.hostId, name: `Throwaway forge ${variant}`, kind: 'remote', service: socket, detail: id => socket.readThreadDetail(id), preview: request => socket.attachmentPreview(request) })
      if (variant === 'current') { currentProjectId = project.id; currentModelId = model.id }
      else { olderHostId = paired.hostId; olderProjectId = project.id; olderModelId = model.id; expect(socket.supportsWatcherControl).toBe(false) }
    }
    evidence.phase = 'desktop-runtime'; await save()
    const directory = join(output, 'desktop-profile'), credentials = await testCredentials(join(directory, 'vault'), { mode: 'unavailable' })
    const settings = { ...DEFAULT_SETTINGS, historyEnabled: false, threadTitles: false, babysitPullRequests: false }
    const adapter = new CodexAppServerHost({ userDataPath: directory, requestTimeoutMs: 30_000, pollIntervalMs: 1_000 })
    runtime = await createAgentRuntime({ directory, credentials, watcherEnabled: true, settings: () => settings, writingSettings: async () => settings, historyEnabled: () => false, openExternal: async () => undefined, reasoner: {},
      providers: { codex: adapter, claude: new FakeProviderHost(), grok: new FakeProviderHost(), devin: new FakeProviderHost() } })
    const control = runtime.agentControl, watcher = runtime.watcher!
    watcher.useRemoteHosts(router.watcherHosts())
    // The tool server starts each call through startCall, which answers and later settles.
    const startCall = watcher.startCall.bind(watcher)
    vi.spyOn(watcher, 'startCall').mockImplementation((id, name, args, context) => {
      const call = startCall(id, name, args, context)
      return { ...call, answer: call.answer.then(async answer => { const result = answer as { status: string; code?: string }; evidence.toolCalls.push({ name, status: result.status, ...result.code ? { code: result.code } : {} }); await save(); return answer }) }
    })
    await control.commandShell({ type: 'connect', provider: 'codex' })
    evidence.phase = 'desktop-open'; await save()
    const model = control.shell().host.models.find(item => item.providerId === 'codex' && item.ready)!
    if ((await watcher.open({ provider: 'codex', modelId: model.id })).status !== 'ok') throw new Error('live-master-open-refused')
    const id = watcher.state().current!.target.threadId, currentHostId = sockets[0]!.shell().hostId!
    const selection = JSON.stringify([control.shell().activeThreadId, router.shell().activeThreadId])
    await control.commandShell({ type: 'observe-threads', threadIds: [id] })
    evidence.phase = 'native-start-read'; await save()
    const first = await control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text:
      `Use sotto_threads to start exactly one worker on host ${currentHostId}, project ${currentProjectId}, model ${currentModelId}, shared working copy, title Disposable paired worker. firstPrompt is one line: Reply with two words and change nothing. Use the active requestId and a new UUID retryKey. Then read_thread for that target and finish. Make no other mutation or native operation.` })
    if (first.error) throw new Error('live-master-send-refused')
    await wait(() => watcher.state().receipts.some(item => item.action === 'start' && item.deliveryState === 'accepted') && control.watcherSnapshot().threads.find(item => item.id === id)?.lastTurn?.status === 'completed')
    const worker = watcher.state().watchedThreads[0]!
    await wait(() => sockets[0]!.shell().host.threads.find(item => item.id === worker.target.threadId)?.lastTurn?.status === 'completed')
    evidence.started = true
    evidence.phase = 'native-send-read-stop'; await save()
    const previous = control.watcherSnapshot().threads.find(item => item.id === id)?.lastTurn?.id
    const second = await control.commandShell({ type: 'manual-send', threadId: id, draftId: randomUUID(), text:
      `Use sotto_threads to send exactly one new prompt now to target host ${worker.target.hostId}, thread ${worker.target.threadId}: Reply with two words and change nothing. Use this active requestId and a new UUID retryKey. Read the thread, then stop_thread with another retryKey, and finish. Make no other mutation or native operation.` })
    if (second.error) throw new Error('live-second-master-send-refused')
    await wait(() => watcher.state().receipts.some(item => item.action === 'stop' && item.deliveryState === 'accepted') && control.watcherSnapshot().threads.find(item => item.id === id)?.lastTurn?.status === 'completed' && control.watcherSnapshot().threads.find(item => item.id === id)?.lastTurn?.id !== previous)
    evidence.sent = watcher.state().receipts.some(item => item.action === 'send' && item.deliveryState === 'accepted')
    evidence.read = evidence.toolCalls.some(item => item.name === 'read_thread' && item.status === 'ok')
    evidence.stopped = sockets[0]!.shell().host.threads.find(item => item.id === worker.target.threadId)?.status === 'idle'
    evidence.phase = 'older-refusal'
    const requestId = watcher.state().requests.at(-1)!.id
    const refused = await watcher.invoke(id, 'start_thread', { requestId, retryKey: randomUUID(), project: { hostId: olderHostId, projectId: olderProjectId }, modelId: olderModelId, title: 'Refused old host worker', workingCopy: { kind: 'shared' }, firstPrompt: 'Reply with two words and change nothing.' }) as { code?: string }
    evidence.olderRefused = refused.code === 'HOST_FEATURE_UNAVAILABLE'
    evidence.workerTurns = JSON.parse(await ssh(`cat '${remoteRoot}/current/turn-count.json'`)).workerTurns
    evidence.selectionUnchanged = selection === JSON.stringify([control.shell().activeThreadId, router.shell().activeThreadId])
    if (!evidence.started || !evidence.sent || !evidence.read || !evidence.stopped || !evidence.olderRefused || !evidence.selectionUnchanged || evidence.masterTurns + evidence.workerTurns > 6) throw new Error('live-acceptance-failed')
    evidence.result = 'verified'
  } catch (error) {
    if (error instanceof Error) evidence.failureFrames = error.stack?.split('\n').slice(1, 6) ?? []
    if (error instanceof Error && /^live-[a-z-]+$/u.test(error.message)) evidence.phase = error.message
    await save()
    // eslint-disable-next-line preserve-caught-error -- Live failure output must exclude provider text and protocol bodies.
    throw new Error(`live-paired-check-failed:${evidence.phase}`)
  }
  finally {
    await runtime?.close()
    for (const socket of sockets) await socket.close()
    for (const tunnel of tunnels) if (tunnel.pid) { await run('taskkill', ['/PID', String(tunnel.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined) }
    for (const pid of evidence.remotePids) await run('ssh', ['forge', `kill -TERM ${pid}`], { windowsHide: true }).catch(() => undefined)
    await run('ssh', ['forge', `test '${remoteRoot}' = '/home/zach/tmp/sotto-watcher-hosts-${suffix}' && rm -rf -- '${remoteRoot}'`], { windowsHide: true }).then(() => { evidence.cleanup = true }, () => undefined)
    observer.mockRestore(); vi.restoreAllMocks(); await save()
  }
}, 600_000)
