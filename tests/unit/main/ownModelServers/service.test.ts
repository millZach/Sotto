// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerOwnServersIpc } from '../../../../src/main/ownModelServers/ipc'
import { OWN_SERVERS_FILE, OwnServers, type OwnServerEvent, type OwnServersOpenCode } from '../../../../src/main/ownModelServers/service'
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

function servers(options: { openCode?: OwnServersOpenCode | undefined; check?: (address: string, key: string | undefined) => Promise<CheckResult> } = {}) {
  const events: OwnServerEvent[] = []
  let next = 0
  const service = new OwnServers({ directory, openCode: () => options.openCode, log: event => events.push(event), newId: () => `test${next++}`,
    ...(options.check ? { check: options.check } : {}) })
  return { service, events }
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
    await vi.waitFor(() => { expect(calls).toEqual(['outdated', 'sign-in own-test0 key', 'outdated', 'catalog']) })
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

  it('gives a new server a short random ID in OpenCode’s safe alphabet', async () => {
    const { openCode } = fakeOpenCode()
    const service = new OwnServers({ directory, openCode: () => openCode })
    const result = await service.add({ name: 'Spark', address: 'spark-head:8888', models: [model] })
    expect(result.status === 'ok' && result.server.id).toMatch(/^own-[a-z0-9]{10}$/u)
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

  it('takes a keyed server that asks for its key on Check again as answering, with its saved models', async () => {
    const check = vi.fn(async (): Promise<CheckResult> => ({ status: 'refused', reason: 'key-needed', message: 'asks' }))
    const { service } = servers({ openCode: fakeOpenCode().openCode, check })
    await service.add({ name: 'Spark', address: 'spark-head:8888', key: KEY, models: [model] })
    expect(await service.checkSaved({ id: 'own-test0' })).toEqual({ status: 'ok', address: 'http://spark-head:8888/v1', kind: 'openai-compatible',
      models: [{ id: model.id, name: model.name, context: model.context, thinking: true, images: false }], answeredMs: 0 })
  })
})

describe('the bridge', () => {
  it('registers nothing while the Owl answer is off', () => {
    const { ipc, main } = ipcRegistry()
    registerOwnServersIpc(ipc, undefined, () => [main])
    expect([...ipc.handlers.keys()]).toEqual([])
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
