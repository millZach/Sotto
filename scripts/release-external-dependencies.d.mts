export interface ExternalDependencyInventory {
  readonly version: 1
  readonly scope: 'main' | 'preload'
  readonly imports: readonly string[]
  readonly dynamicImports: readonly string[]
}

export function verifyExternalDependencyInventories(
  inventories: Readonly<{
    main: ExternalDependencyInventory
    preload: ExternalDependencyInventory
  }>,
  packagedModuleRoots: readonly string[],
  availableBuiltinModules?: readonly string[],
): void

export const HOST_EXTERNAL_IMPORTS: readonly string[]
export function verifyHostExternalDependencies(
  inventory: unknown,
  packagedDependencies: Readonly<Record<string, string>>,
  availableBuiltinModules?: readonly string[],
): void
