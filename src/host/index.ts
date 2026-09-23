import { chmod, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentRuntime, type AgentRuntimeOptions } from '../main/agents/runtime'
import { SecureSettings } from '../main/agents/secureSettings'
import { createStorageRepositories } from '../main/storage/repositories'
import { RecoveryNoticeCenter } from '../main/storage/recoveryNoticeCenter'
import { openRuntimeMemory } from '../main/memory/runtime'
import { MemoryProfile } from '../main/memory/profile'
import { PolicyStore } from '../main/memory/policies'
import { join } from 'node:path'
import { openHostCredentials } from './credentials'
import { PairedClients } from '../main/agents/pairing'
import { startSocketServer } from './socketServer'
import { remoteAnswerScope } from '../main/agents/authority'

export interface HeadlessHostOptions {
  dataDirectory: string
  keyFile?: string
  port?: number
  origins?: readonly string[]
  providers?: AgentRuntimeOptions['providers']
  reasoner?: AgentRuntimeOptions['reasoner']
  log?: (event: string) => void
}

/** Refused startup because another host holds, or may hold, the data folder. The message is safe to print. */
export class HostLockError extends Error {}
/** The command line itself was wrong. The message names the fix and is safe to print; the key-file hint would only mislead. */
export class HostArgumentError extends Error {}

/** Whether the process a lock names is still running. A process another account owns counts as running. */
function lockHolderAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Takes the data folder's lock. A lock left behind by a host that no longer runs (a crash, a reboot) is
 * reclaimed, so a reconnect after either needs no hand cleanup; a lock whose holder still runs, or one
 * that cannot be read, is refused without touching it.
 */
async function acquireLock(path: string, lease: string, log?: (event: string) => void): Promise<void> {
  for (let reclaimed = false; ; reclaimed = true) {
    try {
      const lock = await open(path, 'wx', 0o600)
      try { await lock.writeFile(lease, 'utf8'); await lock.sync() } finally { await lock.close() }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || reclaimed) throw new HostLockError('This host data folder could not be locked. Check that its host-listener.lock can be written, then start again.', { cause: error })
    }
    let holder: number
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown }
      if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) throw new Error('invalid')
      holder = value.pid as number
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new HostLockError('The host-listener.lock in this data folder could not be read. If no host uses the folder, remove that file and start again.', { cause: error })
    }
    if (lockHolderAlive(holder)) throw new HostLockError(`Another host (process ${holder}) is still running with this data folder. Stop it first, or use a different data folder.`)
    try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new HostLockError('A stale host-listener.lock in this data folder could not be removed. Remove it and start again.', { cause: error }) }
    log?.('host-lock-reclaimed')
  }
}

/** Starts the same coordinator and durable workspace as Electron, with no desktop capabilities. */
export async function startHeadlessHost(options: HeadlessHostOptions) {
  // A second listener must never open the same stores or replace the live descriptor.
  const directory = resolve(options.dataDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'host-listener.lock')
  const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID() })
  if (options.port !== undefined) await acquireLock(path, lease, options.log)
  const release = async (): Promise<void> => {
    if (options.port === undefined) return
    try { if (await readFile(path, 'utf8') === lease) await unlink(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  try {
    const host = await startHostRuntime(options)
    let closing: Promise<void> | undefined
    return { ...host, close: (): Promise<void> => { closing ??= host.close().finally(release); return closing } }
  } catch (error) { await release(); throw error }
}

async function startHostRuntime(options: HeadlessHostOptions) {
  const directory = resolve(options.dataDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const credentials = await openHostCredentials(directory, options.keyFile)
  const recovery = new RecoveryNoticeCenter()
  const repositories = createStorageRepositories(directory, recovery)
  const settings = new SecureSettings(repositories.settings, credentials)
  await settings.migrate()
  const startup = await settings.get()
  const memory = openRuntimeMemory(join(directory, 'memory.sqlite'), event => options.log?.(event))
  try {
    const policy = memory ? new PolicyStore(memory) : undefined
    // A paired client with an open socket is the host's window in front: while none is connected, no remote is fetched.
    let peersConnected = (): boolean => false
    const runtime = await createAgentRuntime({
      observeActiveThread: false, directory, credentials, settings: () => startup, writingSettings: () => settings.get(),
      historyEnabled: () => startup.historyEnabled, coordinatorEnabled: () => startup.voiceCoordinatorEnabled,
      gitStatus: { fetchIntervalMs: () => startup.gitFetchIntervalSeconds * 1000, foreground: () => peersConnected() },
      ...(policy ? { authority: policy } : {}),
      ...(memory && startup.memoryEnabled ? { preferences: new MemoryProfile(memory) } : {}),
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.reasoner ? { reasoner: options.reasoner } : {}),
      openExternal: async () => { throw new Error('Open account settings on the host machine to continue.') },
      openThreadFolder: async () => { throw new Error('This folder is on the host machine. Open it there to continue.') },
      logFailure: code => options.log?.(code),
    })
    const pairing = new PairedClients(directory)
    let listener: Awaited<ReturnType<typeof startSocketServer>> | undefined
    try {
      await pairing.load()
      if (options.port !== undefined) {
        listener = await startSocketServer({ service: runtime.hostService, pairing, port: options.port,
          ...(options.origins ? { origins: options.origins } : {}),
          mayAnswer: client => policy?.mayGrant(client).allowed ?? false,
          setAnswers: (clientId, allowed) => {
            if (!policy) throw new Error('Permission policies are unavailable on this host.')
            for (const record of policy.list({ scope: remoteAnswerScope(clientId) })) {
              if (record.action === 'remote-answer' && record.resource === clientId) policy.revoke(record.id)
            }
            if (allowed) policy.grantRemoteAnswers(clientId, 'The user allowed this paired device to answer permission requests on the host.')
          },
        })
        const { peers } = listener
        peersConnected = () => peers() > 0
        await writeFile(join(directory, 'host-listener.json'), JSON.stringify({ ...listener.descriptor, adminToken: listener.adminToken }) + '\n', { encoding: 'utf8', mode: 0o600 })
        await chmod(join(directory, 'host-listener.json'), 0o600)
      }
    } catch (error) { await listener?.close(); await runtime.close(); throw error }
    let closing: Promise<void> | undefined
    return {
      service: runtime.hostService, credentials, pairing, descriptor: listener?.descriptor,
      close: (): Promise<void> => {
        closing ??= (async () => {
          try { await listener?.close() } finally {
            try { await runtime.close() } finally {
              memory?.close()
              if (listener) {
                const path = join(directory, 'host-listener.json')
                try { const current = JSON.parse(await readFile(path, 'utf8')) as { adminToken?: string }; if (current.adminToken === listener.adminToken) await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.log?.('host-descriptor-cleanup-failed') }
              }
            }
          }
        })()
        return closing
      },
    }
  } catch (error) { memory?.close(); throw error }
}

export function parseHostArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): HeadlessHostOptions {
  let dataDirectory = env.SOTTO_HOST_DATA, keyFile = env.SOTTO_HOST_KEY_FILE
  let port = 0
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument !== '--data' && argument !== '--key-file' && argument !== '--port') throw new HostArgumentError('Use --data <folder> and optionally --key-file <file>.')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new HostArgumentError('Each host option needs a value.')
    if (argument === '--data') dataDirectory = value
    else if (argument === '--key-file') keyFile = value
    else { port = Number(value); if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) throw new HostArgumentError('Choose a port from 0 through 65535.') }
  }
  if (!dataDirectory?.trim()) throw new HostArgumentError('Choose a host data folder with --data or SOTTO_HOST_DATA.')
  return { dataDirectory: resolve(dataDirectory), port, ...(keyFile ? { keyFile: resolve(keyFile) } : {}) }
}

/** The process stays available without a provider connection; SIGTERM and SIGINT stop it cleanly. */
export async function runHeadlessCommandLine(): Promise<void> {
  const args = process.argv.slice(2)
  const adminFlags = ['--pairing-code', '--allow-answers', '--deny-answers', '--revoke-client']
  const action = args.find(argument => adminFlags.includes(argument))
  if (action) {
    try {
      const index = args.indexOf(action)
      const clientId = action === '--pairing-code' ? undefined : args[index + 1]
      if (action !== '--pairing-code' && (!clientId || clientId.startsWith('--'))) throw new HostArgumentError('Choose a paired client by its client ID.')
      const options = parseHostArguments(args.filter((_, position) => position !== index && (clientId === undefined || position !== index + 1)))
      const descriptor = JSON.parse(await readFile(join(options.dataDirectory, 'host-listener.json'), 'utf8')) as { port: number; hostId: string; adminToken: string }
      if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.adminToken !== 'string') throw new Error('The host descriptor is invalid.')
      const response = await fetch('http://127.0.0.1:' + descriptor.port + '/v1/admin/' + action.slice(2), {
        method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.adminToken, 'Content-Type': 'application/json' },
        ...(clientId ? { body: JSON.stringify({ clientId }) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error',
      })
      if (!response.ok) throw new Error('The host refused this administration request.')
      const result = await response.json() as { hostId?: string }
      if (result.hostId !== descriptor.hostId) throw new Error('The host identity changed.')
      process.stdout.write(JSON.stringify(result) + '\n')
    } catch (error) {
      console.error(error instanceof HostArgumentError ? error.message : 'The running host could not complete this action. Check its data folder and try again.')
      process.exitCode = 1
    }
    return
  }
  let stopping = false
  let host: Awaited<ReturnType<typeof startHeadlessHost>> | undefined
  const keepAlive = setInterval(() => undefined, 60_000)
  const stop = (): void => {
    stopping = true
    if (!host) return
    clearInterval(keepAlive)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    void host.close().catch(() => { console.error('[Sotto] host-shutdown-failed'); process.exitCode = 1 })
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    host = await startHeadlessHost({ ...parseHostArguments(process.argv.slice(2)), log: event => console.error('[Sotto] ' + event) })
    if (stopping) stop()
    else { console.error('[Sotto] host-ready'); if (host.descriptor) process.stdout.write(JSON.stringify({ ...host.descriptor, event: 'ready' }) + '\n') }
  } catch (error) {
    clearInterval(keepAlive)
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
    console.error('[Sotto] host-start-failed')
    if (error instanceof HostLockError || error instanceof HostArgumentError) console.error(error.message)
    else console.error('Check the data folder and its original key file, then retry with the same --data and --key-file: host/index.js from an extracted archive, out/host/index.js from a checkout.')
    process.exitCode = 1
  }
}

if (require.main === module) void runHeadlessCommandLine()
