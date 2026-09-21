import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { verifyHostExternalDependencies } from './release-external-dependencies.mjs'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
export async function inventoryFiles(root, directory = root) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await inventoryFiles(root, path))
    else if (entry.isFile()) {
      const bytes = await readFile(path)
      result.push({ path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes) })
    } else throw new Error('Host archives may contain only regular files and directories')
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export async function verifyHostArchive(directory) {
  const root = resolve(directory)
  const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
  const manifest = await json('runtime-manifest.json'), pkg = await json('package.json')
  if (manifest.version !== 1 || manifest.kind !== 'sotto-host' || manifest.node !== '>=24 <25' ||
      pkg.engines?.node !== manifest.node || pkg.main !== 'host/index.js' || pkg.type !== 'commonjs' || pkg.version !== manifest.sottoVersion) {
    throw new Error('Invalid host runtime manifest')
  }
  verifyHostExternalDependencies(await json('host/external-dependencies.json'), pkg.dependencies)
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(pkg.dependencies)) throw new Error('Host dependencies differ from runtime manifest')
  const bundled = await json('host/bundled-dependencies.json')
  if (bundled.version !== 1 || JSON.stringify(bundled.packages) !== '[]') throw new Error('Unexpected bundled host dependency')
  const modules = await readdir(join(root, 'node_modules'))
  if (JSON.stringify(modules.sort()) !== '["zod"]') throw new Error('Unexpected host runtime package')
  const dependency = await json('node_modules/zod/package.json')
  if (dependency.version !== pkg.dependencies.zod || Object.keys(dependency.dependencies ?? {}).length || Object.keys(dependency.optionalDependencies ?? {}).length) throw new Error('Host dependency closure changed')
  const provenance = await json('build-provenance.json')
  const artifacts = (await inventoryFiles(root)).filter(file => file.path !== 'build-provenance.json')
  if (provenance.version !== 1 || !/^[a-f0-9]{40}$/u.test(provenance.sourceCommit) ||
      !/^[a-f0-9]{64}$/u.test(provenance.buildInputsRevision) ||
      JSON.stringify(provenance.artifacts) !== JSON.stringify(artifacts) || provenance.buildSha256 !== sha256(JSON.stringify(artifacts))) {
    throw new Error('Host archive provenance or artifact hashes do not match')
  }
  if (artifacts.some(file => /\.(?:node|dll|exe|so|dylib)$/iu.test(file.path))) throw new Error('Unreviewed native binary in host archive')
  for (const path of ['LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'node_modules/zod/LICENSE']) {
    if (!(await readFile(join(root, path), 'utf8')).trim()) throw new Error('Host archive is missing license text')
  }
  return { root, manifest, provenance }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass the extracted host archive directory')
  const result = await verifyHostArchive(process.argv[2])
  process.stdout.write(`Verified Sotto host ${result.manifest.sottoVersion} (${result.provenance.artifacts.length} files).\n`)
}
