import { performance } from 'node:perf_hooks'
import type { AgentCommand } from '../../shared/agents'
import type { HostBrowserThreadRequest } from '../../shared/hostBrowser'
import type { OwnCleanupChoice } from '../../shared/ownServerCleanup'
import type { QuestionPageOpen } from '../../shared/questionPageOpen'
import type { AppSettings } from '../../shared/settings'
import type { BrowserAgentTools, BrowserMcpServer, BrowserToolDefinition, BrowserToolResult } from '../agents/browserAgentServer'
import type { CredentialSnapshot } from '../agents/credentials'
import type { ClientIdentity } from '../agents/hostService'
import type { ThreadToolCallContext } from '../agents/threadToolServer'
import { MainLoopMonitor } from '../performance/mainLoopMonitor'
import { mainProcessProfiler } from '../performance/profilers'
import type { ProfilerTarget, RawCpuProfile } from '../performance/activityRecorder'
import { createDesktopEngine } from './createDesktopEngine'
import { connectEngineClient, type EngineRpcConnection } from './transport'
import type { DesktopEngine, DesktopEngineOptions, EngineIpcRole, EngineMetadata, EngineShellBridge, EngineWindowFocus, GitChangesMethod, HostedGitChangesMethod, ProductEventFeature } from './types'

export interface EngineInitPayload {
  readonly options: DesktopEngineOptions
  readonly credentials: CredentialSnapshot
  readonly downloadsFolder: string
  readonly browserToolDefinitions: readonly BrowserToolDefinition[]
  readonly hasNotify: boolean
}

export interface EngineInitResult {
  readonly metadata: EngineMetadata
  readonly channels: readonly string[]
  readonly hasWatcherBridge: boolean
}

/** In-memory mirror of OS-encrypted credentials held by Electron's safeStorage broker (ADR-0210). */
class RemoteCredentialsCache {
  private availableFlag: boolean
  private plaintext: Record<string, string>
  private sealedValues: Record<string, string>

  constructor(initial: CredentialSnapshot, private readonly connection: EngineRpcConnection) {
    this.availableFlag = initial.available
    this.plaintext = { ...initial.plaintext }
    this.sealedValues = { ...initial.sealed }
  }

  applySnapshot(snapshot: CredentialSnapshot): void {
    this.availableFlag = snapshot.available
    this.plaintext = { ...snapshot.plaintext }
    this.sealedValues = { ...snapshot.sealed }
  }

  available(): boolean { return this.availableFlag }
  has(slot: string): boolean { return Boolean(this.sealedValues[slot]) }
  get(slot: string): string {
    if (!this.sealedValues[slot]) return ''
    if (!this.availableFlag) throw new Error('Unlock your operating system credential store to continue.')
    return this.plaintext[slot] ?? ''
  }
  sealed(slot: string): string | undefined { return this.sealedValues[slot] || undefined }

  async set(slot: string, value: string): Promise<void> {
    const updated = await this.connection.request<CredentialSnapshot>('shell:credentialsSet', [slot, value])
    this.applySnapshot(updated)
  }

  async restoreSealed(slot: string, sealed: string | undefined): Promise<void> {
    const updated = await this.connection.request<CredentialSnapshot>('shell:credentialsRestoreSealed', [slot, sealed])
    this.applySnapshot(updated)
  }
}

/**
 * Runs the Electron-free desktop engine over `connection` (ADR-0210).
 * Exported so integration tests can drive the exact same protocol against a real child process or in-process socket.
 */
export function attachEngineProcessServer(connection: EngineRpcConnection, onExit?: () => void): void {
  let engine: DesktopEngine | undefined
  let credentialsCache: RemoteCredentialsCache | undefined
  let activeProfiler: ProfilerTarget | null = null
  let shuttingDown = false

  const loopMonitor = new MainLoopMonitor({
    clock: {
      now: () => performance.now(),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    },
    onFrozenChange: () => undefined,
  })
  loopMonitor.start()

  const finishShutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    loopMonitor.stop()
    if (activeProfiler) {
      const profiler = activeProfiler
      activeProfiler = null
      await profiler.cancel().catch(() => undefined)
    }
    if (engine) {
      await engine.close().catch(() => undefined)
    }
    onExit?.()
  }

  connection.onClose(() => {
    // If the Electron parent exits or crashes, shut down cleanly so no orphan engine process remains.
    void finishShutdown()
  })

  connection.onPush((event, payload) => {
    if (event === 'shell:credentialsSync') {
      credentialsCache?.applySnapshot(payload as CredentialSnapshot)
      return
    }
    if (!engine) return
    switch (event) {
      case 'engine:setWindowFocus': engine.setWindowFocus(payload as EngineWindowFocus); break
      case 'engine:setPopupShown': engine.setPopupShown(Boolean(payload)); break
      case 'engine:setPopupObserved': engine.setPopupObserved(payload as readonly string[]); break
      case 'engine:setRunningTerminals': engine.setRunningTerminals(payload as readonly string[]); break
      case 'engine:releaseTerminalStart': engine.releaseTerminalStart(String(payload)); break
      case 'engine:onAppUpdatePhaseChanged': engine.onAppUpdatePhaseChanged(payload as string | undefined); break
      case 'engine:checkClientsAfresh': engine.checkClientsAfresh(); break
      case 'engine:featureUsed': engine.featureUsed(payload as ProductEventFeature); break
      case 'engine:questionPageOpened': void engine.questionPageOpened(payload as QuestionPageOpen); break
      case 'engine:prepareForShutdown': engine.prepareForShutdown(); break
      case 'engine:disposeIpc': engine.disposeIpc(); break
      case 'engine:e2eAgentEvent': void engine.e2eAgentEvent(payload); break
      case 'engine:mainWindowDeliveryMissed': engine.resetWindowBroadcast?.(); break
    }
  })

  connection.onRequest(async (method, args) => {
    if (method === 'engine:init') {
      if (engine) throw new Error('ENGINE_ALREADY_INITIALIZED')
      const payload = args[0] as EngineInitPayload
      const cache = credentialsCache = new RemoteCredentialsCache(payload.credentials, connection)
      const browserTools: BrowserAgentTools = {
        definitions: payload.browserToolDefinitions,
        call: (threadId: string, name: string, toolArgs: unknown, context?: ThreadToolCallContext) =>
          connection.request<BrowserToolResult>('shell:browserCall', [threadId, name, toolArgs, context]),
        mcpServer: (threadId: string) =>
          connection.request<BrowserMcpServer>('shell:browserMcpServer', [threadId]),
      }
      const shellBridge: EngineShellBridge = {
        openExternal: url => connection.request<void>('shell:openExternal', [url]),
        openPath: path => connection.request<string>('shell:openPath', [path]),
        revealInFolder: path => { connection.sendPush('shell:revealInFolder', path) },
        clipboardWrite: text => connection.request<void>('shell:clipboardWrite', [text]),
        credentials: {
          available: () => cache.available(),
          has: slot => cache.has(slot),
          get: slot => cache.get(slot),
          sealed: slot => cache.sealed(slot),
          set: (slot, value) => cache.set(slot, value),
          restoreSealed: (slot, sealed) => cache.restoreSealed(slot, sealed),
        },
        browserTools,
        endHostTerminals: hostId => connection.request<void>('shell:endHostTerminals', [hostId]),
        sendToMain: (channel, data) => {
          if (connection.isClosed) return false
          connection.sendPush('shell:sendToMain', { channel, payload: data })
          return true
        },
        sendToPopup: (channel, data) => { connection.sendPush('shell:sendToPopup', { channel, payload: data }) },
        ...(payload.hasNotify ? { notify: alert => { connection.sendPush('shell:notify', alert) } } : {}),
        publishRecoveryNotice: notice => { connection.sendPush('shell:publishRecoveryNotice', notice) },
        onFilesBindingsDelta: delta => { connection.sendPush('shell:filesBindingsDelta', delta) },
        onRestartHoldChanged: reason => { connection.sendPush('shell:restartHoldChanged', reason) },
        relaunchApp: () => { connection.sendPush('shell:relaunchApp', null) },
        downloadsFolder: () => payload.downloadsFolder,
        log: code => { connection.sendPush('shell:log', code) },
        readWritingSettings: () => connection.request<AppSettings>('shell:readWritingSettings'),
        onE2EFileAction: (kind, path) => { connection.sendPush('shell:e2eFileAction', { kind, path }) },
        onE2EExternalLink: url => { connection.sendPush('shell:e2eExternalLink', url) },
        onE2EThreadFolder: path => { connection.sendPush('shell:e2eThreadFolder', path) },
        onPopupObserved: threadIds => { connection.sendPush('shell:popupObserved', threadIds) },
      }
      engine = await createDesktopEngine(payload.options, shellBridge)
      const result: EngineInitResult = {
        metadata: engine.metadata,
        channels: engine.channels(),
        hasWatcherBridge: engine.watcherBridge !== undefined,
      }
      return result
    }

    if (!engine) throw new Error(`ENGINE_NOT_INITIALIZED: ${method}`)

    switch (method) {
      case 'engine:invokeIpc':
        return engine.invokeIpc(args[0] as string, args[1] as EngineIpcRole, args[2] as readonly unknown[])
      case 'engine:acquireTerminalStart':
        return engine.acquireTerminalStart(args[0] as string)
      case 'engine:onSettingsChanged':
        return engine.onSettingsChanged(args[0] as AppSettings, args[1] as AppSettings)
      case 'engine:cleanSettingsHistory':
        return engine.cleanSettingsHistory(() => connection.request<void>('shell:afterCleanSettingsHistory'))
      case 'engine:onInterfaceLanguageChanged':
        return engine.onInterfaceLanguageChanged(args[0] as AppSettings)
      case 'engine:restartHold':
        return engine.restartHold()
      case 'engine:readVisual':
        return engine.readVisual(args[0] as string, args[1] as string)
      case 'engine:threadMediaPart': {
        const found = await engine.threadMediaPart(args[0] as Parameters<DesktopEngine['threadMediaPart']>[0])
        if (!found) return null
        return {
          mimeType: found.mimeType,
          sizeBytes: found.sizeBytes,
          bytesBase64: Buffer.from(found.bytes.buffer, found.bytes.byteOffset, found.bytes.byteLength).toString('base64'),
        }
      }
      case 'engine:resolveOwnCleanupServer':
        return engine.resolveOwnCleanupServer(args[0] as OwnCleanupChoice)
      case 'engine:questionPageOpening':
        return engine.questionPageOpening(args[0] as QuestionPageOpen)
      case 'engine:phoneAccessPagePort':
        return engine.phoneAccessPagePort()
      case 'engine:openNotificationThread':
        return engine.openNotificationThread(args[0] as string)
      case 'engine:popupCommand':
        return engine.popupCommand(args[0] as AgentCommand, args[1] as ClientIdentity)
      case 'engine:gitChangesCall':
        return engine.gitChangesCall(args[0] as GitChangesMethod, args[1])
      case 'engine:hostedGitChangesCall':
        return engine.hostedGitChangesCall(args[0] as HostedGitChangesMethod, args[1])
      case 'engine:hostedBrowserCall':
        return engine.hostedBrowserCall(args[0] as HostBrowserThreadRequest)
      case 'engine:hostedBrowserAddress':
        return engine.hostedBrowserAddress(args[0] as string)
      case 'engine:turnRecordsInfo':
        return engine.turnRecordsInfo()
      case 'engine:e2eCertifiedDetailObservation':
        return engine.e2eCertifiedDetailObservation()
      case 'engine:e2eRemoteHostCall': {
        const harness = globalThis.sottoRemoteHostE2E
        if (!harness) throw new Error('E2E_REMOTE_HOST_UNAVAILABLE')
        const op = args[0] as keyof typeof harness
        const fn = harness[op] as ((...callArgs: unknown[]) => unknown) | undefined
        if (typeof fn !== 'function') throw new Error(`E2E_REMOTE_HOST_METHOD_UNKNOWN: ${String(op)}`)
        return fn(...args.slice(1))
      }
      case 'engine:e2eBabysitPass':
        return globalThis.sottoBabysitE2E?.pass()
      case 'engine:watcherCall': {
        const bridge = engine.watcherBridge
        if (!bridge) throw new Error('ENGINE_WATCHER_UNAVAILABLE')
        const op = args[0] as keyof NonNullable<DesktopEngine['watcherBridge']>
        const fn = bridge[op] as ((...callArgs: unknown[]) => unknown) | undefined
        if (typeof fn !== 'function') throw new Error(`ENGINE_WATCHER_METHOD_UNKNOWN: ${String(op)}`)
        return fn(...(args.slice(1)))
      }
      case 'engine:perfReading': {
        const reading = loopMonitor.reading()
        return { blockedShare: reading.blockedShare, longestFreezeMs: reading.longestFreezeMs, freezesOver100ms: reading.freezesOver100ms, bars: reading.bars }
      }
      case 'engine:perfStart': {
        if (activeProfiler) await activeProfiler.cancel().catch(() => undefined)
        activeProfiler = mainProcessProfiler()
        await activeProfiler.start()
        return true
      }
      case 'engine:perfStop': {
        const profiler = activeProfiler
        activeProfiler = null
        if (!profiler) return null
        return await profiler.stop() as RawCpuProfile
      }
      case 'engine:perfCancel': {
        const profiler = activeProfiler
        activeProfiler = null
        if (profiler) await profiler.cancel().catch(() => undefined)
        return true
      }
      case 'engine:close':
        await finishShutdown()
        return true
      default:
        throw new Error(`ENGINE_METHOD_UNKNOWN: ${method}`)
    }
  })
}

async function main(): Promise<void> {
  const endpoint = process.env['SOTTO_ENGINE_ENDPOINT']
  const token = process.env['SOTTO_ENGINE_TOKEN']
  // Clear auth secrets from process.env immediately so spawned provider CLIs never inherit them.
  delete process.env['SOTTO_ENGINE_ENDPOINT']
  delete process.env['SOTTO_ENGINE_TOKEN']
  if (!endpoint || !token) return

  const connection = await connectEngineClient(endpoint, token)
  attachEngineProcessServer(connection, () => {
    const hardExit = setTimeout(() => process.exit(0), 5_000)
    hardExit.unref()
    connection.close()
    process.exit(0)
  })
}

// Run only when launched as the dedicated engine process (never when imported by tests).
if (process.env['SOTTO_ENGINE_ENDPOINT'] && process.env['SOTTO_ENGINE_TOKEN']) {
  void main().catch(() => { process.exit(1) })
}
