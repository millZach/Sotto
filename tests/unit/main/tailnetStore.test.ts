// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TAILNET_STORE_FILE, TailnetStore } from '../../../src/main/hosts/tailnetStore'
import { e2eTailnetMap } from '../../../src/main/e2e/tailnetStandIn'

const ID = '7d3f1d2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f'
const ADDRESS = 'https://forge.tail5728ca.ts.net:8443'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-tailnet-store-')) })
afterEach(async () => { if (dirname(root) === tmpdir() && root.includes('sotto-tailnet-store-')) await rm(root, { recursive: true, force: true }) })
const file = async () => JSON.parse(await readFile(join(root, TAILNET_STORE_FILE), 'utf8')) as unknown

describe('TailnetStore (ADR-0053)', () => {
  it('reads a host with no entry as preferring SSH, and writes an entry beside the saved hosts', async () => {
    const store = new TailnetStore(root)
    await store.load()
    expect(store.get(ID)).toEqual({ prefer: 'ssh' })
    await store.set(ID, { prefer: 'tailnet', address: ADDRESS, addressSeen: 1 })
    expect(await file()).toEqual([{ id: ID, prefer: 'tailnet', address: ADDRESS, addressSeen: 1 }])
    await store.delete(ID)
    expect(await file()).toEqual([])
  })

  it('reads an address or start at boot state it cannot accept as none, and keeps a later Sotto’s fields as they are', async () => {
    await writeFile(join(root, TAILNET_STORE_FILE), JSON.stringify([{ id: ID, prefer: 'tailnet', address: 'http://forge.example.com', bootStart: { enabled: true }, later: { kept: true } }]))
    const store = new TailnetStore(root)
    await store.load()
    expect(store.get(ID)).toMatchObject({ prefer: 'tailnet' })
    expect(store.get(ID).address).toBeUndefined()
    expect(store.get(ID).bootStart).toBeUndefined()
    await store.set(ID, { prefer: 'ssh' })
    expect(await file()).toEqual([{ id: ID, prefer: 'ssh', later: { kept: true } }])
  })

  it('keeps the start at boot state a launch reported (ADR-0054)', async () => {
    const bootStart = { supported: true, installed: true, enabled: true, active: true, linger: true, nodeDrift: false }
    const store = new TailnetStore(root)
    await store.load()
    await store.set(ID, { bootStart })
    const again = new TailnetStore(root)
    await again.load()
    expect(again.get(ID)).toEqual({ id: ID, prefer: 'ssh', bootStart })
  })
})

describe('e2eTailnetMap', () => {
  it('maps a MagicDNS name to a loopback port and leaves every other address alone', () => {
    const resolve = e2eTailnetMap('forge.tail5728ca.ts.net=127.0.0.1:4555')!
    expect(resolve(ADDRESS)).toBe('http://127.0.0.1:4555')
    expect(resolve('https://other.tail5728ca.ts.net:8443')).toBe('https://other.tail5728ca.ts.net:8443')
    expect(e2eTailnetMap(undefined)).toBeUndefined()
  })
  it('maps only to this computer', () => {
    expect(() => e2eTailnetMap('forge.tail5728ca.ts.net=192.0.2.1:4555')).toThrow('loopback port only')
    expect(() => e2eTailnetMap('forge.example.com=127.0.0.1:4555')).toThrow('loopback port only')
  })
})
