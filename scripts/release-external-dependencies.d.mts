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
