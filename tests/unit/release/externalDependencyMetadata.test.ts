import { builtinModules } from 'node:module'

import { describe, expect, it } from 'vitest'

import { verifyExternalDependencyInventories } from '../../../scripts/release-external-dependencies.mjs'

const mainImports = [
  'electron',
  'node:child_process',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
  'node:https',
  'node:path',
  'node:stream',
  'node:stream/promises',
  'node:url',
  'zod',
]

const exactInventories = {
  main: { version: 1, scope: 'main', imports: mainImports, dynamicImports: [] },
  preload: { version: 1, scope: 'preload', imports: ['electron'], dynamicImports: [] },
} as const

describe('packaged external dependency metadata', () => {
  it('accepts the exact Rollup inventories when every package dependency exists', () => {
    expect(() => verifyExternalDependencyInventories(exactInventories, ['zod'], builtinModules))
      .not.toThrow()
  })

  it('rejects an unexpected static external without inspecting generated require spelling', () => {
    const inventories = {
      ...exactInventories,
      main: { ...exactInventories.main, imports: [...mainImports, 'single-quoted-package'] },
    }

    expect(() => verifyExternalDependencyInventories(inventories, ['zod'], builtinModules))
      .toThrow('main external dependency metadata differs from the reviewed allowlist')
  })

  it('rejects an unexpected dynamic external from Rollup metadata', () => {
    const inventories = {
      ...exactInventories,
      preload: { ...exactInventories.preload, dynamicImports: ['dynamic-package'] },
    }

    expect(() => verifyExternalDependencyInventories(inventories, ['zod'], builtinModules))
      .toThrow('preload external dependency metadata differs from the reviewed allowlist')
  })

  it('rejects a declared package external when its packaged module is absent', () => {
    expect(() => verifyExternalDependencyInventories(exactInventories, [], builtinModules))
      .toThrow('external package is missing from app.asar: zod')
  })
})
