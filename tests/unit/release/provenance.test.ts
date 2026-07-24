import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'

import {
  readBuildInputsRevision,
  verifyBuildProvenance,
  writeBuildProvenance,
} from '../../../scripts/release-provenance.mjs'

const temporaryRoots: string[] = []

async function createOut(root: string, rendererText: string): Promise<string> {
  const out = join(root, 'out')
  await Promise.all([
    mkdir(join(out, 'main'), { recursive: true }),
    mkdir(join(out, 'preload'), { recursive: true }),
    mkdir(join(out, 'renderer'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(out, 'main', 'index.js'), 'main'),
    writeFile(join(out, 'preload', 'index.js'), 'preload'),
    writeFile(join(out, 'renderer', 'index.html'), rendererText),
  ])
  return out
}

async function packageOut(root: string, out: string): Promise<string> {
  const packageRoot = join(root, 'package')
  await mkdir(packageRoot)
  await cp(out, join(packageRoot, 'out'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), '{}')
  const asarPath = join(root, 'app.asar')
  await createPackage(packageRoot, asarPath)
  return asarPath
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release build provenance', () => {
  it('keeps the build-input revision stable across docs, tests, and release-output changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-provenance-'))
    temporaryRoots.push(root)
    await Promise.all([
      mkdir(join(root, 'src'), { recursive: true }),
      mkdir(join(root, 'docs', 'qa'), { recursive: true }),
      mkdir(join(root, 'tests'), { recursive: true }),
      mkdir(join(root, 'release'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(root, 'package.json'), '{"name":"sotto"}\n'),
      writeFile(join(root, 'src', 'index.ts'), 'export const app = true\n'),
      writeFile(join(root, 'docs', 'qa', 'audit.md'), 'before\n'),
      writeFile(join(root, 'tests', 'app.test.ts'), 'before\n'),
      writeFile(join(root, 'release', 'Sotto.exe'), 'before\n'),
    ])
    const before = await readBuildInputsRevision(root)

    await Promise.all([
      writeFile(join(root, 'docs', 'qa', 'audit.md'), 'after\n'),
      writeFile(join(root, 'tests', 'app.test.ts'), 'after\n'),
      writeFile(join(root, 'release', 'Sotto.exe'), 'after\n'),
    ])

    await expect(readBuildInputsRevision(root)).resolves.toBe(before)
  })

  it('rejects an internally valid stale package that differs from the just-built output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-provenance-'))
    temporaryRoots.push(root)
    const currentOut = await createOut(join(root, 'current'), 'fresh renderer')
    const staleOut = await createOut(join(root, 'stale'), 'stale renderer')
    await writeBuildProvenance({ outRoot: currentOut, sourceCommit: 'abc123', buildInputsRevision: '1'.repeat(64) })
    await writeBuildProvenance({ outRoot: staleOut, sourceCommit: 'abc123', buildInputsRevision: '1'.repeat(64) })
    const staleAsar = await packageOut(root, staleOut)

    await expect(verifyBuildProvenance({
      outRoot: currentOut,
      asarPath: staleAsar,
      buildInputsRevision: '1'.repeat(64),
    })).rejects.toThrow('packaged build artifacts differ from just-built out')
  })

  it('accepts an exact package and binds its build hash to the source commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-provenance-'))
    temporaryRoots.push(root)
    const out = await createOut(root, 'current renderer')
    const written = await writeBuildProvenance({ outRoot: out, sourceCommit: 'def456', buildInputsRevision: '1'.repeat(64) })
    const asarPath = await packageOut(root, out)

    await expect(verifyBuildProvenance({
      outRoot: out,
      asarPath,
      buildInputsRevision: '1'.repeat(64),
    })).resolves.toEqual(written)
    expect(written.buildSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('accepts an exact package after a docs-only source revision change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-provenance-'))
    temporaryRoots.push(root)
    const out = await createOut(root, 'current renderer')
    const written = await writeBuildProvenance({
      outRoot: out,
      sourceCommit: 'before-docs-commit',
      buildInputsRevision: '1'.repeat(64),
    })
    const asarPath = await packageOut(root, out)

    await expect(verifyBuildProvenance({
      outRoot: out,
      asarPath,
      buildInputsRevision: '1'.repeat(64),
    })).resolves.toEqual(written)
  })

  it('rejects an exact output package after a release input changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sotto-provenance-'))
    temporaryRoots.push(root)
    const out = await createOut(root, 'current renderer')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'index.ts'), 'export const version = 1\n')
    await writeBuildProvenance({
      outRoot: out,
      repositoryRoot: root,
      sourceCommit: 'same-commit-for-test',
    })
    const asarPath = await packageOut(root, out)

    await writeFile(join(root, 'src', 'index.ts'), 'export const version = 2\n')

    await expect(verifyBuildProvenance({
      outRoot: out,
      asarPath,
      repositoryRoot: root,
    })).rejects.toThrow('packaged build provenance does not match the current source and output')
  })
})
