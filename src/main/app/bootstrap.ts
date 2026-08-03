import type { HotkeyChangeResult } from '../../shared/contracts'
import type { AppSettings } from '../../shared/settings'
import type { RendererRole } from '../security'

export interface PermissionWebContents {
  getURL(): string
  isDestroyed?(): boolean
}

export interface TrustedRenderer {
  readonly role: RendererRole
  readonly webContents: PermissionWebContents
  readonly url: string
}

export type TrustedRendererProvider = () => readonly TrustedRenderer[]

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

interface InstalledPermissionPolicy {
  readonly checkHandler: PermissionCheckHandler
  readonly requestHandler: PermissionRequestHandler
  readonly previous: InstalledPermissionPolicy | null
  cancelled: boolean
}

const permissionOwners = new WeakMap<SessionPermissionAdapter, InstalledPermissionPolicy>()

export class PermissionPolicyInstallError extends Error {
  readonly code = 'PERMISSION_POLICY_INSTALL_FAILED'

  constructor() {
    super('Permission policy installation failed')
    this.name = 'PermissionPolicyInstallError'
  }
}

export class PermissionPolicyCleanupError extends Error {
  readonly code = 'PERMISSION_POLICY_CLEANUP_FAILED'

  constructor() {
    super('Permission policy cleanup failed')
    this.name = 'PermissionPolicyCleanupError'
  }
}

function findTrustedRenderer(
  webContents: PermissionWebContents | null,
  requestedUrl: string | undefined,
  trustedRenderers: TrustedRendererProvider,
): TrustedRenderer | undefined {
  try {
    if (
      webContents === null ||
      requestedUrl === undefined ||
      webContents.isDestroyed?.() === true
    ) {
      return undefined
    }
    return trustedRenderers().find(
      (trusted) =>
        trusted.role === 'main' &&
        trusted.webContents === webContents &&
        trusted.url === requestedUrl &&
        trusted.url === webContents.getURL(),
    )
  } catch {
    return undefined
  }
}

export type MediaAccessGate = () => Promise<boolean>

async function grantWhenMediaAccessible(
  webContents: PermissionWebContents,
  requestedUrl: string | undefined,
  trustedRenderers: TrustedRendererProvider,
  mediaAccess: MediaAccessGate,
  callback: (granted: boolean) => void,
): Promise<void> {
  let accessible: boolean
  try {
    accessible = await mediaAccess()
  } catch {
    accessible = false
  }
  // An OS consent dialog can outlive the renderer that asked, so the identity
  // that earned this grant has to be re-proven before the grant is delivered.
  const granted =
    accessible &&
    findTrustedRenderer(webContents, requestedUrl, trustedRenderers) !== undefined
  try {
    callback(granted)
  } catch {
    // The caller owns the callback; a throwing consumer must not escape into
    // an unhandled rejection.
  }
}

export function installSessionPermissionPolicy(
  session: SessionPermissionAdapter,
  trustedRenderers: TrustedRendererProvider,
  // Omitted means no OS-level microphone gate exists on this platform, and the
  // grant stays synchronous exactly as it was before the gate was introduced.
  mediaAccess?: MediaAccessGate,
): () => void {
  const previous = permissionOwners.get(session) ?? null

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
    if (!allowed || mediaAccess === undefined) {
      callback(allowed)
      return
    }
    void grantWhenMediaAccessible(
      webContents,
      details.requestingUrl,
      trustedRenderers,
      mediaAccess,
      callback,
    )
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

  const installed: InstalledPermissionPolicy = {
    checkHandler,
    requestHandler,
    previous,
    cancelled: false,
  }

  try {
    setPermissionHandlers(session, installed)
  } catch {
    if (!trySetPermissionHandlers(session, previous)) {
      trySetPermissionHandlers(session, null)
      permissionOwners.delete(session)
    }
    throw new PermissionPolicyInstallError()
  }
  permissionOwners.set(session, installed)

  return () => {
    if (installed.cancelled) {
      return
    }
    if (permissionOwners.get(session) !== installed) {
      installed.cancelled = true
      return
    }

    let restored = installed.previous
    while (restored?.cancelled === true) {
      restored = restored.previous
    }
    try {
      setPermissionHandlers(session, restored)
    } catch {
      if (!trySetPermissionHandlers(session, installed)) {
        trySetPermissionHandlers(session, null)
        permissionOwners.delete(session)
      }
      throw new PermissionPolicyCleanupError()
    }

    installed.cancelled = true
    if (restored === null) {
      permissionOwners.delete(session)
    } else {
      permissionOwners.set(session, restored)
    }
  }
}

function setPermissionHandlers(
  session: SessionPermissionAdapter,
  policy: InstalledPermissionPolicy | null,
): void {
  session.setPermissionCheckHandler(policy?.checkHandler ?? null)
  session.setPermissionRequestHandler(policy?.requestHandler ?? null)
}

function trySetPermissionHandlers(
  session: SessionPermissionAdapter,
  policy: InstalledPermissionPolicy | null,
): boolean {
  try {
    setPermissionHandlers(session, policy)
    return true
  } catch {
    return false
  }
}

type BootstrapEvent = 'second-instance' | 'activate' | 'before-quit'
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
  showWidget(): Promise<void>
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
  readonly installProtocols?: () => () => void
  readonly registerIpc: () => () => void
  readonly publishIdleWidgetState?: (settings: AppSettings) => Promise<void>
  readonly log: (code: NativeRuntimeDiagnostic) => void
}

export type NativeRuntimeDiagnostic =
  | 'native-hotkey-registration-failed'
  | 'native-main-show-failed'
  | 'native-window-begin-quit-failed'
  | 'native-ipc-cleanup-failed'
  | 'native-protocol-cleanup-failed'
  | 'native-permission-cleanup-failed'
  | 'native-hotkey-cleanup-failed'
  | 'native-tray-cleanup-failed'
  | 'native-window-cleanup-failed'

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
  private protocolCleanup: (() => void) | null = null
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
    this.runTeardownStep(
      () => this.dependencies.windows.beginQuit(),
      'native-window-begin-quit-failed',
    )
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.beginQuit()

    const ipcCleanup = this.ipcCleanup
    this.ipcCleanup = null
    const permissionCleanup = this.permissionCleanup
    this.permissionCleanup = null

    const protocolCleanup = this.protocolCleanup
    this.protocolCleanup = null

    this.runTeardownStep(ipcCleanup, 'native-ipc-cleanup-failed')
    this.runTeardownStep(protocolCleanup, 'native-protocol-cleanup-failed')
    this.runTeardownStep(permissionCleanup, 'native-permission-cleanup-failed')
    this.runTeardownStep(
      () => this.dependencies.hotkeys.dispose(),
      'native-hotkey-cleanup-failed',
    )
    this.runTeardownStep(
      () => this.dependencies.tray.dispose(),
      'native-tray-cleanup-failed',
    )
    this.runTeardownStep(
      () => this.dependencies.windows.dispose(),
      'native-window-cleanup-failed',
    )
  }

  private async startOnce(): Promise<void> {
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
    this.permissionCleanup = this.installCleanup(
      this.dependencies.installPermissions,
      'native-permission-cleanup-failed',
    )
    this.assertRunning()
    if (this.dependencies.installProtocols !== undefined) {
      this.protocolCleanup = this.installCleanup(
        this.dependencies.installProtocols,
        'native-protocol-cleanup-failed',
      )
      this.assertRunning()
    }
    this.ipcCleanup = this.installCleanup(
      this.dependencies.registerIpc,
      'native-ipc-cleanup-failed',
    )
    this.assertRunning()
    await this.dependencies.windows.createWindows()
    this.assertRunning()
    if (!settings.startMinimized) {
      await this.dependencies.windows.showMain()
      this.assertRunning()
    }
    if (settings.onboardingComplete && settings.showWidgetWhenIdle) {
      // The dictation widget rests as a persistent sliver once setup is done,
      // unless the user turned the idle sliver off in Settings.
      await this.dependencies.windows.showWidget()
      this.assertRunning()
    }
    if (settings.onboardingComplete && this.dependencies.publishIdleWidgetState !== undefined) {
      // The widget renderer paints nothing until it receives a snapshot; the
      // first session is the earliest a renderer would publish one, so the
      // resting sliver needs this seed to exist on a cold launch.
      await this.dependencies.publishIdleWidgetState(settings)
      this.assertRunning()
    }
  }

  private installCleanup(
    installer: () => () => void,
    cleanupFailureCode:
      | 'native-permission-cleanup-failed'
      | 'native-protocol-cleanup-failed'
      | 'native-ipc-cleanup-failed',
  ): () => void {
    this.assertRunning()
    const cleanup = installer()
    if (this.isStopped()) {
      this.runTeardownStep(cleanup, cleanupFailureCode)
      throw new NativeRuntimeStoppedError()
    }
    return cleanup
  }

  private runTeardownStep(
    operation: (() => void) | null,
    failureCode: NativeRuntimeDiagnostic,
  ): void {
    if (operation === null) {
      return
    }
    try {
      operation()
    } catch {
      try {
        this.dependencies.log(failureCode)
      } catch {
        // Teardown must remain best-effort even when diagnostics are unavailable.
      }
    }
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
  | 'bootstrap-runtime-begin-quit-failed'
  | 'bootstrap-runtime-dispose-failed'

export interface BootstrapDependencies {
  readonly app: BootstrapApplication
  readonly initialize: () => RuntimeController | Promise<RuntimeController>
  readonly log: (code: BootstrapDiagnostic) => void
}

export type BootstrapResult =
  | Readonly<{ started: false; dispose: () => void }>
  | Readonly<{ started: true; dispose: () => void }>

export async function bootstrapSotto(
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
  let pendingShowRequest = false
  const stopRuntime = (candidate: RuntimeController): void => {
    try {
      candidate.beginQuit()
    } catch {
      try {
        dependencies.log('bootstrap-runtime-begin-quit-failed')
      } catch {
        // Shutdown must remain best-effort even when diagnostics are unavailable.
      }
    }
    try {
      candidate.dispose()
    } catch {
      try {
        dependencies.log('bootstrap-runtime-dispose-failed')
      } catch {
        // Shutdown must remain best-effort even when diagnostics are unavailable.
      }
    }
  }
  const onShowRequest = (): void => {
    if (disposed) {
      return
    }
    if (runtimeStarted && runtime !== null) {
      runtime.showMain()
      return
    }
    pendingShowRequest = true
  }
  const consumePendingShowRequest = (): boolean => {
    const pending = pendingShowRequest
    pendingShowRequest = false
    return pending
  }
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    pendingShowRequest = false
    runtimeStarted = false
    app.removeListener('second-instance', onShowRequest)
    app.removeListener('activate', onShowRequest)
    app.removeListener('before-quit', onBeforeQuit)
    const activeRuntime = runtime
    runtime = null
    if (activeRuntime !== null) {
      stopRuntime(activeRuntime)
    }
  }
  const onBeforeQuit = (): void => dispose()

  // 'activate' (macOS Dock/menu-bar reopen) and 'second-instance' (Windows
  // relaunch) are the same intent: the user asked for the main window.
  app.on('second-instance', onShowRequest)
  app.on('activate', onShowRequest)
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
  if (consumePendingShowRequest()) {
    candidate.showMain()
  }

  return { started: true, dispose }
}
