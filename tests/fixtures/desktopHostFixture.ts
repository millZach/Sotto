// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { startHeadlessHost } from '../../src/host'
import { HostCredentialEncryption } from '../../src/host/credentials'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { desktopWindowClient } from '../../src/main/agents/hostService'
import { RetainedDraftStore, type RetainedDraft } from '../../src/main/agents/retainedDraftStore'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { E2EAgentHost, e2eAgentReasoner } from '../../src/main/e2e/agentEffects'
import { DesktopHostRouter } from '../../src/main/hosts/desktopHostRouter'
import { DesktopHosts } from '../../src/main/hosts/desktopHosts'
import { emptyDesktopState } from '../../src/main/hosts/inactiveLocalHost'
import { SshFailure, SshHostLauncher, type SshBootOperation, type SshBootResult, type SshCallbacks, type SshConnectOptions, type SshHostConfiguration, type SshHostConnection, type SshHostUpdateOperation, type SshHostUpdateResult } from '../../src/main/hosts/sshLauncher'
import type { BootStatus } from '../../src/shared/bootStart'
import { hostEntityKey } from '../../src/shared/clientIdentity'
import type { RemoteHost } from '../../src/shared/hosts'
import { ensureFixtureDesktopAnswers } from './sshDesktopAnswers'
import { standInTailscale } from './standInTailscale'

export function useDesktopHostFixture() {
  let hostTailscale: ReturnType<typeof standInTailscale>

  let hostTailscaleRunning = false

  let root: string, host: Awaited<ReturnType<typeof startHeadlessHost>>, credentials: AgentCredentials, router: DesktopHostRouter, manager: DesktopHosts

  let reportedHostId: string

  const launchers: FixtureSsh[] = [], failures: Error[] = []

  let retryDelay: (attempt: number) => number = () => 0

  /** Every reconnect the manager scheduled, by attempt: an empty list proves no retry can fire, with no waiting. */
  const scheduled: number[] = []

  let owned = true, stopResult: boolean | Error = true

  /** Where the fixture tunnel leads; by default the real host's listener. */
  let tunnelUrl: (() => string) | undefined

  /**
   * Where the host's tailnet address is opened, for a test whose host runs Tailscale: a stand-in for Tailscale Serve with
   * nothing behind it, which answers 502 at once, so the host stays on its SSH connection, as these tests expect.
   */
  let noTailnet: Server

  let tailnetAt: (address: string) => string = () => serveWithNothingBehind()

  const serveWithNothingBehind = (): string => { const address = noTailnet.address(); return typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1:2' }

  beforeAll(async () => {
    noTailnet = createServer((_request, response) => { response.statusCode = 502; response.end() })
    await new Promise<void>(resolve => noTailnet.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => { await new Promise<void>(resolve => noTailnet.close(() => resolve())) })

  /** Runs before a stop answers; the real host closes its listener, dropping every peer, before it replies. */
  let beforeStopReply: () => Promise<void> = async () => undefined

  /** What the fixture host answers to each operation of an update; by default it has none. */
  const noUpdates = async (): Promise<SshHostUpdateResult> => { throw new Error('This fixture host has no update.') }

  let updateHost: (operation: SshHostUpdateOperation) => Promise<SshHostUpdateResult> = noUpdates

  /** When set, the launch script's desktop-answers step fails with this. */
  let desktopAnswersFailure: Error | undefined

  /** Start at boot as the fixture's launch finds it (ADR-0054); absent unless a test says. */
  let bootStart: BootStatus | undefined

  /** What the fixture host answers to a start at boot operation; by default it has none. Every one it was asked is in `boots`. */
  const noBoot = async (): Promise<SshBootResult> => { throw new Error('This fixture host has no start at boot.') }

  let boot: (operation: SshBootOperation) => Promise<SshBootResult> = noBoot

  const boots: SshBootOperation[] = []

  const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  /** Revokes the way the launch script does, through the host's admin endpoint, which closes the revoked peer before replying. */
  async function adminRevoke(clientId: string): Promise<boolean> {
    const descriptor = JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }
    const response = await fetch('http://127.0.0.1:' + host.descriptor!.port + '/v1/admin/revoke-client', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId }) })
    return ((await response.json()) as { revoked: boolean }).revoked
  }

  const stops: string[] = []

  /** Every launch script operation a fixture connection ran, in order, with the kind of connection it ran on. */
  const operations: string[] = []

  /** Whether the fixture host is running, as an admin connection finds it; one that is not fails its connect. */
  let hostRunning = true

  /** When set, an admin connection that finds no host running says it could not take this installation's boot unit away. */
  let bootLeftOnStop = false

  /** When set, the launch script's revoke-client fails the way it does when the host refuses it. */
  let revokeFails = false

  /** When set, the launch script's revoke-client fails with this instead, the way a request that never got an answer does. */
  let revokeError: Error | undefined

  /** When set, the next connect asks this SSH question and waits for its answer, or for the attempt to be cancelled. */
  let askOnConnect: 'passphrase' | undefined

  /** Every answer given to an SSH question, to prove where the dialog's answer went. */
  const answers: string[] = []

  /** When set, the next connect runs this first, the way the launcher reports steps and Tailscale's approval. */
  let onConnect: ((callbacks: SshCallbacks) => Promise<void>) | undefined

  /** Every page the manager opened in the browser. */
  const opened: string[] = []

  /** The Node the fixture host's launch script says it ran under. */
  const FIXTURE_NODE = '/home/zach/.local/share/mise/installs/node/24.4.0/bin/node'

  class FixtureSsh extends SshHostLauncher {
    callbacks?: SshCallbacks
    configuration?: SshHostConfiguration
    options?: SshConnectOptions
    private waiting?: { resolve: () => void; reject: (error: Error) => void }
    override async connect(configuration: SshHostConfiguration, callbacks: SshCallbacks = {}, options: SshConnectOptions = {}): Promise<SshHostConnection> {
      this.callbacks = callbacks; this.configuration = configuration; this.options = options
      if (onConnect) { const script = onConnect; onConnect = undefined; await script(callbacks) }
      if (askOnConnect) {
        askOnConnect = undefined
        callbacks.onPrompt?.({ id: 'prompt-1', kind: 'passphrase', text: 'Enter passphrase for key' })
        await new Promise<void>((resolve, reject) => { this.waiting = { resolve, reject } })
      }
      const failure = failures.shift()
      if (failure) throw failure
      // An admin connection starts nothing: a host that is not running fails its connect.
      if (options.start === false && !hostRunning) {
        const stopped = new SshFailure('host-not-running')
        if (bootLeftOnStop) stopped.bootLeft = true
        throw stopped
      }
      const which = options.start === false ? 'admin' : 'ssh'
      return { url: tunnelUrl?.() ?? 'http://127.0.0.1:' + host.descriptor!.port, hostId: reportedHostId, owned, route: { hostname: 'forge', identityFiles: [] }, node: FIXTURE_NODE,
        close: async () => undefined,
        showHostPairingCode: async () => ({ ...host.pairing.issuePairingCode(), hostId: reportedHostId }),
        ensureDesktopAnswers: async clientId => { if (desktopAnswersFailure) throw desktopAnswersFailure; await ensureFixtureDesktopAnswers(join(root, 'remote'), reportedHostId, clientId) },
        revokeClient: async clientId => { operations.push(`${which} revoke-client`); if (revokeError) throw revokeError; if (revokeFails) throw new SshFailure('revoke-failed'); return adminRevoke(clientId) },
        hostAdminToken: async () => (JSON.parse(await readFile(join(root, 'remote', 'host-listener.json'), 'utf8')) as { adminToken: string }).adminToken,
        stopHost: async () => { operations.push(`${which} stop-host`); stops.push(reportedHostId); await beforeStopReply(); if (stopResult instanceof Error) throw stopResult; return stopResult },
        updateHost: async operation => { operations.push(`${which} ${operation.op}`); return updateHost(operation) },
        ...(bootStart ? { bootStart } : {}), boot: async operation => { operations.push(`${which} ${operation.op}`); boots.push(operation); return boot(operation) },
      }
    }
    override answerPrompt(id: string, answer: string): void {
      if (!this.waiting || id !== 'prompt-1') throw new Error('This SSH prompt is no longer waiting. Reconnect if needed.')
      answers.push(answer); this.callbacks?.onPrompt?.(null); this.waiting.resolve(); delete this.waiting
    }
    override async disconnect(): Promise<void> { this.waiting?.reject(new SshFailure('cancelled')); delete this.waiting }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-desktop-hosts-'))
    hostTailscale = standInTailscale()
    // Tailscale is not running on the host unless a test says so, so a host Add host saves stays on SSH (ADR-0053).
    hostTailscaleRunning = false
    const standIn = hostTailscale.tailscale
    host = await startHeadlessHost({ dataDirectory: join(root, 'remote'), port: 0, providers: { codex: new E2EAgentHost(), claude: new E2EAgentHost(), grok: new E2EAgentHost(), devin: new E2EAgentHost() }, reasoner: e2eAgentReasoner,
      tailscale: { ...standIn, status: async () => hostTailscaleRunning ? standIn.status() : { state: 'missing' } } })
    reportedHostId = host.descriptor!.hostId
    credentials = new AgentCredentials(join(root, 'desktop'), new HostCredentialEncryption('synthetic-desktop-credential-key')); await credentials.load()
    router = new DesktopHostRouter(emptyDesktopState)
    launchers.length = 0; failures.length = 0; stops.length = 0; answers.length = 0; askOnConnect = undefined; onConnect = undefined; opened.length = 0; scheduled.length = 0; retryDelay = () => 0; owned = true; stopResult = true; beforeStopReply = async () => undefined; tunnelUrl = undefined; updateHost = noUpdates; desktopAnswersFailure = undefined; tailnetAt = () => serveWithNothingBehind()
    operations.length = 0; hostRunning = true; bootLeftOnStop = false; revokeFails = false; revokeError = undefined; bootStart = undefined; boot = noBoot; boots.length = 0
    manager = newManager()
    await manager.start()
  })

  function newManager(retainedDrafts?: RetainedDraftStore): DesktopHosts {
    return new DesktopHosts({ directory: join(root, 'desktop'), credentials, router, ...(retainedDrafts ? { retainedDrafts } : {}), localHostRunning: false, localHostEnabled: () => false, restart: () => undefined, retryDelayMs: attempt => { scheduled.push(attempt); return retryDelay(attempt) }, launcher: () => { const launcher = new FixtureSsh(); launchers.push(launcher); return launcher },
      openExternal: async url => { opened.push(url) }, resolveTailnet: address => tailnetAt(address) })
  }

  /** Quits and starts Sotto again over the same saved hosts, the way a relaunch does; `saved` replaces the file first when given. */
  async function relaunch(saved?: object[]): Promise<void> {
    await manager.close(); router.dispose(); router = new DesktopHostRouter(emptyDesktopState)
    if (saved) { await mkdir(join(root, 'desktop'), { recursive: true }); await writeFile(join(root, 'desktop', 'remote-hosts.json'), JSON.stringify(saved)) }
    manager = newManager()
    await manager.start()
  }

  const savedFile = async (): Promise<unknown[]> => JSON.parse(await readFile(join(root, 'desktop', 'remote-hosts.json'), 'utf8').catch(() => '[]')) as unknown[]

  /** The socket a saved host is connected on now. */
  const liveSocket = (id: string): SocketHostService => (manager as unknown as { live: Map<string, { socket?: SocketHostService }> }).live.get(id)!.socket!

  afterEach(async () => { await manager?.close(); router?.dispose(); await host?.close(); if (root && dirname(root) === tmpdir() && root.includes('sotto-desktop-hosts-')) await rm(root, { recursive: true, force: true }) })

  type Connection = Omit<RemoteHost, 'enabled'>

  const connection = (target = 'forge'): Connection => ({ id: randomUUID(), name: 'Forge fixture', target, identityFile: '', installPath: '/opt/sotto', dataDirectory: '/data/sotto' })

  /** Add host: connects, pairs and saves in one command. */
  async function add(target = 'forge'): Promise<Connection> {
    const remote = connection(target)
    await manager.command({ type: 'add', host: remote })
    return remote
  }

  const retainedEdit = (): RetainedDraft => ({ hostId: reportedHostId, registrationId: manager.get().hosts.find(host => host.hostId === reportedHostId)!.id, draft: { threadId: 'retained-thread', draftId: randomUUID(),
    text: 'Synthetic unsent retained text', attachments: [], requestId: null, updatedAt: new Date().toISOString() }, questionsDigest: null, saved: false, recovery: false })

  const retainedStore = (): RetainedDraftStore => (manager as unknown as { retainedDrafts: RetainedDraftStore }).retainedDrafts

  /** A thread on the host, connected, so its row on the Threads page has something to lose. */
  async function remoteThread(): Promise<string> {
    await manager.command({ type: 'select', hostId: reportedHostId })
    const client = desktopWindowClient('desktop-test')
    await router.command({ type: 'configure', patch: { provider: 'codex', enabledProviders: ['codex'] } }, client)
    await router.command({ type: 'connect', provider: 'codex' }, client)
    const state = await router.command({ type: 'create-project', provider: 'codex', title: 'Remote', path: root, useExisting: true }, client)
    const project = state.host.projects.find(item => item.path === root)!
    const threadId = randomUUID()
    await router.command({ type: 'create-thread', projectId: project.id, threadId, title: 'Remote task', modelId: state.host.models[0]!.id, managed: false, workingCopy: 'shared' }, client)
    const qualified = hostEntityKey(reportedHostId, threadId)
    await router.command({ type: 'select-thread', threadId: qualified }, client)
    return qualified
  }

  const row = (id: string) => router.shell().host.threads.find(thread => thread.id === id)

  return {
    FIXTURE_NODE,
    add,
    answers,
    get askOnConnect() { return askOnConnect },
    set askOnConnect(value: typeof askOnConnect) { askOnConnect = value },
    get beforeStopReply() { return beforeStopReply },
    set beforeStopReply(value: typeof beforeStopReply) { beforeStopReply = value },
    get boot() { return boot },
    set boot(value: typeof boot) { boot = value },
    get bootLeftOnStop() { return bootLeftOnStop },
    set bootLeftOnStop(value: typeof bootLeftOnStop) { bootLeftOnStop = value },
    get bootStart() { return bootStart },
    set bootStart(value: typeof bootStart) { bootStart = value },
    boots,
    connection,
    get credentials() { return credentials },
    set credentials(value: typeof credentials) { credentials = value },
    get desktopAnswersFailure() { return desktopAnswersFailure },
    set desktopAnswersFailure(value: typeof desktopAnswersFailure) { desktopAnswersFailure = value },
    failures,
    get host() { return host },
    set host(value: typeof host) { host = value },
    get hostRunning() { return hostRunning },
    set hostRunning(value: typeof hostRunning) { hostRunning = value },
    get hostTailscale() { return hostTailscale },
    set hostTailscale(value: typeof hostTailscale) { hostTailscale = value },
    get hostTailscaleRunning() { return hostTailscaleRunning },
    set hostTailscaleRunning(value: typeof hostTailscaleRunning) { hostTailscaleRunning = value },
    launchers,
    liveSocket,
    get manager() { return manager },
    set manager(value: typeof manager) { manager = value },
    newManager,
    get onConnect() { return onConnect },
    set onConnect(value: typeof onConnect) { onConnect = value },
    opened,
    operations,
    get owned() { return owned },
    set owned(value: typeof owned) { owned = value },
    pause,
    relaunch,
    remoteThread,
    get reportedHostId() { return reportedHostId },
    set reportedHostId(value: typeof reportedHostId) { reportedHostId = value },
    retainedEdit,
    retainedStore,
    get retryDelay() { return retryDelay },
    set retryDelay(value: typeof retryDelay) { retryDelay = value },
    get revokeError() { return revokeError },
    set revokeError(value: typeof revokeError) { revokeError = value },
    get revokeFails() { return revokeFails },
    set revokeFails(value: typeof revokeFails) { revokeFails = value },
    get root() { return root },
    set root(value: typeof root) { root = value },
    get router() { return router },
    set router(value: typeof router) { router = value },
    row,
    savedFile,
    scheduled,
    get stopResult() { return stopResult },
    set stopResult(value: typeof stopResult) { stopResult = value },
    stops,
    get tunnelUrl() { return tunnelUrl },
    set tunnelUrl(value: typeof tunnelUrl) { tunnelUrl = value },
    get updateHost() { return updateHost },
    set updateHost(value: typeof updateHost) { updateHost = value },
  }
}
