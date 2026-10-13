// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packageHost } from '../../../scripts/package-host.mjs'
import { packageStableHost } from '../../../scripts/package-stable-host.mjs'
import { verifyHostArchive, sha256 } from '../../../scripts/verify-host-archive.mjs'
import { cleanStableCheckout as clean, stableReleaseRecord as promotion } from '../../fixtures/stableReleaseFixture.mjs'
import { rawPeer } from '../../fixtures/rawHostPeer'

const root = resolve(import.meta.dirname, '../../..')
const roots = []
afterEach(async () => { await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('stable host from main', () => {
  it('packages the checked stable version and verifies the checkout before and after, without a feed', async () => {
    const readPromotion = vi.fn(async () => promotion), checkout = vi.fn(() => clean), packageArchive = vi.fn(async () => 'promoted.tar.gz')
    expect(await packageStableHost({ readPromotion, checkout, packageArchive })).toEqual({ archive: 'promoted.tar.gz', promotion })
    expect(readPromotion).toHaveBeenCalledTimes(1)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(packageArchive).toHaveBeenCalledExactlyOnceWith({ version: '0.1.38' })
    expect(checkout.mock.invocationCallOrder[0]).toBeLessThan(packageArchive.mock.invocationCallOrder[0])
    expect(checkout.mock.invocationCallOrder[1]).toBeGreaterThan(packageArchive.mock.invocationCallOrder[0])
  })

  it.each([
    { checkout: { ...clean, sourceCommit: 'b'.repeat(40) }, reason: 'does not match' },
    { checkout: { ...clean, clean: false }, reason: 'uncommitted changes' },
  ])('refuses a different or dirty checkout before building', async ({ checkout, reason }) => {
    const packageArchive = vi.fn()
    await expect(packageStableHost({ readPromotion: async () => promotion, checkout: () => checkout, packageArchive })).rejects.toThrow(reason)
    expect(packageArchive).not.toHaveBeenCalled()
  })

  it('refuses a saved version that disagrees with its source patch', async () => {
    const packageArchive = vi.fn()
    await expect(packageStableHost({ readPromotion: async () => ({ ...promotion, stableVersion: '0.1.99' }), checkout: () => clean, packageArchive })).rejects.toThrow('does not match')
    expect(packageArchive).not.toHaveBeenCalled()
  })

  it('refuses checkout changes during packaging', async () => {
    const checkout = vi.fn().mockReturnValueOnce(clean).mockReturnValueOnce({ ...clean, clean: false })
    await expect(packageStableHost({ readPromotion: async () => promotion, checkout, packageArchive: async () => 'promoted.tar.gz' })).rejects.toThrow('uncommitted changes')
  })

  it('keeps the offline command and adds the checked release command', async () => {
    const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    expect(scripts['package:host']).toBe('node scripts/package-host.mjs')
    expect(scripts['package:host:release']).toBe('node scripts/package-stable-host.mjs')
  })

  it('makes real default and overridden archives with matching bundled listener versions, without changing source versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sotto-promoted-host-')); roots.push(directory)
    const manifestBytes = await readFile(join(root, 'package.json')), lockBytes = await readFile(join(root, 'package-lock.json'))
    const sourceVersion = JSON.parse(manifestBytes.toString('utf8')).version
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
    for (const version of [undefined, '0.1.38']) {
      const expectedVersion = version ?? sourceVersion
      const buildDirectory = join(directory, version ? 'promoted' : 'default')
      const releaseDir = join(buildDirectory, 'release'), unpacked = join(buildDirectory, 'unpacked'), data = join(buildDirectory, 'data')
      const archive = await packageHost({ outDir: join(buildDirectory, 'host'), releaseDir, ...(version ? { version } : {}) })
      const name = `Sotto-host-${expectedVersion}-${process.platform}-${process.arch}.tar.gz`
      expect(basename(archive)).toBe(name)
      expect(await readFile(archive + '.sha256', 'utf8')).toBe(sha256(await readFile(archive)) + '  ' + name + '\n')
      await mkdir(unpacked); await mkdir(data)
      execFileSync('tar', ['-xzf', name, '-C', unpacked], { cwd: releaseDir, windowsHide: true })
      const verified = await verifyHostArchive(unpacked)
      expect(verified.manifest.sottoVersion).toBe(expectedVersion)
      expect(verified.provenance.sourceCommit).toBe(head)
      expect(JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8')).version).toBe(expectedVersion)
      await writeFile(join(data, 'agents.json'), JSON.stringify({
        configuration: { disconnectedProviders: ['codex', 'claude', 'grok', 'devin'] }, assignments: [], queue: [], activeThreadId: null,
        activeProjectId: null, draft: '', draftThreadId: null, composing: false, outbox: [],
      }))
      const { startHeadlessHost } = createRequire(import.meta.url)(join(unpacked, 'host/index.js'))
      const host = await startHeadlessHost({ dataDirectory: data, port: 0 })
      let peer
      try {
        expect(host.descriptor.sottoVersion).toBe(expectedVersion)
        const response = await globalThis.fetch('http://127.0.0.1:' + host.descriptor.port + '/v1/health')
        expect(response.ok).toBe(true)
        expect((await response.json()).sottoVersion).toBe(expectedVersion)
        const paired = await host.pairing.redeem(host.pairing.issuePairingCode().code, 'Archive smoke')
        peer = await rawPeer(host.descriptor.port, host.pairing.signSession(paired.clientId))
        const hello = await peer.call('archive-hello', { op: 'hello' })
        expect(hello.ok).toBe(true)
        expect(hello.result.sottoVersion).toBe(expectedVersion)
      } finally { peer?.frames.close(); await host.close() }
    }
    expect(await readFile(join(root, 'package.json'))).toEqual(manifestBytes)
    expect(await readFile(join(root, 'package-lock.json'))).toEqual(lockBytes)
  }, 90_000)
})
