import { execFileSync } from 'node:child_process'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { smokeHostArchive } from './smoke-host-archive.mjs'
import { buildHost } from './build-host.mjs'
import { inventoryFiles, sha256, verifyHostArchive } from './verify-host-archive.mjs'
import { verifyHostExternalDependencies } from './release-external-dependencies.mjs'
import { verifyThirdPartyNotices } from './verify-notices.mjs'

export async function packageHost() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Build and verify the host archive with Node 24')
  const root = resolve(import.meta.dirname, '..')
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (JSON.stringify(Object.keys(pkg.dependencies).sort()) !== '["node-pty","zod"]') throw new Error('Production dependency policy changed')
  await buildHost(join(root, 'out/host'))
  const dependencies = { zod: pkg.dependencies.zod }
  verifyHostExternalDependencies(JSON.parse(await readFile(join(root, 'out/host/external-dependencies.json'), 'utf8')), dependencies)
  await verifyThirdPartyNotices()
  const temporary = await mkdtemp(join(tmpdir(), 'sotto-host-package-'))
  try {
    const stage = join(temporary, 'stage'), unpacked = join(temporary, 'unpacked')
    await mkdir(stage); await mkdir(unpacked)
    await cp(join(root, 'out/host'), join(stage, 'host'), { recursive: true })
    await cp(join(root, 'node_modules/zod'), join(stage, 'node_modules/zod'), { recursive: true, dereference: false })
    for (const name of ['LICENSE.md', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, name), join(stage, name))
    const writeJson = (file, value) => writeFile(join(stage, file), JSON.stringify(value, null, 2) + '\n')
    await writeJson('package.json', { name: 'sotto-host', private: true, version: pkg.version, type: 'commonjs', main: 'host/index.js', engines: { node: '>=24 <25' }, dependencies })
    await writeJson('runtime-manifest.json', { version: 1, kind: 'sotto-host', sottoVersion: pkg.version, node: '>=24 <25', platform: process.platform, arch: process.arch, dependencies, bundledNode: false, nativeModules: [] })
    const inputs = []
    for (const dir of ['src', 'scripts']) for (const entry of await inventoryFiles(join(root, dir))) inputs.push({ ...entry, path: dir + '/' + entry.path })
    for (const file of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE.md']) {
      const bytes = await readFile(join(root, file)); inputs.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) })
    }
    const artifacts = await inventoryFiles(stage)
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    await writeJson('build-provenance.json', { version: 1, sourceCommit: git(['rev-parse', 'HEAD']), sourceDirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '', buildInputsRevision: sha256(JSON.stringify(inputs.sort((a, b) => a.path.localeCompare(b.path, 'en')))), builtAt: new Date().toISOString(), builder: { node: process.versions.node, platform: process.platform, arch: process.arch }, artifacts, buildSha256: sha256(JSON.stringify(artifacts)) })
    await verifyHostArchive(stage)
    const release = join(root, 'release'); await mkdir(release, { recursive: true })
    const name = `Sotto-host-${pkg.version}-${process.platform}-${process.arch}.tar.gz`
    const archive = join(release, name)
    execFileSync('tar', ['-czf', archive, '-C', stage, '.'], { windowsHide: true })
    // Verify the archive's bytes after a real round trip, outside the checkout's node_modules.
    execFileSync('tar', ['-xzf', archive, '-C', unpacked], { windowsHide: true })
    await verifyHostArchive(unpacked)
    await smokeHostArchive(unpacked)
    await writeFile(archive + '.sha256', sha256(await readFile(archive)) + '  ' + name + '\n')
    return archive
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.stdout.write(await packageHost() + '\n')
