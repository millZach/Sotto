import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { isAsarDirectory, listAsarEntries, readAsarFile, readAsarText } from './asar-entries.mjs'

export const BUILD_PROVENANCE_FILE = 'build-provenance.json'

const BUILD_INPUT_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.yml',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'build',
  'src',
  'resources/models',
  'resources/runtime',
  'scripts/asar-entries.mjs',
  'scripts/model-catalog.mjs',
  'scripts/release-external-dependencies.mjs',
  'scripts/release-platform-profile.mjs',
  'scripts/release-provenance.mjs',
  'scripts/verify-model.mjs',
  'scripts/verify-notices.mjs',
  'scripts/verify-packaged-resources.mjs',
  'scripts/write-build-provenance.mjs',
])

export function readSourceCommit(repositoryRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function readBuildInputsRevision(repositoryRoot) {
  const paths = []
  for (const input of BUILD_INPUT_PATHS) {
    const target = resolve(repositoryRoot, input)
    const info = await stat(target).catch((error) => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (info?.isFile()) paths.push(input)
    else if (info?.isDirectory()) paths.push(...await walkFiles(repositoryRoot, target))
  }
  const inputs = await Promise.all([...new Set(paths)].sort().map(async (path) => {
    const value = await readFile(resolve(repositoryRoot, path))
    return { path, bytes: value.byteLength, sha256: sha256(value) }
  }))
  return sha256(JSON.stringify(inputs))
}

async function walkFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(root, path))
    else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'))
  }
  return files.sort()
}

async function localArtifacts(outRoot) {
  const files = (await walkFiles(outRoot)).filter((path) => path !== BUILD_PROVENANCE_FILE)
  return Promise.all(files.map(async (path) => {
    const value = await readFile(resolve(outRoot, path))
    return { path, bytes: value.byteLength, sha256: sha256(value) }
  }))
}

function packagedArtifacts(asarPath) {
  return listAsarEntries(asarPath)
    .filter((entry) => entry.startsWith('out/') && entry !== `out/${BUILD_PROVENANCE_FILE}`)
    .filter((entry) => !isAsarDirectory(asarPath, entry))
    .map((entry) => entry.slice('out/'.length))
    .sort()
    .map((path) => {
      const value = readAsarFile(asarPath, `out/${path}`)
      return { path, bytes: value.byteLength, sha256: sha256(value) }
    })
}

function buildSha256(artifacts) {
  return sha256(JSON.stringify(artifacts))
}

async function resolveBuildInputsRevision({ repositoryRoot, buildInputsRevision }) {
  const revision = buildInputsRevision ?? (
    repositoryRoot === undefined ? undefined : await readBuildInputsRevision(repositoryRoot)
  )
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)) {
    throw new Error('build-input revision must be a SHA-256 digest')
  }
  return revision
}

export async function writeBuildProvenance({ outRoot, sourceCommit, repositoryRoot, buildInputsRevision }) {
  if (typeof sourceCommit !== 'string' || sourceCommit.length === 0) {
    throw new Error('source commit must be recorded for release provenance')
  }
  const artifacts = await localArtifacts(outRoot)
  const resolvedBuildInputsRevision = await resolveBuildInputsRevision({
    repositoryRoot,
    buildInputsRevision,
  })
  const provenance = {
    version: 2,
    sourceCommit,
    buildInputsRevision: resolvedBuildInputsRevision,
    buildSha256: buildSha256(artifacts),
    artifacts,
  }
  await writeFile(
    resolve(outRoot, BUILD_PROVENANCE_FILE),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
  return provenance
}

export async function verifyBuildProvenance({ outRoot, asarPath, repositoryRoot, buildInputsRevision }) {
  const local = await localArtifacts(outRoot)
  const packaged = packagedArtifacts(asarPath)
  if (JSON.stringify(packaged) !== JSON.stringify(local)) {
    throw new Error('packaged build artifacts differ from just-built out')
  }

  const packagedProvenance = JSON.parse(readAsarText(asarPath, `out/${BUILD_PROVENANCE_FILE}`))
  if (typeof packagedProvenance?.sourceCommit !== 'string' || packagedProvenance.sourceCommit.length === 0) {
    throw new Error('packaged build provenance does not match the current source and output')
  }
  const resolvedBuildInputsRevision = await resolveBuildInputsRevision({
    repositoryRoot,
    buildInputsRevision,
  })
  const expected = {
    version: 2,
    sourceCommit: packagedProvenance.sourceCommit,
    buildInputsRevision: resolvedBuildInputsRevision,
    buildSha256: buildSha256(local),
    artifacts: local,
  }
  if (JSON.stringify(packagedProvenance) !== JSON.stringify(expected)) {
    throw new Error('packaged build provenance does not match the current source and output')
  }
  return expected
}

export async function fileSha256(path) {
  const info = await stat(path)
  return { bytes: info.size, sha256: sha256(await readFile(path)) }
}
