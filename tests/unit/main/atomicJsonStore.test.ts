import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'

import { AtomicJsonStore } from '../../../src/main/storage/atomicJsonStore'

const roots: string[] = []

const exampleSchema = z.object({ value: z.string() })
type Example = z.infer<typeof exampleSchema>

function createStore(
  filePath: string,
  now: () => number = Date.now,
  createId: () => string = () => 'test-id',
): AtomicJsonStore<Example> {
  return new AtomicJsonStore(
    filePath,
    (input) => exampleSchema.parse(input),
    () => ({ value: 'default' }),
    now,
    createId,
  )
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-atomic-store-'))
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

  it('peeks valid UTF-8 JSON without changing the file', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const originalBytes = Buffer.from('{\r\n  "value": "persisted"\r\n}\r\n', 'utf8')
    await writeFile(filePath, originalBytes)

    await expect(createStore(filePath).peek()).resolves.toEqual({ value: 'persisted' })

    expect(await readFile(filePath)).toEqual(originalBytes)
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('returns fresh defaults when peeking a missing file without creating it', async () => {
    const filePath = join(await createRoot(), 'nested', 'store.json')
    let defaultNumber = 0
    const store = new AtomicJsonStore(
      filePath,
      (input) => exampleSchema.parse(input),
      () => ({ value: `default-${++defaultNumber}` }),
    )

    const first = await store.peek()
    const second = await store.peek()

    expect(first).toEqual({ value: 'default-1' })
    expect(second).toEqual({ value: 'default-2' })
    expect(first).not.toBe(second)
    expect(await store.exists()).toBe(false)
  })

  it('peeks syntax-corrupt input without changing its exact bytes or creating siblings', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65])
    await writeFile(filePath, corruptBytes)

    await expect(createStore(filePath).peek()).resolves.toEqual({ value: 'default' })

    expect(await readFile(filePath)).toEqual(corruptBytes)
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('peeks semantically invalid JSON without changing its exact bytes or creating siblings', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{\r\n  "value": 42\r\n}\r\n', 'utf8')
    await writeFile(filePath, corruptBytes)

    await expect(createStore(filePath).peek()).resolves.toEqual({ value: 'default' })

    expect(await readFile(filePath)).toEqual(corruptBytes)
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('backs up syntax-corrupt input with its exact bytes and returns a default', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from([0xff, 0xfe, 0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65])
    await writeFile(filePath, corruptBytes)
    const store = createStore(filePath, () => 1_725_000_000_001)

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(`${filePath}.corrupt-1725000000001-test-id`)).toEqual(corruptBytes)
    expect(await store.exists()).toBe(false)
  })

  it('backs up semantically invalid JSON and preserves its exact formatting', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{\r\n  "value": 42\r\n}\r\n', 'utf8')
    await writeFile(filePath, corruptBytes)
    const store = createStore(filePath, () => 1_725_000_000_002)

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(`${filePath}.corrupt-1725000000002-test-id`)).toEqual(corruptBytes)
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

  it('retries an occupied temporary candidate without deleting its bytes', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const occupiedBytes = Buffer.from('pre-existing temporary bytes', 'utf8')
    const occupiedPath = `${filePath}.tmp-${process.pid}-occupied-temp`
    const freshPath = `${filePath}.tmp-${process.pid}-fresh-temp`
    await writeFile(occupiedPath, occupiedBytes)
    const ids = ['occupied-temp', 'fresh-temp']
    const store = createStore(filePath, Date.now, () => ids.shift() ?? 'unexpected-id')
    let writeSucceeded = true

    await store.write({ value: 'saved' }).catch(() => {
      writeSucceeded = false
    })

    expect.soft(writeSucceeded).toBe(true)
    expect.soft(await readFile(occupiedPath).catch(() => undefined)).toEqual(occupiedBytes)
    expect.soft(await readFile(filePath, 'utf8').catch(() => undefined)).toBe(
      '{\n  "value": "saved"\n}\n',
    )
    expect.soft(await readFile(freshPath).catch(() => undefined)).toBeUndefined()
    expect(await readdir(root)).toEqual([
      'store.json',
      `store.json.tmp-${process.pid}-occupied-temp`,
    ])
  })

  it('rejects after bounded temporary collisions without deleting any existing file', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const activeBytes = Buffer.from('{\n  "value": "original"\n}\n', 'utf8')
    const occupiedIds = Array.from({ length: 100 }, (_, index) => `occupied-${index}`)
    const occupiedFiles = occupiedIds.map((id) => ({
      bytes: Buffer.from(`occupied temporary ${id}`, 'utf8'),
      path: `${filePath}.tmp-${process.pid}-${id}`,
    }))
    await writeFile(filePath, activeBytes)
    await Promise.all(occupiedFiles.map(({ bytes, path }) => writeFile(path, bytes)))
    const remainingIds = [...occupiedIds]
    const store = createStore(
      filePath,
      Date.now,
      () => remainingIds.shift() ?? 'unexpected-extra-attempt',
    )

    const error = await store.write({ value: 'replacement' }).then(
      () => undefined,
      (reason: unknown) => reason,
    )

    expect.soft(error).toEqual(
      new Error('Could not create temporary JSON file after 100 attempts'),
    )
    expect.soft(await readFile(filePath)).toEqual(activeBytes)
    const preservedBytes = await Promise.all(
      occupiedFiles.map(({ path }) => readFile(path).catch(() => undefined)),
    )
    expect(preservedBytes).toEqual(occupiedFiles.map(({ bytes }) => bytes))
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

  it('serializes concurrent recovering reads into one collision-safe backup', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{"value":"unterminated', 'utf8')
    await writeFile(filePath, corruptBytes)
    const store = createStore(
      filePath,
      () => 1_725_000_000_010,
      () => 'concurrent-read',
    )

    const reads = Array.from({ length: 24 }, () => store.read())

    await expect(Promise.all(reads)).resolves.toEqual(
      Array.from({ length: 24 }, () => ({ value: 'default' })),
    )
    expect(await readdir(root)).toEqual([
      'store.json.corrupt-1725000000010-concurrent-read',
    ])
    expect(
      await readFile(`${filePath}.corrupt-1725000000010-concurrent-read`),
    ).toEqual(corruptBytes)
  })

  it('completes corrupt recovery before a subsequently invoked write', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.concat([
      Buffer.from('{"value":"', 'utf8'),
      Buffer.alloc(32 * 1024 * 1024, 0x78),
    ])
    await writeFile(filePath, corruptBytes)
    const store = createStore(
      filePath,
      () => 1_725_000_000_011,
      () => 'read-before-write',
    )

    const recovery = store.read()
    const write = store.write({ value: 'queued-after-recovery' })

    await expect(recovery).resolves.toEqual({ value: 'default' })
    await expect(write).resolves.toBeUndefined()
    await expect(store.read()).resolves.toEqual({ value: 'queued-after-recovery' })
    const recoveredBytes = await readFile(
      `${filePath}.corrupt-1725000000011-read-before-write`,
    )
    expect(recoveredBytes.equals(corruptBytes)).toBe(true)
  })

  it('makes a recovering read observe a previously invoked queued write', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    await writeFile(filePath, '{"value":', 'utf8')
    const store = createStore(
      filePath,
      () => 1_725_000_000_012,
      () => 'write-before-read',
    )

    const write = store.write({ value: 'queued-before-read' })
    const read = store.read()

    await expect(write).resolves.toBeUndefined()
    await expect(read).resolves.toEqual({ value: 'queued-before-read' })
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('preserves an occupied backup candidate and retries with a new id', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{"value":', 'utf8')
    const preservedBytes = Buffer.from('preserved backup bytes', 'utf8')
    const firstCandidate = `${filePath}.corrupt-1725000000013-first-id`
    const secondCandidate = `${filePath}.corrupt-1725000000013-second-id`
    await writeFile(filePath, corruptBytes)
    await writeFile(firstCandidate, preservedBytes)
    const ids = ['first-id', 'second-id']
    const store = createStore(
      filePath,
      () => 1_725_000_000_013,
      () => ids.shift() ?? 'unexpected-id',
    )

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(firstCandidate)).toEqual(preservedBytes)
    expect(await readFile(secondCandidate)).toEqual(corruptBytes)
    expect(await readdir(root)).toEqual([
      'store.json.corrupt-1725000000013-first-id',
      'store.json.corrupt-1725000000013-second-id',
    ])
  })

  it(
    'preserves an occupied broken-symlink backup candidate and retries with a new id',
    async ({ skip }) => {
      const root = await createRoot()
      const filePath = join(root, 'store.json')
      const corruptBytes = Buffer.from('{"value":', 'utf8')
      const firstCandidate = `${filePath}.corrupt-1725000000015-broken-link`
      const secondCandidate = `${filePath}.corrupt-1725000000015-fresh-backup`
      const missingTarget = 'missing-backup-target'
      await writeFile(filePath, corruptBytes)
      try {
        await symlink(missingTarget, firstCandidate)
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
          skip('Symbolic-link creation is not permitted on this Windows host')
        }
        throw error
      }
      const ids = ['broken-link', 'fresh-backup']
      const store = createStore(
        filePath,
        () => 1_725_000_000_015,
        () => ids.shift() ?? 'unexpected-id',
      )

      await expect(store.read()).resolves.toEqual({ value: 'default' })

      expect(await readlink(firstCandidate)).toBe(missingTarget)
      expect(await readFile(secondCandidate)).toEqual(corruptBytes)
      expect(await readdir(root)).toEqual([
        'store.json.corrupt-1725000000015-broken-link',
        'store.json.corrupt-1725000000015-fresh-backup',
      ])
    },
  )

  it('never replaces a pre-existing timestamp-only corrupt backup', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    const corruptBytes = Buffer.from('{"value":', 'utf8')
    const preservedBytes = Buffer.from('older preserved bytes', 'utf8')
    const occupiedPath = `${filePath}.corrupt-1725000000014`
    await writeFile(filePath, corruptBytes)
    await writeFile(occupiedPath, preservedBytes)
    const store = createStore(
      filePath,
      () => 1_725_000_000_014,
      () => 'new-backup-id',
    )

    await expect(store.read()).resolves.toEqual({ value: 'default' })

    expect(await readFile(occupiedPath)).toEqual(preservedBytes)
    expect(await readFile(`${occupiedPath}-new-backup-id`)).toEqual(corruptBytes)
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

  it('continues the operation queue after a rejected write and leaves no temporary files', async () => {
    const root = await createRoot()
    const filePath = join(root, 'store.json')
    await mkdir(filePath)
    const store = createStore(filePath)

    await expect(store.write({ value: 'blocked' })).rejects.toBeDefined()
    await rm(filePath, { recursive: true })
    await expect(store.write({ value: 'recovered' })).resolves.toBeUndefined()

    await expect(store.read()).resolves.toEqual({ value: 'recovered' })
    expect(await readdir(root)).toEqual(['store.json'])
  })

  it('reports whether the destination exists', async () => {
    const filePath = join(await createRoot(), 'store.json')
    const store = createStore(filePath)

    expect(await store.exists()).toBe(false)
    await store.write({ value: 'saved' })
    expect(await store.exists()).toBe(true)
  })
})
