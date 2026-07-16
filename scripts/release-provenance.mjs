import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { extractFile, listPackage, statFile } from '@electron/asar'

export const BUILD_PROVENANCE_FILE = 'build-provenance.json'

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
  return listPackage(asarPath)
    .filter((entry) => entry.startsWith('\\out\\') && entry !== `\\out\\${BUILD_PROVENANCE_FILE}`)
    .filter((entry) => !('files' in statFile(asarPath, entry.slice(1), false)))
    .map((entry) => entry.slice('\\out\\'.length).replaceAll('\\', '/'))
    .sort()
    .map((path) => {
      const value = extractFile(asarPath, `out${sep}${path.replaceAll('/', sep)}`)
      return { path, bytes: value.byteLength, sha256: sha256(value) }
    })
}

function buildSha256(artifacts) {
  return sha256(JSON.stringify(artifacts))
}

export async function writeBuildProvenance({ outRoot, sourceCommit }) {
  const artifacts = await localArtifacts(outRoot)
  const provenance = {
    version: 1,
    sourceCommit,
    buildSha256: buildSha256(artifacts),
    artifacts,
  }
  await writeFile(
    resolve(outRoot, BUILD_PROVENANCE_FILE),
    `${JSON.stringify(provenance, null, 2)}\n`,
  )
  return provenance
}

export async function verifyBuildProvenance({ outRoot, asarPath, sourceCommit }) {
  const local = await localArtifacts(outRoot)
  const packaged = packagedArtifacts(asarPath)
  if (JSON.stringify(packaged) !== JSON.stringify(local)) {
    throw new Error('packaged build artifacts differ from just-built out')
  }

  const packagedProvenance = JSON.parse(
    extractFile(asarPath, `out${sep}${BUILD_PROVENANCE_FILE}`).toString('utf8'),
  )
  const expected = {
    version: 1,
    sourceCommit,
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
