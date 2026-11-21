import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { AGENT_STATE, type AgentCommand, type AgentState, type AgentThreadMediaPartRequest } from '../../shared/agents'
import type { ThreadAlert } from '../../shared/desktopNotifications'
import type { HostBrowserThreadRequest } from '../../shared/hostBrowser'
import type { MainLoopReading } from '../../shared/mainActivity'
import type { NotificationOpening } from '../../shared/desktopNotifications'
import type { OwnCleanupChoice } from '../../shared/ownServerCleanup'
import type { QuestionPageOpen } from '../../shared/questionPageOpen'
import type { RecoveryNotice } from '../../shared/recoveryNotice'
import type { AppSettings } from '../../shared/settings'
import type { ToolsResult } from '../../shared/tools'
import type { AgentVisual } from '../../shared/visuals'
import type { ClientIdentity } from '../agents/hostService'
import type { ThreadToolCallContext } from '../agents/threadToolServer'
import type { ThreadVideoPart } from '../agents/threadMediaScheme'
import type { RoomBridge } from '../agents/watcherRoomDesktop'
import type { QuestionPageOpening } from '../hosts/desktopHostRouter'
import type { OwnCleanupResolution } from '../llm/ownServerCleanup'
import type { ProfilerTarget, RawCpuProfile } from '../performance/activityRecorder'
import type { RemoteHostE2E, RemoteHostE2EConnection } from '../e2e/remoteHost'
import type { EngineInitPayload, EngineInitResult } from './engineProcess'
import { createEngineEndpoint, generateEngineToken, listenEngineServer, type EngineRpcConnection } from './transport'
import type { DesktopEngine, DesktopEngineOptions, EngineCertifiedDetailStats, EngineIpcRole, EngineShellBridge, EngineTurnRecordsInfo, EngineWindowFocus, FilesBindingsDelta, GitChangesMethod, HostedGitChangesMethod, ProductEventFeature } from './types'

const ENGINE_INIT_TIMEOUT_MS = 30_000
const ENGINE_CLOSE_TIMEOUT_MS = 20_000

export interface OutOfProcessEngineLauncherOptions {
  /** Built path to `engineProcess.js`; defaults to `join(__dirname, 'engineProcess.js')`. */
  readonly entryPath?: string
  /** Process executable; defaults to `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. */
  readonly executable?: string
  /** Extra args passed before `entryPath` (tests use this if needed). */
  readonly execArgv?: readonly string[]
  /** Optional custom spawner for tests. */
  readonly spawnProcess?: (endpoint: string, token: string) => ChildProcess
  /** Handshake timeout override for tests. */
  readonly handshakeTimeoutMs?: number
}

/**
 * Starts the desktop engine in a dedicated child process and returns a `DesktopEngine` proxy over the
 * authenticated `EngineTransport` pipe/UDS (ADR-0210).
 *
 * All streaming pushes (`sendToMain`, `sendToPopup`, `filesBindingsDelta`) are forwarded straight through
 * without re-validating schemas or cloning snapshots.
 */
export async function startOutOfProcessEngine(
  options: DesktopEngineOptions,
  shellBridge: EngineShellBridge,
  launcher: OutOfProcessEngineLauncherOptions = {},
): Promise<DesktopEngine> {
  const endpoint = createEngineEndpoint('sotto-engine')
  const token = generateEngineToken()
  const server = await listenEngineServer(endpoint, token)

  const entryPath = launcher.entryPath ?? join(__dirname, 'engineProcess.js')
  const child: ChildProcess = launcher.spawnProcess
    ? launcher.spawnProcess(endpoint, token)
    : spawn(launcher.executable ?? process.execPath, [...(launcher.execArgv ?? []), entryPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SOTTO_ENGINE_ENDPOINT: endpoint,
        SOTTO_ENGINE_TOKEN: token,
      },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    })

  let intentionalShutdown = false
  let unexpectedExitReported = false
  let nextCleanCallbackId = 1
  const cleanCallbacks = new Map<number, () => Promise<void>>()
  let cachedRestartHold: string | undefined

  const reportUnexpectedExit = (): void => {
    if (intentionalShutdown || unexpectedExitReported) return
    unexpectedExitReported = true
    shellBridge.log('engine-process-exited')
    shellBridge.publishRecoveryNotice({ code: 'ENGINE_EXITED' })
  }

  let connection: EngineRpcConnection
  try {
    connection = await new Promise<EngineRpcConnection>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      child.once('error', error => fail(error instanceof Error ? error : new Error(String(error))))
      child.once('exit', (code, signal) => fail(new Error(`ENGINE_EXITED_BEFORE_READY: code=${String(code)} signal=${String(signal)}`)))
      server.waitForClient(launcher.handshakeTimeoutMs).then(conn => {
        if (settled) { conn.close(); return }
        settled = true
        resolve(conn)
      }, fail)
    })
  } catch (error) {
    intentionalShutdown = true
    try { child.kill() } catch { /* ignore */ }
    await server.close().catch(() => undefined)
    throw error
  }

  // Forward stable exit notices after startup.
  child.once('exit', () => { reportUnexpectedExit() })
  connection.onClose(() => { reportUnexpectedExit() })

  // Register reverse-RPC & push handlers before sending `engine:init` so init-time callbacks work immediately.
  connection.onPush((event, payload) => {
    switch (event) {
      case 'shell:sendToMain': {
        const message = payload as { readonly channel: string; readonly payload: unknown }
        const delivered = shellBridge.sendToMain(message.channel, message.payload)
        if (!delivered && message.channel === AGENT_STATE) connection.sendPush('engine:mainWindowDeliveryMissed', null)
        break
      }
      case 'shell:sendToPopup': {
        const message = payload as { readonly channel: string; readonly payload: unknown }
        shellBridge.sendToPopup(message.channel, message.payload)
        break
      }
      case 'shell:filesBindingsDelta':
        shellBridge.onFilesBindingsDelta(payload as FilesBindingsDelta)
        break
      case 'shell:restartHoldChanged':
        cachedRestartHold = payload as string | undefined
        shellBridge.onRestartHoldChanged?.(cachedRestartHold)
        break
      case 'shell:notify':
        shellBridge.notify?.(payload as ThreadAlert)
        break
      case 'shell:publishRecoveryNotice':
        shellBridge.publishRecoveryNotice(payload as RecoveryNotice)
        break
      case 'shell:revealInFolder':
        shellBridge.revealInFolder(payload as string)
        break
      case 'shell:relaunchApp':
        shellBridge.relaunchApp()
        break
      case 'shell:log':
        shellBridge.log(payload as string)
        break
      case 'shell:e2eFileAction': {
        const action = payload as { readonly kind: 'open' | 'show'; readonly path: string }
        shellBridge.onE2EFileAction?.(action.kind, action.path)
        break
      }
      case 'shell:e2eExternalLink':
        shellBridge.onE2EExternalLink?.(payload as string)
        break
      case 'shell:e2eThreadFolder':
        shellBridge.onE2EThreadFolder?.(payload as string)
        break
      case 'shell:popupObserved':
        shellBridge.onPopupObserved?.(payload as readonly string[])
        break
    }
  })

  connection.onRequest(async (method, args) => {
    switch (method) {
      case 'shell:openExternal':
        return shellBridge.openExternal(args[0] as string)
      case 'shell:openPath':
        return shellBridge.openPath(args[0] as string)
      case 'shell:clipboardWrite':
        return shellBridge.clipboardWrite(args[0] as string)
      case 'shell:endHostTerminals':
        return shellBridge.endHostTerminals(args[0] as string)
      case 'shell:readWritingSettings':
        return shellBridge.readWritingSettings()
      case 'shell:browserCall':
        return shellBridge.browserTools.call(args[0] as string, args[1] as string, args[2], args[3] as ThreadToolCallContext | undefined)
      case 'shell:browserMcpServer':
        return shellBridge.browserTools.mcpServer(args[0] as string)
      case 'shell:credentialsSet':
        await shellBridge.credentials.set(args[0] as string, args[1] as string)
        return snapshotCredentials(shellBridge)
      case 'shell:credentialsRestoreSealed':
        await shellBridge.credentials.restoreSealed(args[0] as string, args[1] as string | undefined)
        return snapshotCredentials(shellBridge)
      case 'shell:afterCleanSettingsHistory': {
        const callbackId = args[0] as number
        const callback = cleanCallbacks.get(callbackId)
        if (callback) await callback()
        return true
      }
      case 'shell:mediaThumbnail':
        return shellBridge.mediaThumbnail ? shellBridge.mediaThumbnail(args[0] as string, args[1] as number) : null
      case 'shell:redrawPhoto': {
        if (!shellBridge.redrawPhoto) return null
        const raw = args[0] as Uint8Array
        return shellBridge.redrawPhoto(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), args[1] as 'image/jpeg' | 'image/png')
      }
      default:
        throw new Error(`SHELL_METHOD_UNKNOWN: ${method}`)
    }
  })

  let lastCredentialsAvailable = shellBridge.credentials.available()
  const syncCredentialsIfAvailabilityChanged = (): void => {
    const nowAvailable = shellBridge.credentials.available()
    if (nowAvailable !== lastCredentialsAvailable) {
      lastCredentialsAvailable = nowAvailable
      if (!connection.isClosed) connection.sendPush('shell:credentialsSync', snapshotCredentials(shellBridge))
    }
  }
  const unsubscribeCredentials = shellBridge.credentials.subscribe?.(() => {
    lastCredentialsAvailable = shellBridge.credentials.available()
    if (!connection.isClosed) connection.sendPush('shell:credentialsSync', snapshotCredentials(shellBridge))
  })

  let initResult: EngineInitResult
  try {
    const initPayload: EngineInitPayload = {
      options,
      credentials: snapshotCredentials(shellBridge),
      downloadsFolder: shellBridge.downloadsFolder(),
      browserToolDefinitions: shellBridge.browserTools.definitions,
      hasNotify: shellBridge.notify !== undefined,
      hasMediaThumbnail: shellBridge.mediaThumbnail !== undefined,
      hasRedrawPhoto: shellBridge.redrawPhoto !== undefined,
    }
    initResult = await connection.request<EngineInitResult>('engine:init', [initPayload], ENGINE_INIT_TIMEOUT_MS)
  } catch (error) {
    intentionalShutdown = true
    unsubscribeCredentials?.()
    connection.close()
    try { child.kill() } catch { /* ignore */ }
    await server.close().catch(() => undefined)
    throw error
  }

  const watcherCall = <T>(op: keyof RoomBridge, ...args: unknown[]): Promise<T> =>
    connection.request<T>('engine:watcherCall', [op, ...args])

  const watcherBridge: RoomBridge | undefined = initResult.hasWatcherBridge ? {
    get: () => watcherCall('get'),
    open: request => watcherCall('open', request),
    prepareStopAll: () => watcherCall('prepareStopAll'),
    stopAll: request => watcherCall('stopAll', request),
    setPermission: request => watcherCall('setPermission', request),
    watchThread: request => watcherCall('watchThread', request),
    unwatchThread: request => watcherCall('unwatchThread', request),
    readHandover: () => watcherCall('readHandover'),
    continueWithHandover: request => watcherCall('continueWithHandover', request),
    dismissHandover: () => watcherCall('dismissHandover'),
    startNew: () => watcherCall('startNew'),
    tryNow: () => watcherCall('tryNow'),
    readMachines: () => watcherCall('readMachines'),
  } : undefined

  const engineProfiler = (): ProfilerTarget => ({
    start: async () => { await connection.request('engine:perfStart') },
    stop: async () => {
      const profile = await connection.request<RawCpuProfile | null>('engine:perfStop')
      if (!profile) throw new Error('ENGINE_PROFILE_UNAVAILABLE')
      return profile
    },
    cancel: async () => { await connection.request('engine:perfCancel').catch(() => undefined) },
  })

  const engineLoopReading = (): Promise<Omit<MainLoopReading, 'frozen'> | null> =>
    connection.request<Omit<MainLoopReading, 'frozen'>>('engine:perfReading').catch(() => null)

  let installedRemoteHostProxy: RemoteHostE2E | undefined
  let installedBabysitProxy: { pass(): Promise<void> } | undefined
  if (options.e2eConfiguration !== null && !options.isPackaged) {
    // Development-only E2E global proxies so Playwright's `app.evaluate` reaches the out-of-process engine.
    installedRemoteHostProxy = {
      connect: (input: RemoteHostE2EConnection) => connection.request<void>('engine:e2eRemoteHostCall', ['connect', input]),
      disconnect: (hostId: string, keepThreads?: boolean) => connection.request<void>('engine:e2eRemoteHostCall', ['disconnect', hostId, keepThreads]),
      receiptReads: (hostId: string) => connection.request<number>('engine:e2eRemoteHostCall', ['receiptReads', hostId]) as unknown as number,
      completedReceiptReads: (hostId: string) => connection.request<number>('engine:e2eRemoteHostCall', ['completedReceiptReads', hostId]) as unknown as number,
      completedIdleReceiptReads: (hostId: string) => connection.request<number>('engine:e2eRemoteHostCall', ['completedIdleReceiptReads', hostId]) as unknown as number,
      releaseReceipts: (hostId: string) => { void connection.request('engine:e2eRemoteHostCall', ['releaseReceipts', hostId]).catch(() => undefined) },
      close: () => connection.request<void>('engine:e2eRemoteHostCall', ['close']),
    }
    globalThis.sottoRemoteHostE2E = installedRemoteHostProxy
    installedBabysitProxy = { pass: () => connection.request<void>('engine:e2eBabysitPass') }
    globalThis.sottoBabysitE2E = installedBabysitProxy
  }

  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    intentionalShutdown = true
    if (installedRemoteHostProxy && globalThis.sottoRemoteHostE2E === installedRemoteHostProxy) globalThis.sottoRemoteHostE2E = undefined
    if (installedBabysitProxy && globalThis.sottoBabysitE2E === installedBabysitProxy) globalThis.sottoBabysitE2E = undefined
    unsubscribeCredentials?.()
    let closeError: unknown
    if (!connection.isClosed) {
      try { await connection.request('engine:close', [], ENGINE_CLOSE_TIMEOUT_MS) }
      catch (error) { closeError = error }
    }
    connection.close()
    await waitForChildExit(child, 3_000)
    await server.close().catch(() => undefined)
    if (closeError !== undefined) throw closeError
  })()

  return {
    metadata: initResult.metadata,
    channels: () => initResult.channels,
    invokeIpc: (channel: string, role: EngineIpcRole, args: readonly unknown[]) =>
      connection.request('engine:invokeIpc', [channel, role, args]),
    watcherBridge,

    setWindowFocus: (state: EngineWindowFocus) => {
      syncCredentialsIfAvailabilityChanged()
      connection.sendPush('engine:setWindowFocus', state)
    },
    setPopupShown: (shown: boolean) => { connection.sendPush('engine:setPopupShown', shown) },
    setPopupObserved: (threadIds: readonly string[]) => { connection.sendPush('engine:setPopupObserved', threadIds) },
    setRunningTerminals: (threadIds: readonly string[]) => { connection.sendPush('engine:setRunningTerminals', threadIds) },
    acquireTerminalStart: (workingDirectory: string) => connection.request<string>('engine:acquireTerminalStart', [workingDirectory]),
    releaseTerminalStart: (leaseId: string) => { connection.sendPush('engine:releaseTerminalStart', leaseId) },

    onSettingsChanged: (settings: AppSettings, previous: AppSettings) =>
      connection.request<void>('engine:onSettingsChanged', [settings, previous]),
    cleanSettingsHistory: async (afterClean: () => Promise<void>) => {
      const callbackId = nextCleanCallbackId++
      cleanCallbacks.set(callbackId, afterClean)
      try { await connection.request<void>('engine:cleanSettingsHistory', [callbackId]) }
      finally { cleanCallbacks.delete(callbackId) }
    },
    onInterfaceLanguageChanged: (settings: AppSettings) =>
      connection.request<void>('engine:onInterfaceLanguageChanged', [settings]),
    onAppUpdatePhaseChanged: (waitingHostVersion: string | undefined) => {
      connection.sendPush('engine:onAppUpdatePhaseChanged', waitingHostVersion)
    },
    checkClientsAfresh: () => { connection.sendPush('engine:checkClientsAfresh', null) },
    restartHold: () => cachedRestartHold,
    featureUsed: (feature: ProductEventFeature) => { connection.sendPush('engine:featureUsed', feature) },

    readVisual: (threadId: string, visualId: string) =>
      connection.request<AgentVisual | undefined>('engine:readVisual', [threadId, visualId]),
    threadMediaPart: async (part: AgentThreadMediaPartRequest): Promise<ThreadVideoPart | null> => {
      const result = await connection.request<{ readonly mimeType: string; readonly sizeBytes: number; readonly bytesBase64: string } | null>('engine:threadMediaPart', [part])
      if (!result) return null
      return { mimeType: result.mimeType, sizeBytes: result.sizeBytes, bytes: new Uint8Array(Buffer.from(result.bytesBase64, 'base64')) }
    },
    resolveOwnCleanupServer: (choice: OwnCleanupChoice) =>
      connection.request<OwnCleanupResolution>('engine:resolveOwnCleanupServer', [choice]),
    questionPageOpening: (input: QuestionPageOpen) =>
      connection.request<QuestionPageOpening | null>('engine:questionPageOpening', [input]),
    questionPageOpened: (input: QuestionPageOpen) => { connection.sendPush('engine:questionPageOpened', input) },
    phoneAccessPagePort: () => connection.request<number | null>('engine:phoneAccessPagePort'),
    openNotificationThread: (threadId: string) =>
      connection.request<NotificationOpening>('engine:openNotificationThread', [threadId]),
    popupCommand: (command: AgentCommand, client: ClientIdentity) =>
      connection.request<AgentState>('engine:popupCommand', [command, client]),
    gitChangesCall: (method: GitChangesMethod, payload: unknown) =>
      connection.request('engine:gitChangesCall', [method, payload]),
    hostedGitChangesCall: (method: HostedGitChangesMethod, payload: unknown) =>
      connection.request<ToolsResult<unknown>>('engine:hostedGitChangesCall', [method, payload]),
    hostedBrowserCall: (request: HostBrowserThreadRequest) =>
      connection.request<ToolsResult<unknown>>('engine:hostedBrowserCall', [request]),
    hostedBrowserAddress: (hostId: string) =>
      connection.request<string | undefined>('engine:hostedBrowserAddress', [hostId]),
    turnRecordsInfo: () => connection.request<EngineTurnRecordsInfo>('engine:turnRecordsInfo'),

    e2eAgentEvent: (payload: unknown) => { connection.sendPush('engine:e2eAgentEvent', payload) },
    e2eCertifiedDetailObservation: () =>
      connection.request<EngineCertifiedDetailStats | undefined>('engine:e2eCertifiedDetailObservation'),

    engineProfiler,
    engineLoopReading,

    prepareForShutdown: () => {
      intentionalShutdown = true
      connection.sendPush('engine:prepareForShutdown', null)
    },
    disposeIpc: () => { connection.sendPush('engine:disposeIpc', null) },
    close,
  }
}

function snapshotCredentials(shellBridge: EngineShellBridge) {
  if (shellBridge.credentials.exportSnapshot) return shellBridge.credentials.exportSnapshot()
  return { available: shellBridge.credentials.available(), plaintext: {}, sealed: {}, unreadable: {} }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const done = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      resolve()
    }, timeoutMs)
    child.once('exit', done)
  })
}
