import type { HotkeyChangeResult } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'

export interface PermissionWebContents {
  getURL(): string
  isDestroyed?(): boolean
}

export interface TrustedRenderer {
  readonly webContents: PermissionWebContents
  readonly url: string
}

export interface PermissionRequestDetails {
  readonly isMainFrame?: boolean
  readonly requestingUrl?: string
  readonly mediaTypes?: readonly string[]
}

export interface PermissionCheckDetails {
  readonly isMainFrame?: boolean
  readonly requestingUrl?: string
  readonly mediaType?: string
}

export type PermissionRequestHandler = (
  webContents: PermissionWebContents,
  permission: string,
  callback: (granted: boolean) => void,
  details: PermissionRequestDetails,
) => void

export type PermissionCheckHandler = (
  webContents: PermissionWebContents | null,
  permission: string,
  requestingOrigin: string,
  details: PermissionCheckDetails,
) => boolean

export interface SessionPermissionAdapter {
  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void
  setPermissionCheckHandler(handler: PermissionCheckHandler | null): void
}

const permissionOwners = new WeakMap<SessionPermissionAdapter, symbol>()

function findTrustedRenderer(
  webContents: PermissionWebContents | null,
  requestedUrl: string | undefined,
  trustedRenderers: readonly TrustedRenderer[],
): TrustedRenderer | undefined {
  if (
    webContents === null ||
    requestedUrl === undefined ||
    webContents.isDestroyed?.() === true
  ) {
    return undefined
  }

  return trustedRenderers.find(
    (trusted) =>
      trusted.webContents === webContents &&
      trusted.url === requestedUrl &&
      trusted.url === webContents.getURL(),
  )
}

export function installSessionPermissionPolicy(
  session: SessionPermissionAdapter,
  trustedRenderers: readonly TrustedRenderer[],
): () => void {
  const owner = Symbol('talktype-permission-owner')
  permissionOwners.set(session, owner)

  const requestHandler: PermissionRequestHandler = (
    webContents,
    permission,
    callback,
    details,
  ) => {
    const mediaTypes = details.mediaTypes
    const allowed =
      permission === 'media' &&
      details.isMainFrame === true &&
      Array.isArray(mediaTypes) &&
      mediaTypes.length > 0 &&
      mediaTypes.every((mediaType) => mediaType === 'audio') &&
      findTrustedRenderer(webContents, details.requestingUrl, trustedRenderers) !== undefined
    callback(allowed)
  }

  const checkHandler: PermissionCheckHandler = (
    webContents,
    permission,
    _requestingOrigin,
    details,
  ) =>
    permission === 'media' &&
    details.isMainFrame === true &&
    details.mediaType === 'audio' &&
    findTrustedRenderer(webContents, details.requestingUrl, trustedRenderers) !== undefined

  session.setPermissionCheckHandler(checkHandler)
  session.setPermissionRequestHandler(requestHandler)

  let cleaned = false
  return () => {
    if (cleaned) {
      return
    }
    cleaned = true
    if (permissionOwners.get(session) === owner) {
      permissionOwners.delete(session)
      session.setPermissionCheckHandler(null)
      session.setPermissionRequestHandler(null)
    }
  }
}

type BootstrapEvent = 'second-instance' | 'before-quit'
type BootstrapListener = () => void

export interface BootstrapApplication {
  requestSingleInstanceLock(): boolean
  whenReady(): Promise<void>
  on(event: BootstrapEvent, listener: BootstrapListener): void
  removeListener(event: BootstrapEvent, listener: BootstrapListener): void
  quit(): void
}

export interface RuntimeController {
  start(): Promise<void>
  showMain(): void
  beginQuit(): void
  dispose(): void
}

export interface NativeRuntimeWindowService {
  createWindows(): Promise<void>
  showMain(): Promise<void>
  beginQuit(): void
  dispose(): void
}

export interface NativeRuntimeHotkeyService {
  replace(accelerator: string): HotkeyChangeResult
  dispose(): void
}

export interface NativeRuntimeTrayService {
  update(state: { readonly dictating: boolean; readonly autoPaste: boolean }): void
  dispose(): void
}

export interface NativeRuntimeStartupService {
  set(enabled: boolean): unknown
}

export interface NativeRuntimeDependencies {
  readonly windows: NativeRuntimeWindowService
  readonly hotkeys: NativeRuntimeHotkeyService
  readonly tray: NativeRuntimeTrayService
  readonly startup: NativeRuntimeStartupService
  readonly settings: { get(): Promise<AppSettings> }
  readonly installPermissions: () => () => void
  readonly registerIpc: () => () => void
  readonly log: (code: 'native-hotkey-registration-failed' | 'native-main-show-failed') => void
}

export class NativeRuntimeStoppedError extends Error {
  readonly code = 'NATIVE_RUNTIME_STOPPED'

  constructor() {
    super('Native runtime stopped')
    this.name = 'NativeRuntimeStoppedError'
  }
}

export class NativeRuntimeController implements RuntimeController {
  private startPromise: Promise<void> | null = null
  private permissionCleanup: (() => void) | null = null
  private ipcCleanup: (() => void) | null = null
  private quitting = false
  private disposed = false

  constructor(private readonly dependencies: NativeRuntimeDependencies) {}

  start(): Promise<void> {
    if (this.isStopped()) {
      return Promise.reject(new NativeRuntimeStoppedError())
    }
    if (this.startPromise !== null) {
      return this.startPromise
    }

    this.startPromise = this.startOnce()
    return this.startPromise
  }

  showMain(): void {
    if (this.isStopped()) {
      return
    }
    void this.dependencies.windows.showMain().catch(() => {
      this.dependencies.log('native-main-show-failed')
    })
  }

  beginQuit(): void {
    if (this.quitting) {
      return
    }
    this.quitting = true
    this.dependencies.windows.beginQuit()
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.beginQuit()

    this.ipcCleanup?.()
    this.ipcCleanup = null
    this.permissionCleanup?.()
    this.permissionCleanup = null
    this.dependencies.hotkeys.dispose()
    this.dependencies.tray.dispose()
    this.dependencies.windows.dispose()
  }

  private async startOnce(): Promise<void> {
    await this.dependencies.windows.createWindows()
    this.assertRunning()
    this.permissionCleanup = this.installCleanup(this.dependencies.installPermissions)
    this.assertRunning()
    this.ipcCleanup = this.installCleanup(this.dependencies.registerIpc)
    this.assertRunning()
    const settings = await this.dependencies.settings.get()
    this.assertRunning()
    const hotkeyResult = this.dependencies.hotkeys.replace(settings.hotkey)
    this.assertRunning()
    if (!hotkeyResult.ok) {
      this.dependencies.log('native-hotkey-registration-failed')
      this.assertRunning()
    }
    this.dependencies.startup.set(settings.launchAtStartup)
    this.assertRunning()
    this.dependencies.tray.update({ dictating: false, autoPaste: settings.autoPaste })
    this.assertRunning()
    if (!settings.startMinimized) {
      await this.dependencies.windows.showMain()
      this.assertRunning()
    }
  }

  private installCleanup(installer: () => () => void): () => void {
    this.assertRunning()
    const cleanup = installer()
    if (this.isStopped()) {
      try {
        cleanup()
      } catch {
        // Shutdown ownership still wins if native cleanup itself fails.
      }
      throw new NativeRuntimeStoppedError()
    }
    return cleanup
  }

  private assertRunning(): void {
    if (this.isStopped()) {
      throw new NativeRuntimeStoppedError()
    }
  }

  private isStopped(): boolean {
    return this.disposed || this.quitting
  }
}

export type BootstrapDiagnostic =
  | 'bootstrap-readiness-failed'
  | 'bootstrap-startup-failed'

export interface BootstrapDependencies {
  readonly app: BootstrapApplication
  readonly initialize: () => RuntimeController | Promise<RuntimeController>
  readonly log: (code: BootstrapDiagnostic) => void
}

export type BootstrapResult =
  | Readonly<{ started: false; dispose: () => void }>
  | Readonly<{ started: true; dispose: () => void }>

export async function bootstrapTalkType(
  dependencies: BootstrapDependencies,
): Promise<BootstrapResult> {
  const { app } = dependencies
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return { started: false, dispose: () => undefined }
  }

  let runtime: RuntimeController | null = null
  let disposed = false
  let runtimeStarted = false
  let pendingSecondInstance = false
  const stopRuntime = (candidate: RuntimeController): void => {
    candidate.beginQuit()
    candidate.dispose()
  }
  const onSecondInstance = (): void => {
    if (disposed) {
      return
    }
    if (runtimeStarted && runtime !== null) {
      runtime.showMain()
      return
    }
    pendingSecondInstance = true
  }
  const consumePendingSecondInstance = (): boolean => {
    const pending = pendingSecondInstance
    pendingSecondInstance = false
    return pending
  }
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    pendingSecondInstance = false
    runtimeStarted = false
    app.removeListener('second-instance', onSecondInstance)
    app.removeListener('before-quit', onBeforeQuit)
    const activeRuntime = runtime
    runtime = null
    if (activeRuntime !== null) {
      stopRuntime(activeRuntime)
    }
  }
  const onBeforeQuit = (): void => dispose()

  app.on('second-instance', onSecondInstance)
  app.on('before-quit', onBeforeQuit)

  try {
    await app.whenReady()
  } catch {
    if (disposed) {
      return { started: false, dispose }
    }
    dependencies.log('bootstrap-readiness-failed')
    dispose()
    app.quit()
    return { started: false, dispose }
  }

  if (disposed) {
    return { started: false, dispose }
  }

  let candidate: RuntimeController
  try {
    candidate = await dependencies.initialize()
  } catch {
    if (disposed) {
      return { started: false, dispose }
    }
    dependencies.log('bootstrap-startup-failed')
    dispose()
    app.quit()
    return { started: false, dispose }
  }

  if (disposed) {
    stopRuntime(candidate)
    return { started: false, dispose }
  }

  runtime = candidate
  try {
    await candidate.start()
  } catch {
    if (disposed) {
      return { started: false, dispose }
    }
    dependencies.log('bootstrap-startup-failed')
    dispose()
    app.quit()
    return { started: false, dispose }
  }

  if (disposed) {
    return { started: false, dispose }
  }

  runtimeStarted = true
  if (consumePendingSecondInstance()) {
    candidate.showMain()
  }

  return { started: true, dispose }
}
