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
  readonly executablePath: string
  readonly getFileIcon: (
    path: string,
    options: { readonly size: 'small' },
  ) => Promise<Icon>
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

export async function createTrayResource<
  Icon extends TrayIconLike,
  TrayResource extends DestroyableTray,
>(
  options: CreateTrayResourceOptions<Icon, TrayResource>,
): Promise<TrayResource> {
  let tray: TrayResource | null = null
  try {
    const icon = await options.getFileIcon(options.executablePath, { size: 'small' })
    if (icon.isEmpty()) {
      throw new NativeTrayCreationError()
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
