// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OWN_SERVERS_UNREAD, registerOwnServersIpc } from '../../../../src/main/ownModelServers/ipc'
import { addressSuffix, OWN_SERVERS_FILE, OwnServers, type OwnServerEvent, type OwnServersOpenCode } from '../../../../src/main/ownModelServers/service'
import {
  OWN_SERVER_WORDS, OWN_SERVERS_ADD, OWN_SERVERS_CHECK, OWN_SERVERS_CHECK_SAVED, OWN_SERVERS_LIST, OWN_SERVERS_REMOVE, type CheckResult, type OwnServer,
} from '../../../../src/shared/ownModelServers'
import { ipcRegistry } from '../../../fixtures/ipcHarness'

// Made up for this test; no real key ever goes near it.
const KEY = 'made-up-own-server-key-5c1f'
const model = { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context: 163_840, thinking: true, images: false }

/** Sotto's OpenCode as the record sees it, writing down every call in order. */
function fakeOpenCode(answers: { running?: boolean; signIn?: boolean; signOut?: boolean } = {}) {
  const calls: string[] = []
  const openCode: OwnServersOpenCode = {
    running: () => answers.running ?? true,
    outdated: () => { calls.push('outdated') },
    catalogAgain: async () => { calls.push('catalog'); return true },
    signInWithKey: async (id, key) => { calls.push(`sign-in ${id} ${key === KEY ? 'key' : 'other'}`); return answers.signIn ?? true },
    signOut: async id => { calls.push(`sign-out ${id}`); return answers.signOut ?? true },
  }
  return { openCode, calls, answers }
}

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sotto-own-servers-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function servers(options: { openCode?: OwnServersOpenCode | undefined; deepSeek?: boolean; check?: (address: string, key: string | undefined) => Promise<CheckResult>; now?: () => number } = {}) {
  const events: OwnServerEvent[] = []
  const deepSeekCalls: string[] = []
  let next = 0
  const service = new OwnServers({ directory, openCode: () => options.openCode,
    deepSeek: () => options.deepSeek ? { changed: () => { deepSeekCalls.push('changed') } } : undefined,
    log: event => events.push(event), newId: () => `test${next++}`,
    ...(options.check ? { check: options.check } : {}), ...(options.now ? { now: options.now } : {}) })
  return { service, events, deepSeekCalls }
}
const saved = async (): Promise<OwnServer[]> => JSON.parse(await readFile(join(directory, OWN_SERVERS_FILE), 'utf8')) as OwnServer[]

describe('adding a server', () => {
  it('saves it, tells OpenCode, and reads the catalog again on a fresh process', async () => {
    const { openCode, calls } = fakeOpenCode()
    const { service, events } = servers({ openCode })
    const result = await service.add({ name: ' Spark ', address: 'spark-head:8888', models: [model, model] })
    expect(result).toEqual({ status: 'ok', server: { id: 'own-test0', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: false, models: [model] } })
    expect(await saved()).toEqual([result.status === 'ok' && result.server])
    expect(await service.list()).toEqual(await saved())
    expect(calls).toEqual(['outdated', 'catalog'])
    expect(events).toEqual(['own-server-added'])
  })

  it('tells DeepSeek Harness on every save, and takes a keyless server with only its adapter, before it can connect (ADR-0138)', async () => {
    const { service, deepSeekCalls } = servers({ deepSeek: true })
    const result = await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] })
    expect(result.status).toBe('ok')
    expect(await saved()).toHaveLength(1)
    expect(deepSeekCalls).toEqual(['changed'])
    const removed = await service.remove({ id: result.status === 'ok' ? result.server.id : '' })
    expect(removed.status).toBe('ok')
    expect(deepSeekCalls).toEqual(['changed', 'changed'])
  })

  it('still refuses a keyed server while only DeepSeek Harness’s adapter runs: its key is OpenCode’s to keep', async () => {
    const { service } = servers({ deepSeek: true })
    expect(await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] }))
      .toMatchObject({ status: 'refused', reason: 'opencode-not-running' })
    expect(await service.list()).toEqual([])
  })

  it('signs the new source in with its key after the record has it, and keeps no copy of the key', async () => {
    const { openCode, calls } = fakeOpenCode()
    const { service, events } = servers({ openCode })
    let onDisk: OwnServer[] = []
    openCode.signInWithKey = async (id, key) => { onDisk = await saved(); calls.push(`sign-in ${id} ${key === KEY ? 'key' : 'other'}`); return true }
    const result = await service.add({ name: 'Spark', address: 'http://spark-head:8888', key: `  ${KEY} `, models: [model] })
    expect(result).toMatchObject({ status: 'ok', server: { id: 'own-test0', keyed: true } })
    // The process the key went to was started with the server already saved.
    expect(onDisk.map(server => server.id)).toEqual(['own-test0'])
    expect(calls).toEqual(['outdated', 'sign-in own-test0 key'])
    expect(await readFile(join(directory, OWN_SERVERS_FILE), 'utf8')).not.toContain(KEY)
    expect(JSON.stringify([result, events])).not.toContain(KEY)
  })

  it('takes the record out again when OpenCode does not take the key', async () => {
    const { openCode, calls } = fakeOpenCode({ signIn: false })
    const { service, events } = servers({ openCode })
    expect(await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] }))
      .toEqual({ status: 'refused', reason: 'sign-in-failed', message: OWN_SERVER_WORDS.signInFailed('Spark') })
    expect(await saved()).toEqual([])
    expect(await service.list()).toEqual([])
    // OpenCode is asked to forget a key it may have kept anyway, while the record still declares the source.
    await vi.waitFor(() => { expect(calls).toEqual(['outdated', 'sign-in own-test0 key', 'sign-out own-test0', 'outdated', 'catalog']) })
    expect(events).toEqual(['own-server-sign-in-failed', 'own-server-add-refused'])
  })

  it('still takes the record out when OpenCode cannot forget the key either, and says so in the log', async () => {
    const { openCode } = fakeOpenCode({ signIn: false })
    const { service, events } = servers({ openCode })
    let declared: OwnServer[] = []
    openCode.signOut = async () => { declared = await saved(); return false }
    expect(await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] })).toMatchObject({ reason: 'sign-in-failed' })
    expect(declared.map(server => server.id)).toEqual(['own-test0'])
    expect(await saved()).toEqual([])
    expect(events).toEqual(['own-server-sign-in-failed', 'own-server-sign-out-failed', 'own-server-add-refused'])
  })

  it('says the server stayed, without its key, when the record cannot be written back after a refused key', async () => {
    const { openCode } = fakeOpenCode({ signIn: false })
    const { service, events } = servers({ openCode })
    // The key is refused, and a folder where the record goes makes the write that takes the server back out fail.
    openCode.signInWithKey = async () => { await rm(join(directory, OWN_SERVERS_FILE)); await mkdir(join(directory, OWN_SERVERS_FILE)); return false }
    expect(await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] }))
      .toEqual({ status: 'refused', reason: 'added-partly', message: OWN_SERVER_WORDS.addPartly('Spark') })
    expect((await service.list()).map(server => server.id)).toEqual(['own-test0'])
    expect(events).toEqual(['own-server-sign-in-failed', 'own-server-add-refused'])
  })

  it('takes the record out again when the sign-in throws', async () => {
    const { openCode } = fakeOpenCode()
    openCode.signInWithKey = async () => { throw new Error('gone') }
    const { service } = servers({ openCode })
    expect(await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] })).toMatchObject({ reason: 'sign-in-failed' })
    expect(await saved()).toEqual([])
  })

  it('saves nothing when OpenCode is not running or not here', async () => {
    for (const openCode of [fakeOpenCode({ running: false }).openCode, undefined]) {
      const { service } = servers({ openCode })
      expect(await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] }))
        .toEqual({ status: 'refused', reason: 'opencode-not-running', message: OWN_SERVER_WORDS.openCodeNotRunning })
      expect(await service.list()).toEqual([])
    }
  })

  it('validates the address again, so a public http address is never saved', async () => {
    const { openCode, calls } = fakeOpenCode()
    const { service } = servers({ openCode })
    expect(await service.add({ name: 'Cloud', address: 'http://models.example.com', models: [model] }))
      .toEqual({ status: 'refused', reason: 'public-http', message: OWN_SERVER_WORDS.publicHttp('models.example.com') })
    expect(await service.add({ name: 'Bad', address: 'ftp://x', models: [model] })).toMatchObject({ reason: 'bad-address' })
    expect(calls).toEqual([])
  })

  it('keeps up to 32 servers, each with its own ID', async () => {
    const { openCode } = fakeOpenCode()
    const { service } = servers({ openCode })
    const added = await Promise.all(Array.from({ length: 33 }, (_, index) => service.add({ name: `S${index}`, address: `box${index}:8000`, models: [model] })))
    expect(added.filter(result => result.status === 'ok')).toHaveLength(32)
    expect(added[32]).toEqual({ status: 'refused', reason: 'full', message: OWN_SERVER_WORDS.full })
    const ids = (await saved()).map(server => server.id)
    expect(new Set(ids).size).toBe(32)
    expect(ids.every(id => /^own-[a-z0-9]+$/u.test(id))).toBe(true)
  })

  it('gives a server an ID from its address in OpenCode’s safe alphabet, the same one when it is added again', async () => {
    const { openCode } = fakeOpenCode()
    const service = new OwnServers({ directory, openCode: () => openCode })
    const first = await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] })
    const id = first.status === 'ok' ? first.server.id : ''
    expect(id).toMatch(/^own-[a-f0-9]{12}$/u)
    expect(id).toBe(`own-${addressSuffix('http://spark-head:8888/v1')}`)
    // Removed and added again with the right key: the same model source, so a thread on one of its models carries on.
    expect(await service.remove({ id })).toEqual({ status: 'ok' })
    const again = await service.add({ name: 'Sparks', address: 'http://SPARK-HEAD:8888/v1', key: KEY, models: [model] })
    expect(again).toMatchObject({ status: 'ok', server: { id, name: 'Sparks', keyed: true } })
    const other = await service.add({ name: 'Forge', address: 'forge:11434', models: [model] })
    expect(other.status === 'ok' && other.server.id).not.toBe(id)
  })

  it('refuses an address that is already added, and keeps a server saved before with the ID it was given', async () => {
    const earlier: OwnServer = { id: 'own-k3v9q2m7x1', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: false, models: [model] }
    await writeFile(join(directory, OWN_SERVERS_FILE), JSON.stringify([earlier]))
    const { openCode, calls } = fakeOpenCode()
    const { service, events } = servers({ openCode })
    expect(await service.add({ name: 'Spark again', address: 'spark-head:8888', key: KEY, models: [model] }))
      .toEqual({ status: 'refused', reason: 'already-added', message: OWN_SERVER_WORDS.alreadyAdded('spark-head:8888') })
    expect(await saved()).toEqual([earlier])
    expect(calls).toEqual([])
    expect(events).toEqual(['own-server-add-refused'])
  })
})

describe('removing a server', () => {
  async function withServer(keyed: boolean, answers: Parameters<typeof fakeOpenCode>[0] = {}) {
    const fake = fakeOpenCode(answers)
    const made = servers({ openCode: fake.openCode })
    await made.service.add({ name: 'Spark', address: 'spark-head:8888', ...(keyed ? { key: KEY } : {}), models: [model] })
    fake.calls.length = 0; made.events.length = 0
    return { ...fake, ...made }
  }

  it('signs its key out in OpenCode before the record goes, then tells OpenCode', async () => {
    const { service, calls, events } = await withServer(true)
    expect(await service.remove({ id: 'own-test0' })).toEqual({ status: 'ok' })
    expect(calls).toEqual(['sign-out own-test0', 'outdated', 'catalog'])
    expect(await saved()).toEqual([])
    expect(events).toEqual(['own-server-removed'])
  })

  it('keeps the server when OpenCode does not forget its key, or is not running to', async () => {
    const failing = await withServer(true, { signOut: false })
    expect(await failing.service.remove({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'sign-in-failed', message: OWN_SERVER_WORDS.signOutFailed('Spark') })
    expect(await saved()).toHaveLength(1)
    failing.answers.running = false
    expect(await failing.service.remove({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'opencode-not-running', message: OWN_SERVER_WORDS.removeNeedsOpenCode('Spark') })
    expect(await saved()).toHaveLength(1)
  })

  it('removes a server without a key whether or not OpenCode is running', async () => {
    const { service, calls, answers } = await withServer(false)
    answers.running = false
    expect(await service.remove({ id: 'own-test0' })).toEqual({ status: 'ok' })
    expect(calls).toEqual([])
    expect(await saved()).toEqual([])
  })

  it('says the key went but the server stayed when the record cannot be written, and a second Remove finishes it', async () => {
    const { service, calls, openCode } = await withServer(true)
    // OpenCode holds one key for the source; signing out a source with none left is done, as OpenCode answers it.
    let credentials = 1
    openCode.signOut = async id => { calls.push(`sign-out ${id} ${credentials}`); credentials = 0; return true }
    // A folder where the record goes makes the next write fail.
    await rm(join(directory, OWN_SERVERS_FILE)); await mkdir(join(directory, OWN_SERVERS_FILE))
    expect(await service.remove({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'removed-partly', message: OWN_SERVER_WORDS.removePartly('Spark') })
    expect((await service.list()).map(server => server.id)).toEqual(['own-test0'])
    await rm(join(directory, OWN_SERVERS_FILE), { recursive: true })
    expect(await service.remove({ id: 'own-test0' })).toEqual({ status: 'ok' })
    expect(calls).toEqual(['sign-out own-test0 1', 'sign-out own-test0 0', 'outdated', 'catalog'])
    expect(await saved()).toEqual([])
  })

  it('says nothing changed when the record of a server without a key cannot be written', async () => {
    const { service } = await withServer(false)
    await rm(join(directory, OWN_SERVERS_FILE)); await mkdir(join(directory, OWN_SERVERS_FILE))
    await expect(service.remove({ id: 'own-test0' })).rejects.toThrow()
    expect((await service.list()).map(server => server.id)).toEqual(['own-test0'])
  })

  it('says a server that is not saved is not found', async () => {
    const { service } = servers({ openCode: fakeOpenCode().openCode })
    expect(await service.remove({ id: 'own-gone' })).toEqual({ status: 'refused', reason: 'not-found', message: OWN_SERVER_WORDS.notFound })
  })
})

describe('the record', () => {
  it('reads what an earlier run saved, and starts empty without one', async () => {
    expect(await servers().service.list()).toEqual([])
    const server: OwnServer = { id: 'own-abc', name: 'Spark', address: 'http://spark-head:8888/v1', keyed: false, models: [model] }
    await writeFile(join(directory, OWN_SERVERS_FILE), JSON.stringify([server]))
    expect(await servers().service.list()).toEqual([server])
  })
})

describe('checking', () => {
  it('checks a typed address with the key given, and a saved one as it is saved', async () => {
    const check = vi.fn(async (address: string): Promise<CheckResult> => ({ status: 'ok', address: `${address}/v1`, kind: 'vllm', models: [{ id: 'm', name: 'm', images: false }], answeredMs: 3 }))
    const { service, events } = servers({ openCode: fakeOpenCode().openCode, check })
    expect(await service.check({ address: 'http://spark-head:8888', key: KEY })).toMatchObject({ status: 'ok' })
    expect(check).toHaveBeenLastCalledWith('http://spark-head:8888', KEY)
    await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] })
    expect(await service.checkSaved({ id: 'own-test0' })).toMatchObject({ status: 'ok', kind: 'vllm' })
    expect(check).toHaveBeenLastCalledWith('http://spark-head:8888/v1', undefined)
    expect(await service.checkSaved({ id: 'own-gone' })).toMatchObject({ status: 'refused', reason: 'not-found' })
    expect(events).toEqual(['own-server-checked', 'own-server-added', 'own-server-checked', 'own-server-check-refused'])
  })

  it('says a keyed server that asks for its key on Check again answered, with the key kept, its saved models and the time it took', async () => {
    let clock = 1_000
    const answers: CheckResult[] = [
      { status: 'refused', reason: 'key-needed', message: 'asks' }, { status: 'refused', reason: 'key-refused', message: 'refuses' },
      { status: 'refused', reason: 'unreachable', message: 'gone' }, { status: 'refused', reason: 'not-openai', message: 'other' },
    ]
    const check = vi.fn(async (): Promise<CheckResult> => { clock += 42; return answers.shift()! })
    const { service } = servers({ openCode: fakeOpenCode().openCode, check, now: () => clock })
    await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] })
    const kept = { status: 'ok', address: 'http://spark-head:8888/v1', kind: 'openai-compatible',
      models: [{ id: model.id, name: model.name, context: model.context, thinking: true, images: false }], answeredMs: 42, keyKept: true }
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual(kept)
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual(kept)
    // Every other refusal stays one.
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'unreachable', message: 'gone' })
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'not-openai', message: 'other' })
  })

  it('leaves a server without a key that asks for one refused on Check again', async () => {
    const { service } = servers({ openCode: fakeOpenCode().openCode, check: async () => ({ status: 'refused', reason: 'key-needed', message: 'asks' }) })
    await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] })
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual({ status: 'refused', reason: 'key-needed', message: 'asks' })
  })
})

describe('the bridge', () => {
  it('registers nothing while the Owl answer is off', () => {
    const { ipc, main } = ipcRegistry()
    registerOwnServersIpc(ipc, undefined, () => [main])
    expect([...ipc.handlers.keys()]).toEqual([])
  })

  it('rejects a list it could not read with fixed words, so the window can offer to try again', async () => {
    const { ipc, main, invoke } = ipcRegistry()
    const failing = { list: async () => { throw new Error(`EISDIR ${directory} ${KEY}`) }, check: vi.fn(), add: vi.fn(), checkSaved: vi.fn(), remove: vi.fn() }
    registerOwnServersIpc(ipc, failing, () => [main])
    const error = await invoke(OWN_SERVERS_LIST).then(() => undefined, (rejected: unknown) => rejected as Error)
    expect(error?.message).toBe(OWN_SERVERS_UNREAD)
  })

  it('answers the main window only, checks what crosses and echoes nothing it was sent', async () => {
    const { openCode } = fakeOpenCode()
    const { service } = servers({ openCode, check: async () => ({ status: 'refused', reason: 'unreachable', message: OWN_SERVER_WORDS.unreachable('x') }) })
    const { ipc, main, invoke, widgetEvent } = ipcRegistry()
    const close = registerOwnServersIpc(ipc, service, () => [main])
    try {
      expect([...ipc.handlers.keys()].sort()).toEqual([OWN_SERVERS_ADD, OWN_SERVERS_CHECK, OWN_SERVERS_CHECK_SAVED, OWN_SERVERS_LIST, OWN_SERVERS_REMOVE].sort())
      const added = await invoke(OWN_SERVERS_ADD, [{ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] }])
      expect(added).toMatchObject({ status: 'ok', server: { id: 'own-test0', keyed: true } })
      expect(await invoke(OWN_SERVERS_LIST)).toHaveLength(1)
      expect(await invoke(OWN_SERVERS_CHECK, [{ address: 'x' }])).toMatchObject({ reason: 'unreachable' })
      // A request the bridge cannot read answers that nothing was changed, and carries nothing of what was sent.
      const bad = await invoke(OWN_SERVERS_ADD, [{ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [], extra: KEY }])
      expect(bad).toEqual({ status: 'refused', reason: 'failed', message: OWN_SERVER_WORDS.failed })
      expect(await invoke(OWN_SERVERS_REMOVE, [{ id: 'not an id' }])).toEqual({ status: 'refused', reason: 'failed', message: OWN_SERVER_WORDS.failed })
      expect(JSON.stringify([added, bad])).not.toContain(KEY)
      await expect(invoke(OWN_SERVERS_LIST, [], widgetEvent)).rejects.toThrow('main Sotto window')
      expect(await invoke(OWN_SERVERS_REMOVE, [{ id: 'own-test0' }])).toEqual({ status: 'ok' })
    } finally { close() }
    expect([...ipc.handlers.keys()]).toEqual([])
  })
})
