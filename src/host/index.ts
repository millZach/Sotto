import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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
import { githubPullRequestMerged } from '../main/agents/worktreeCleanup'
import { acquireHostLock, HostLockError, readBootId, releaseHostLock, type HostLease } from './lock'

export interface HeadlessHostOptions {
  dataDirectory: string
  keyFile?: string
  port?: number
  origins?: readonly string[]
  providers?: AgentRuntimeOptions['providers']
  reasoner?: AgentRuntimeOptions['reasoner']
  log?: (event: string) => void
  /**
   * Set when the desktop's launch script started this host over SSH (SOTTO_HOST_STARTED_BY). The host
   * writes it into its listener descriptor, which only the lock holder writes, so the desktop can tell
   * a host Sotto started, and may stop, from one the user started, however many launches raced.
   */
  startedBy?: 'launch-script'
}

export { HostLockError } from './lock'
/** The command line itself was wrong. The message names the fix and is safe to print; the key-file hint would only mislead. */
export class HostArgumentError extends Error {}

/** Starts the same coordinator and durable workspace as Electron, with no desktop capabilities. */
export async function startHeadlessHost(options: HeadlessHostOptions) {
  // A second listener must never open the same stores or replace the live descriptor.
  const directory = resolve(options.dataDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'host-listener.lock')
  let lease: HostLease | undefined
  if (options.port !== undefined) {
    const boot = await readBootId()
    lease = { pid: process.pid, nonce: randomUUID(), ...(boot ? { boot } : {}) }
    await acquireHostLock(path, lease, { boot, ...(options.log ? { log: options.log } : {}) })
  }
  const release = async (): Promise<void> => { if (lease) await releaseHostLock(path, lease) }
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
      // The host owns its worktrees, so it reclaims them under the rules in its own settings (ADR-0019, ADR-0025).
      worktreeCleanup: { pullRequestMerged: githubPullRequestMerged, log: event => options.log?.(event) },
      claudeSettingsLog: event => options.log?.(event),
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
        await writeFile(join(directory, 'host-listener.json'), JSON.stringify({ ...listener.descriptor, adminToken: listener.adminToken, ...(options.startedBy ? { startedBy: options.startedBy } : {}) }) + '\n', { encoding: 'utf8', mode: 0o600 })
        await chmod(join(directory, 'host-listener.json'), 0o600)
      }
    } catch (error) { await listener?.close(); await runtime.close(); throw error }
    // Started once the host is up; close drains a sweep in progress through the runtime, before its host closes.
    runtime.worktreeCleanup.start()
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
  return { dataDirectory: resolve(dataDirectory), port, ...(keyFile ? { keyFile: resolve(keyFile) } : {}),
    ...(env.SOTTO_HOST_STARTED_BY === 'launch-script' ? { startedBy: 'launch-script' as const } : {}) }
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
    const options = parseHostArguments(process.argv.slice(2))
    // Read once: the provider processes this host starts must not inherit the mark.
    delete process.env.SOTTO_HOST_STARTED_BY
    host = await startHeadlessHost({ ...options, log: event => console.error('[Sotto] ' + event) })
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
