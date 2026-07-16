import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPackage } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'

import {
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
  it('rejects an internally valid stale package that differs from the just-built output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-provenance-'))
    temporaryRoots.push(root)
    const currentOut = await createOut(join(root, 'current'), 'fresh renderer')
    const staleOut = await createOut(join(root, 'stale'), 'stale renderer')
    await writeBuildProvenance({ outRoot: currentOut, sourceCommit: 'abc123' })
    await writeBuildProvenance({ outRoot: staleOut, sourceCommit: 'abc123' })
    const staleAsar = await packageOut(root, staleOut)

    await expect(verifyBuildProvenance({
      outRoot: currentOut,
      asarPath: staleAsar,
      sourceCommit: 'abc123',
    })).rejects.toThrow('packaged build artifacts differ from just-built out')
  })

  it('accepts an exact package and binds its build hash to the source commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-provenance-'))
    temporaryRoots.push(root)
    const out = await createOut(root, 'current renderer')
    const written = await writeBuildProvenance({ outRoot: out, sourceCommit: 'def456' })
    const asarPath = await packageOut(root, out)

    await expect(verifyBuildProvenance({
      outRoot: out,
      asarPath,
      sourceCommit: 'def456',
    })).resolves.toEqual(written)
    expect(written.buildSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects provenance recorded for a different source commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'talktype-provenance-'))
    temporaryRoots.push(root)
    const out = await createOut(root, 'current renderer')
    await writeBuildProvenance({ outRoot: out, sourceCommit: 'old-commit' })
    const asarPath = await packageOut(root, out)

    await expect(verifyBuildProvenance({
      outRoot: out,
      asarPath,
      sourceCommit: 'current-commit',
    })).rejects.toThrow('packaged build provenance does not match the current source and output')
  })
})
