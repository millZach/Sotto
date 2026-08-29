import { builtinModules } from 'node:module'

// The unprefixed builtins come from electron-updater and its CommonJS
// dependencies, which are compiled into the main chunk rather than shipped as
// runtime modules. Rollup keeps their `require('http')`-style specifiers
// verbatim, so the reviewed list carries both spellings.
const reviewedInventories = Object.freeze({
  main: Object.freeze({
    version: 1,
    scope: 'main',
    imports: Object.freeze([
      'assert',
      'child_process',
      'constants',
      'crypto',
      'electron',
      'events',
      'fs',
      'http',
      'node:child_process',
      'node:crypto',
      'node:fs',
      'node:fs/promises',
      'node:https',
      'node:path',
      'node:stream',
      'node:stream/promises',
      'node:url',
      'os',
      'path',
      'stream',
      'tty',
      'url',
      'util',
      'zlib',
      'zod',
    ]),
    dynamicImports: Object.freeze([]),
  }),
  preload: Object.freeze({
    version: 1,
    scope: 'preload',
    imports: Object.freeze(['electron']),
    dynamicImports: Object.freeze([]),
  }),
})

function packageRoot(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function assertExactInventory(scope, inventory) {
  const expected = reviewedInventories[scope]
  const validShape = inventory !== null && typeof inventory === 'object' &&
    inventory.version === 1 && inventory.scope === scope &&
    Array.isArray(inventory.imports) && inventory.imports.every((value) => typeof value === 'string') &&
    Array.isArray(inventory.dynamicImports) &&
    inventory.dynamicImports.every((value) => typeof value === 'string')
  if (!validShape || JSON.stringify(inventory.imports) !== JSON.stringify(expected.imports) ||
      JSON.stringify(inventory.dynamicImports) !== JSON.stringify(expected.dynamicImports)) {
    throw new Error(`${scope} external dependency metadata differs from the reviewed allowlist`)
  }
}

export function verifyExternalDependencyInventories(
  inventories,
  packagedModuleRoots,
  availableBuiltinModules = builtinModules,
) {
  assertExactInventory('main', inventories?.main)
  assertExactInventory('preload', inventories?.preload)

  const packaged = new Set(packagedModuleRoots)
  const builtins = new Set(availableBuiltinModules)
  const externals = new Set([
    ...inventories.main.imports,
    ...inventories.main.dynamicImports,
    ...inventories.preload.imports,
    ...inventories.preload.dynamicImports,
  ])
  for (const specifier of externals) {
    if (specifier === 'electron') continue
    if (specifier.startsWith('node:')) {
      if (!builtins.has(specifier) && !builtins.has(specifier.slice(5))) {
        throw new Error(`external Node builtin is unavailable: ${specifier}`)
      }
      continue
    }
    // Unprefixed builtins are still builtins; only the reviewed allowlist above
    // decides which of them the bundle is allowed to reach for.
    if (builtins.has(specifier)) continue
    const root = packageRoot(specifier)
    if (!packaged.has(root)) {
      throw new Error(`external package is missing from app.asar: ${root}`)
    }
  }
}
