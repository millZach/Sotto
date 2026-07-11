import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'

import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'

const roots: string[] = []

const exampleSchema = z.object({ value: z.string() })
type Example = z.infer<typeof exampleSchema>

function createStore(filePath: string, now: () => number = Date.now): AtomicJsonStore<Example> {
  return new AtomicJsonStore(
    filePath,
    (input) => exampleSchema.parse(input),
    () => ({ value: 'default' }),
    now,
  )
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'talktype-atomic-store-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('AtomicJsonStore', () => {
  it('returns a fresh default for a missing file without creating it', async () => {
    const filePath = join(await createRoot(), 'nested', 'store.json')
    let defaultNumber = 0
    const store = new AtomicJsonStore(
      filePath,
      (input) => exampleSchema.parse(input),
      () => ({ value: `default-${++defaultNumber}` }),
    )

    const first = await store.read()
    const second = await store.read()

    expect(first).toEqual({ value: 'default-1' })
    expect(second).toEqual({ value: 'default-2' })
    expect(first).not.toBe(second)
    expect(await store.exists()).toBe(false)
  })

  it('reads UTF-8 JSON through the supplied parser', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    await writeFile(filePath, '{"value":"persisted"}\n', 'utf8')

    await expect(createStore(filePath).read()).resolves.toEqual({ value: 'persisted' })
  })

  it('backs up syntax-corrupt input with its exact bytes and returns a default', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65])
    await writeFile(filePath, corruptBytes)
    const store = createStore(filePath, () => 1_725_000_000_001)

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(`${filePath}.corrupt-1725000000001`)).toEqual(corruptBytes)
    expect(await store.exists()).toBe(false)
  })

  it('backs up semantically invalid JSON and preserves its exact formatting', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{\r\n  "value": 42\r\n}\r\n', 'utf8')
    await writeFile(filePath, corruptBytes)
    const store = createStore(filePath, () => 1_725_000_000_002)

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(`${filePath}.corrupt-1725000000002`)).toEqual(corruptBytes)
    expect(await store.exists()).toBe(false)
  })

  it('creates parent directories and writes indented JSON with a trailing newline', async () => {
    const root = await createRoot()
    const filePath = join(root, 'deeply', 'nested', 'store.json')
    const store = createStore(filePath)

    await store.write({ value: 'saved' })

    expect(await readFile(filePath, 'utf8')).toBe('{\n  "value": "saved"\n}\n')
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    }
  })

  it('atomically replaces an existing document without leaving a temporary sibling', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const store = createStore(filePath)
    await store.write({ value: 'old' })

    await store.write({ value: 'new' })

    expect(await readFile(filePath, 'utf8')).toBe('{\n  "value": "new"\n}\n')
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('serializes concurrent writes so the last invoked write wins', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const store = createStore(filePath)
    const writes = Array.from({ length: 12 }, (_, index) =>
      store.write({ value: `${index}-${'x'.repeat((12 - index) * 64_000)}` }),
    )

    await Promise.all(writes)

    expect((await store.read()).value).toBe(`11-${'x'.repeat(64_000)}`)
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('cleans its temporary sibling when replacement fails', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    await mkdir(filePath)
    const store = createStore(filePath)

    await expect(store.write({ value: 'cannot-replace-directory' })).rejects.toBeDefined()

    expect(await readdir(root)).toEqual(['store.json'])
    expect((await stat(filePath)).isDirectory()).toBe(true)
  })

  it('reports whether the destination exists', async () => {
    const filePath = join(await createRoot(), 'store.json')
    const store = createStore(filePath)

    expect(await store.exists()).toBe(false)
    await store.write({ value: 'saved' })
    expect(await store.exists()).toBe(true)
  })
})
