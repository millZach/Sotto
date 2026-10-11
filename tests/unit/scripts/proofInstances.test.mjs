// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { assertProofInstancesPreserved, snapshotProofInstances } from '../../../scripts/owned-proof-processes.mjs'

const fixture = vi.hoisted(() => ({ inode: 9007199254740992n }))
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal(),
  readdirSync: () => ['live'],
  statSync: (_path, options) => options?.bigint
    ? { dev: 1n, ino: fixture.inode }
    : { dev: 1, ino: Number(fixture.inode) },
}))
afterEach(() => { fixture.inode = 9007199254740992n })

it('rejects a replacement whose file ID rounds to the same JavaScript number', () => {
  const before = snapshotProofInstances('instances')
  expect(assertProofInstancesPreserved('instances', before)).toEqual(['live'])
  const original = fixture.inode
  fixture.inode++
  expect(Number(fixture.inode)).toBe(Number(original))
  expect(() => assertProofInstancesPreserved('instances', before)).toThrow('Preserve the existing')
})
