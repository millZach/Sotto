import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isAsarDirectory,
  listAsarEntries,
  readAsarFile,
  readAsarText,
} from '../../../scripts/asar-entries.mjs'
import {
  verifyBuildProvenance,
  writeBuildProvenance,
} from '../../../scripts/release-provenance.mjs'

const packagingHost = vi.hoisted(() => ({ foreignSeparators: false }))

vi.mock('@electron/asar', async () => {
  const actual = await vi.importActual<typeof import('@electron/asar')>('@electron/asar')
  const { sep } = await import('node:path')
  const foreignSeparator = sep === '\\' ? '/' : '\\'
  return {
    ...actual,
    listPackage: (
      archivePath: string,
      options: Parameters<typeof actual.listPackage>[1],
    ): string[] =>
      actual.listPackage(archivePath, options).map((entry) =>
        packagingHost.foreignSeparators ? entry.split(sep).join(foreignSeparator) : entry,
      ),
  }
})

const temporaryRoots: string[] = []

async function packagedOut(rendererText: string): Promise<{ outRoot: string, asarPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-asar-entries-'))
  temporaryRoots.push(root)
  const outRoot = join(root, 'out')
  await Promise.all([
    mkdir(join(outRoot, 'main'), { recursive: true }),
    mkdir(join(outRoot, 'renderer', 'assets'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(outRoot, 'main', 'index.js'), 'main'),
    writeFile(join(outRoot, 'renderer', 'index.html'), rendererText),
    writeFile(join(outRoot, 'renderer', 'assets', 'main-abc123.js'), 'renderer'),
  ])
  await writeBuildProvenance({
    outRoot,
    sourceCommit: 'abc123',
    buildInputsRevision: '1'.repeat(64),
  })
  const packageRoot = join(root, 'package')
  await mkdir(packageRoot)
  await cp(outRoot, join(packageRoot, 'out'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), '{}')
  const asarPath = join(root, 'app.asar')
  await createPackage(packageRoot, asarPath)
  return { outRoot, asarPath }
}

afterEach(async () => {
  packagingHost.foreignSeparators = false
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('asar entry normalization', () => {
  it('lists relative POSIX entries whatever separator the packaging host used', async () => {
    const { asarPath } = await packagedOut('renderer')

    const entries = listAsarEntries(asarPath)

    expect(entries).toContain('out/main/index.js')
    expect(entries).toContain('out/renderer/assets/main-abc123.js')
    expect(entries).toContain('package.json')
    for (const entry of entries) {
      expect(entry).not.toMatch(/^[/\\]/u)
      expect(entry).not.toContain('\\')
    }
  })

  it('reads and classifies entries addressed by their POSIX path', async () => {
    const { asarPath } = await packagedOut('renderer')

    expect(readAsarText(asarPath, 'out/main/index.js')).toBe('main')
    expect(readAsarFile(asarPath, 'out/renderer/index.html')).toEqual(Buffer.from('renderer'))
    expect(isAsarDirectory(asarPath, 'out/renderer')).toBe(true)
    expect(isAsarDirectory(asarPath, 'out/renderer/index.html')).toBe(false)
  })

  it('verifies provenance against an archive listed with the other host separator', async () => {
    const { outRoot, asarPath } = await packagedOut('renderer')
    packagingHost.foreignSeparators = true

    expect(listAsarEntries(asarPath)).toContain('out/main/index.js')
    await expect(verifyBuildProvenance({
      outRoot,
      asarPath,
      buildInputsRevision: '1'.repeat(64),
    })).resolves.toMatchObject({ sourceCommit: 'abc123' })
  })
})
