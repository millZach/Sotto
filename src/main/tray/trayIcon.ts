import type { TrayIconSource } from '../platformProfile'

export interface TrayIconLike {
  isEmpty(): boolean
}

export interface DestroyableTray {
  destroy(): void
}

export interface CreateTrayResourceOptions<
  Icon extends TrayIconLike,
  TrayResource extends DestroyableTray,
> {
  readonly source: TrayIconSource
  readonly executablePath: string
  /**
   * Absolute path to the brand icon file, supplied only when the running
   * executable is not the packaged app. An executable-sourced tray icon would
   * otherwise be the Electron launcher's own icon in an unpackaged run.
   */
  readonly unpackagedIconPath: string | null
  readonly getFileIcon: (
    path: string,
    options: { readonly size: 'small' },
  ) => Promise<Icon>
  /** Turns a profile-relative asset path into an absolute one on disk. */
  readonly resolveResourcePath: (relativePath: string) => string
  readonly loadImageIcon: (path: string) => Icon
  readonly markTemplate: (icon: Icon) => void
  readonly createTray: (icon: Icon) => TrayResource
  readonly configure: (tray: TrayResource) => void
}

export class NativeTrayCreationError extends Error {
  readonly code = 'NATIVE_TRAY_CREATION_FAILED'

  constructor() {
    super('Native tray creation failed')
    this.name = 'NativeTrayCreationError'
  }
}

async function loadTrayIcon<
  Icon extends TrayIconLike,
  TrayResource extends DestroyableTray,
>(options: CreateTrayResourceOptions<Icon, TrayResource>): Promise<Icon> {
  if (options.source.kind === 'executable') {
    if (options.unpackagedIconPath !== null) {
      // Same emptiness contract as the template branch: a missing file yields an
      // empty image, which the shared check turns into the finite failure.
      return options.loadImageIcon(options.unpackagedIconPath)
    }
    return await options.getFileIcon(options.executablePath, { size: 'small' })
  }
  // A missing template asset yields an empty image rather than throwing, which
  // the shared emptiness check below turns into the finite creation failure.
  return options.loadImageIcon(
    options.resolveResourcePath(options.source.relativePath),
  )
}

export async function createTrayResource<
  Icon extends TrayIconLike,
  TrayResource extends DestroyableTray,
>(
  options: CreateTrayResourceOptions<Icon, TrayResource>,
): Promise<TrayResource> {
  let tray: TrayResource | null = null
  try {
    const icon = await loadTrayIcon(options)
    if (icon.isEmpty()) {
      throw new NativeTrayCreationError()
    }
    if (options.source.kind === 'template') {
      options.markTemplate(icon)
    }
    tray = options.createTray(icon)
    options.configure(tray)
    return tray
  } catch {
    if (tray !== null) {
      try {
        tray.destroy()
      } catch {
        // Construction still fails with a finite error when native cleanup is unavailable.
      }
    }
    throw new NativeTrayCreationError()
  }
}
