// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretRequests, sweepSecretFiles, type SecretOutcome } from '../../../src/main/secrets/secretRequests'
import { SECRET_REF_PATTERN, SECRET_REQUEST_ID_PREFIX, requestSecretInputSchema, type RequestSecretInput } from '../../../src/shared/secretRequests'

/** A test may run something once a secret file is on disk, before the service hears the write finished. */
const writes = vi.hoisted(() => ({ afterWrite: undefined as (() => void) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => { await actual.writeFile(...args); writes.afterWrite?.() } }
})

const CANARY = 'canary-7f3a-SECRET-value'
const folders: string[] = []
const services: SecretRequests[] = []
afterEach(async () => {
  writes.afterWrite = undefined
  for (const service of services.splice(0)) service.close()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
  vi.useRealTimers()
})
async function setup(options: Partial<ConstructorParameters<typeof SecretRequests>[0]> = {}): Promise<{ service: SecretRequests; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-secrets-'))
  folders.push(directory)
  const service = new SecretRequests({ directory, protect: async () => undefined, ...options })
  services.push(service)
  return { service, directory }
}
const ask: RequestSecretInput = { label: 'Stripe test key', reason: 'To run the checkout tests. Find it under Developers > API keys.' }
/** The request the card shows, once the service lists it. */
function shown(service: SecretRequests, threadId = 'thread-a') {
  const request = service.requests().get(threadId)?.[0]
  if (!request) throw new Error('No card is showing.')
  return request
}

describe('secret requests', () => {
  it('shows a card in its thread that names the fields and never a value, and saves a one-use reference', async () => {
    const { service } = await setup()
    const outcome = service.ask('thread-a', { ...ask, url: 'https://dashboard.stripe.com/test/apikeys', placeholder: 'sk_test_…' })
    const request = shown(service)
    expect(request.id.startsWith(SECRET_REQUEST_ID_PREFIX)).toBe(true)
    expect(request.kind).toBe('permission')
    expect(request.permissionChoices).toEqual([{ id: 'decline', label: 'Decline', kind: 'deny' }])
    expect(request.secretRequest).toMatchObject({ label: 'Stripe test key', delivery: 'secretRef', url: 'https://dashboard.stripe.com/test/apikeys',
      fields: [{ name: 'value', label: 'Stripe test key', placeholder: 'sk_test_…', secret: true }] })
    await service.save('thread-a', request.id, { value: CANARY })
    const result = await outcome
    expect(result.status).toBe('saved')
    const ref = (result as Extract<SecretOutcome, { delivery: 'secretRef' }>).refs.value!
    expect(ref).toMatch(SECRET_REF_PATTERN)
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(service.requests().get('thread-a')).toBeUndefined()
    // Another thread cannot use it; its own thread can, once.
    expect(service.take('thread-b', ref)).toBeNull()
    expect(service.take('thread-a', ref)).toBe(CANARY)
    expect(service.take('thread-a', ref)).toBeNull()
    expect(service.held()).toEqual({ waiting: 0, refs: 0, files: 0 })
  })

  it('asks for up to eight values on one card, shows the ones marked so, and needs every one', async () => {
    const { service } = await setup()
    const outcome = service.ask('thread-a', { ...ask, fields: [
      { name: 'user', label: 'User name', secret: false },
      { name: 'password', label: 'Password' },
    ] })
    const request = shown(service)
    expect(request.secretRequest?.fields).toEqual([{ name: 'user', label: 'User name', secret: false }, { name: 'password', label: 'Password', secret: true }])
    await expect(service.save('thread-a', request.id, { user: 'rez' })).rejects.toThrow('Enter Password, or decline the card.')
    await expect(service.save('thread-a', request.id, { user: '  ', password: CANARY })).rejects.toThrow('Enter User name')
    await service.save('thread-a', request.id, { user: 'rez', password: CANARY })
    const result = await outcome as Extract<SecretOutcome, { delivery: 'secretRef' }>
    expect(Object.keys(result.refs)).toEqual(['user', 'password'])
    expect(service.take('thread-a', result.refs.password!)).toBe(CANARY)
  })

  it('writes a file only its user reads, for a command, and deletes it when let go', async () => {
    const { service, directory } = await setup()
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file' })
    await service.save('thread-a', shown(service).id, { value: CANARY })
    const result = await outcome as Extract<SecretOutcome, { delivery: 'file' }>
    const file = result.files.value!
    expect(file.startsWith(join(directory, 'secret-files'))).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(CANARY)
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'secret-files'))).mode & 0o777).toBe(0o700)
    }
    expect(service.release('thread-b', { files: [file] })).toBe(0)
    expect(service.release('thread-a', { files: [file] })).toBe(1)
    await vi.waitFor(() => expect(existsSync(file)).toBe(false))
  })

  it('protects the folder before the first file is written', async () => {
    const protect = vi.fn(async () => undefined)
    const { service, directory } = await setup({ protect })
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file' })
    await service.save('thread-a', shown(service).id, { value: CANARY })
    await outcome
    expect(protect).toHaveBeenCalledWith(join(directory, 'secret-files'))
  })

  it('ends a card declined on the card or from a phone, and refuses a phone that approves', async () => {
    const { service } = await setup()
    const first = service.ask('thread-a', ask)
    expect(() => service.answer('thread-a', shown(service).id, true)).toThrow('Enter the values on the card in Sotto on your computer')
    service.answer('thread-a', shown(service).id, false)
    expect(await first).toEqual({ status: 'declined' })
    const second = service.ask('thread-a', ask)
    service.decline('thread-a', shown(service).id)
    expect(await second).toEqual({ status: 'declined' })
    expect(() => service.decline('thread-a', 'sotto:secret:gone')).toThrow('no longer pending')
  })

  it('times out unanswered, at the shorter of its own wait and the client\'s', async () => {
    vi.useFakeTimers()
    const { service } = await setup()
    const outcome = service.ask('thread-a', { ...ask, timeoutMs: 60_000 }, { waitMs: 5_000 })
    expect(shown(service).secretRequest?.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await outcome).toEqual({ status: 'timed_out' })
    expect(service.requests().get('thread-a')).toBeUndefined()
  })

  it('cancels with its call, keeps nothing a late save sends, and forgets a closed thread', async () => {
    const { service } = await setup()
    const controller = new AbortController()
    const outcome = service.ask('thread-a', ask, { signal: controller.signal })
    const id = shown(service).id
    controller.abort()
    expect(await outcome).toEqual({ status: 'cancelled' })
    await expect(service.save('thread-a', id, { value: CANARY })).rejects.toThrow('no longer waiting')
    expect(service.held()).toEqual({ waiting: 0, refs: 0, files: 0 })

    const saved = service.ask('thread-a', ask)
    await service.save('thread-a', shown(service).id, { value: CANARY })
    const ref = ((await saved) as Extract<SecretOutcome, { delivery: 'secretRef' }>).refs.value!
    const waiting = service.ask('thread-a', ask)
    service.forgetThreads(['thread-a'])
    expect(await waiting).toEqual({ status: 'cancelled' })
    expect(service.take('thread-a', ref)).toBeNull()
  })

  it('lets a value go after an hour unused', async () => {
    let now = 1_000_000
    const { service } = await setup({ now: () => now, keepMs: 60_000 })
    const outcome = service.ask('thread-a', ask)
    await service.save('thread-a', shown(service).id, { value: CANARY })
    const ref = ((await outcome) as Extract<SecretOutcome, { delivery: 'secretRef' }>).refs.value!
    now += 60_001
    expect(service.take('thread-a', ref)).toBeNull()
  })

  it('stops the cards and values of a thread that is no longer open when the coordinator next reads', async () => {
    let open = true
    const { service } = await setup({ open: () => open })
    const outcome = service.ask('thread-a', ask)
    open = false
    service.requests()
    await Promise.resolve()
    expect(await outcome).toEqual({ status: 'cancelled' })
  })

  it('refuses a card for a closed thread or a closed service at once', async () => {
    const { service } = await setup({ open: () => false })
    expect(await service.ask('thread-a', ask)).toEqual({ status: 'cancelled' })
  })

  it('empties its folder at start and deletes every file when Sotto closes', async () => {
    const { service, directory } = await setup()
    await mkdir(join(directory, 'secret-files'), { recursive: true })
    await writeFile(join(directory, 'secret-files', 'left-behind'), CANARY)
    await service.sweep()
    expect(existsSync(join(directory, 'secret-files'))).toBe(false)
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file' })
    await service.save('thread-a', shown(service).id, { value: CANARY })
    const file = ((await outcome) as Extract<SecretOutcome, { delivery: 'file' }>).files.value!
    const waiting = service.ask('thread-a', ask)
    service.close()
    expect(await waiting).toEqual({ status: 'cancelled' })
    expect(existsSync(file)).toBe(false)
    expect(await readdir(join(directory, 'secret-files'))).toEqual([])
  })

  it('empties the folder at start with secret requests off too, so a value never waits for the feature to return', async () => {
    const { directory } = await setup()
    await mkdir(join(directory, 'secret-files'), { recursive: true })
    await writeFile(join(directory, 'secret-files', 'left-behind'), CANARY)
    await sweepSecretFiles(directory)
    expect(existsSync(join(directory, 'secret-files'))).toBe(false)
    await sweepSecretFiles(directory)
  })

  it('keeps no file when Sotto closes while the folder is being made', async () => {
    let unblock: () => void = () => undefined
    let reached: () => void = () => undefined
    const protecting = new Promise<void>(done => { reached = done })
    const { service, directory } = await setup({ protect: () => { reached(); return new Promise<void>(done => { unblock = done }) } })
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file' })
    const saving = service.save('thread-a', shown(service).id, { value: CANARY })
    await protecting
    service.close()
    unblock()
    await expect(saving).rejects.toThrow('Nothing was kept')
    expect(await outcome).toEqual({ status: 'cancelled' })
    expect(await readdir(join(directory, 'secret-files'))).toEqual([])
    expect(service.held()).toEqual({ waiting: 0, refs: 0, files: 0 })
  })

  it('deletes a file written as Sotto closes, before the save returns', async () => {
    const { service, directory } = await setup()
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file', fields: [{ name: 'user', label: 'User name' }, { name: 'password', label: 'Password' }] })
    let onDisk: string[] = []
    // The first file is on disk and the service has not heard yet: Sotto closes then.
    writes.afterWrite = () => { writes.afterWrite = undefined; onDisk = readdirSync(join(directory, 'secret-files')); service.close() }
    await expect(service.save('thread-a', shown(service).id, { user: 'rez', password: CANARY })).rejects.toThrow('Nothing was kept')
    expect(onDisk).toHaveLength(1)
    expect(await outcome).toEqual({ status: 'cancelled' })
    expect(await readdir(join(directory, 'secret-files'))).toEqual([])
    expect(service.held()).toEqual({ waiting: 0, refs: 0, files: 0 })
  })

  it('deletes a released file before it returns', async () => {
    const { service } = await setup()
    const outcome = service.ask('thread-a', { ...ask, delivery: 'file' })
    await service.save('thread-a', shown(service).id, { value: CANARY })
    const file = ((await outcome) as Extract<SecretOutcome, { delivery: 'file' }>).files.value!
    expect(service.release('thread-a', { files: [file] })).toBe(1)
    expect(existsSync(file)).toBe(false)
  })

  it('takes fields named like members every object has as plain names, and refuses them from an agent', async () => {
    const names = ['toString', 'constructor', '__proto__']
    for (const name of names) {
      expect(requestSecretInputSchema.safeParse({ ...ask, fields: [{ name, label: 'Key' }] }).success).toBe(false)
    }
    // A card made some other way still saves by its own names, and never reads a value from the object's prototype.
    const { service } = await setup()
    const outcome = service.ask('thread-a', { ...ask, fields: names.map(name => ({ name, label: `The ${name}` })) })
    await expect(service.save('thread-a', shown(service).id, {})).rejects.toThrow('Enter The toString, or decline the card.')
    const values = Object.fromEntries(names.map(name => [name, `${CANARY}-${name}`])) as Record<string, string>
    await service.save('thread-a', shown(service).id, values)
    const result = await outcome as Extract<SecretOutcome, { delivery: 'secretRef' }>
    expect(Object.keys(result.refs)).toEqual(names)
    for (const name of names) {
      expect(Object.hasOwn(result.refs, name)).toBe(true)
      expect(service.take('thread-a', result.refs[name]!)).toBe(`${CANARY}-${name}`)
    }

    const files = service.ask('thread-a', { ...ask, delivery: 'file', fields: names.map(name => ({ name, label: `The ${name}` })) })
    await service.save('thread-a', shown(service).id, values)
    const written = await files as Extract<SecretOutcome, { delivery: 'file' }>
    for (const name of names) expect(await readFile(written.files[name]!, 'utf8')).toBe(`${CANARY}-${name}`)
  })

  it('offers a sign-in page only as an http or https address without credentials', async () => {
    const { service } = await setup()
    void service.ask('thread-a', { ...ask, url: 'javascript:alert(1)' })
    void service.ask('thread-b', { ...ask, url: 'https://user:pass@example.com/' })
    expect(shown(service, 'thread-a').secretRequest?.url).toBeUndefined()
    expect(shown(service, 'thread-b').secretRequest?.url).toBeUndefined()
  })

  it('tells its listeners when a card shows and ends', async () => {
    const { service } = await setup()
    const listener = vi.fn()
    const stop = service.subscribe(listener)
    const outcome = service.ask('thread-a', ask)
    expect(listener).toHaveBeenCalledTimes(1)
    service.decline('thread-a', shown(service).id)
    await outcome
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })
})
