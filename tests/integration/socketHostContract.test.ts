// @vitest-environment node
import { spawn } from 'node:child_process'
import { isBuiltin } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { beforeAll, afterAll } from 'vitest'
import { build } from 'vite'
import { SocketHostService } from '../../src/main/agents/socketHostService'
import { publicProviderEntityId, type ProviderId } from '../../src/shared/agents'
import { codexFixture } from '../fixtures/codexFixture'
import { claudeFixture } from '../fixtures/claudeFixture'
import { grokFixture } from '../fixtures/fakeGrokThreadFixture'
import { devinFixture } from '../fixtures/devinFixture'
import { describeHostServiceContract, type AdapterFixture, type AdapterSessionOptions, type HostServiceFixture } from './adapterContract'
import type { HostDescriptor } from '../../src/shared/hostProtocol'
let buildRoot: string
beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'sotto-socket-build-'))
  await build({ configFile: false, logLevel: 'silent', ssr: { noExternal: ['zod'] }, build: { ssr: resolve('tests/fixtures/socketHostChild.ts'), target: 'node24', outDir: buildRoot, emptyOutDir: false, rollupOptions: { external: id => isBuiltin(id), output: { format: 'cjs', entryFileNames: 'host.cjs' } } } })
})
afterAll(async () => { if (buildRoot && dirname(buildRoot) === tmpdir() && buildRoot.includes('sotto-socket-build-')) await rm(buildRoot, { recursive: true, force: true }) })
async function fixture(provider: ProviderId, native: AdapterFixture, session: AdapterSessionOptions = {}): Promise<HostServiceFixture> {
  const child = spawn(process.execPath, [join(buildRoot, 'host.cjs'), provider, native.root, JSON.stringify(session)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
  const callbacks = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 0
  child.on('message', value => { const message = value as { id?: number; result?: unknown; error?: string }; if (message.id === undefined) return; const callback = callbacks.get(message.id); callbacks.delete(message.id); if (message.error) callback?.reject(new Error(message.error)); else callback?.resolve(message.result) })
  child.on('exit', () => { for (const callback of callbacks.values()) callback.reject(new Error('Socket test host exited.')); callbacks.clear() })
  const call = <T>(method: string, ...args: string[]): Promise<T> => new Promise((resolveCall, reject) => { const id = ++nextId; callbacks.set(id, { resolve: value => resolveCall(value as T), reject }); child.send({ id, method, args }) })
  const descriptor = await new Promise<HostDescriptor>((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Socket test host did not start.')) }, 30000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Socket test host exited before readiness.')) })
    child.on('message', value => { const message = value as { ready?: boolean; descriptor?: HostDescriptor }; if (message.ready && message.descriptor) { clearTimeout(timer); resolveReady(message.descriptor) } })
  })
  const url = 'http://127.0.0.1:' + descriptor.port
  const code = await call<{ code: string }>('pair')
  const paired = await SocketHostService.pair(url, code.code, 'host-contract')
  const local = JSON.parse(await readFile(join(native.root, 'host-listener.json'), 'utf8')) as { adminToken: string }
  const permission = await fetch(url + '/v1/admin/allow-answers', { method: 'POST', headers: { Authorization: 'Bearer ' + local.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: paired.clientId }) })
  if (!permission.ok) throw new Error('Test could not explicitly grant remote answer policy.')
  const client = new SocketHostService({ url, token: paired.token, expectedHostId: descriptor.hostId })
  await client.connect()
  const stop = async (): Promise<void> => { await client.close(); await call('stop'); await exited }
  return {
    service: client, client: { clientId: paired.clientId, user: 'host-contract', transport: 'socket' },
    provider, root: native.root, modelId: publicProviderEntityId(provider, 'model', native.modelId),
    ...(native.protocol ? { protocol: native.protocol } : {}), ...(native.skips ? { skips: native.skips } : {}),
    ...(native.sessions ? { sessions: { starts: id => call<number>('starts', id), stopped: id => call<boolean>('stopped', id) } } : {}),
    nativeStarted: id => call<boolean>('nativeStarted', id),
    driver: {
      typeInProvider: (id, text) => call('typeInProvider', id, text), completeTurn: (id, text) => call('completeTurn', id, text),
      raiseQuestion: (id, text) => call('raiseQuestion', id, text), raisePermission: (id, text) => call('raisePermission', id, text),
      delayNextAck: method => call('delayNextAck', method), requests: () => call('requests'),
      restart: async () => { await stop(); return fixture(provider, native, session) },
    },
    cleanup: async () => { await stop(); await native.cleanup() },
  }
}
const providers: { provider: ProviderId; create: (session?: AdapterSessionOptions) => Promise<AdapterFixture> }[] = [
  { provider: 'codex', create: session => codexFixture(undefined, false, undefined, session) },
  { provider: 'claude', create: session => claudeFixture(undefined, undefined, undefined, session) },
  { provider: 'grok', create: session => grokFixture(undefined, undefined, undefined, session) },
  { provider: 'devin', create: session => devinFixture(undefined, undefined, undefined, session) },
]
for (const provider of providers) describeHostServiceContract('Socket child ' + provider.provider, async session => fixture(provider.provider, await provider.create(session), session))
