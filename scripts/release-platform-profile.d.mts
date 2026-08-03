export interface ReleasePlatformProfile {
  readonly key: 'win32' | 'darwin'
  readonly packagedDirName: string
  readonly executableLabel: string
  readonly distributableLabel: string
  readonly applicationRoot: (target: string) => string
  readonly executablePath: (target: string) => string
  readonly resourcesPath: (target: string) => string
  readonly licenseRoot: (target: string) => string
  readonly smokeEnvironment: (profileRoot: string) => Promise<Readonly<Record<string, string>>>
  readonly openDistributable: <T>(
    distributablePath: string,
    open: (asarPath: string) => T | Promise<T>,
  ) => Promise<T>
}

export function releasePlatformProfile(platform?: string, arch?: string): ReleasePlatformProfile
