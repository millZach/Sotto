import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentRuntime, type AgentRuntimeOptions } from '../main/agents/runtime'
import { loadHostIdentity } from '../main/agents/hostIdentity'
import { MISSING_REMOTE_ATTACHMENT } from '../main/agents/attachmentStore'
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
import { githubPullRequestMerged } from '../main/agents/worktreeCleanup'
import { acquireHostLock, HOST_LOCK_HELD_EXIT_CODE, HostLockError, HostLockHeldError, readBootId, releaseHostLock, type HostLease } from './lock'
import { ProviderSignIns, type ProviderSignInOptions } from './providerSignIn'
import { startHostPhoneAccess, type HostPhoneAccess } from './phones'
import type { PhoneAccessTailscale } from '../main/phones/phoneAccess'

export interface HeadlessHostOptions {
  dataDirectory: string
  keyFile?: string
  port?: number
  origins?: readonly string[]
  providers?: AgentRuntimeOptions['providers']
  reasoner?: AgentRuntimeOptions['reasoner']
  log?: (event: string) => void
  /**
   * Set when the desktop's launch script started this host over SSH, or its start at boot unit did (SOTTO_HOST_STARTED_BY,
   * ADR-0054). The host writes it into its listener descriptor, which only the lock holder writes, so the desktop can
   * tell a host Sotto started, and may stop, from one the user started, however many launches raced.
   */
  startedBy?: HostStartedBy
  /** Tests stand fake clients in for the providers' own sign-ins; the host finds the real ones as its adapters do. */
  signInCommand?: ProviderSignInOptions['command']
  /** Tests stand in for a host of another Sotto version; the host advertises its own. */
  sottoVersion?: string
  /** Tests stand in for the registry, the installers and where each client is; the host finds and runs the real ones. */
  clients?: AgentRuntimeOptions['clients']
  locateClient?: AgentRuntimeOptions['locateClient']
  /** Tests and end-to-end runs stand in for this machine's Tailscale, which phone access runs (ADR-0050). */
  tailscale?: PhoneAccessTailscale
}

export { HostLockError, HostLockHeldError } from './lock'
/** Who started a host, as SOTTO_HOST_STARTED_BY says: the desktop's launch script, or the host's start at boot unit (ADR-0054). */
export type HostStartedBy = 'launch-script' | 'boot'
const STARTED_BY: ReadonlySet<string> = new Set<HostStartedBy>(['launch-script', 'boot'])
/** The command line itself was wrong. The message names the fix and is safe to print; the key-file hint would only mislead. */
export class HostArgumentError extends Error {}

/** Safe startup guidance; credential contents and storage errors must never be printed. */
export class HostKeyMigrationError extends Error {}

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
  if ((await repositories.settings.get()).llmApiKey && !credentials.available()) {
    throw new HostKeyMigrationError('A key saved by an older version of Sotto needs secure storage. Pass --key-file <file> and start the host again. The saved key has not been changed.')
  }
  await settings.migrate(() => options.log?.('openrouter-key-migration-failed')).catch(() => {
    throw new HostKeyMigrationError('The OpenRouter key could not be stored securely and was removed from settings. Enter it again on the host machine after restoring storage access. Start the host with --key-file <file>.')
  })
  await repositories.settings.migrateProjectWorkingCopyDefaults(await loadHostIdentity(directory))
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
      ...(options.clients ? { clients: options.clients } : {}),
      ...(options.locateClient ? { locateClient: options.locateClient } : {}),
      openExternal: async () => { throw new Error('Open account settings on the host machine to continue.') },
      openThreadFolder: async () => { throw new Error('This folder is on the host machine. Open it there to continue.') },
      logFailure: code => options.log?.(code),
      // A desktop shows this host's refusals, so an image this host lost is named as the host's, not "this computer".
      missingAttachment: MISSING_REMOTE_ATTACHMENT,
      // The host connects every provider that is installed and signed in here, except the ones turned off (ADR-0036).
      runsAs: 'headless-host',
      // The host owns its worktrees, so it reclaims them under the rules in its own settings (ADR-0041, ADR-0025).
      worktreeCleanup: { pullRequestMerged: githubPullRequestMerged, log: event => options.log?.(event) },
      claudeSettingsLog: event => options.log?.(event),
    })
    const pairing = new PairedClients(directory)
    // A provider signed in from a paired client's browser is connected here for that client (ADR-0037).
    const signIns = new ProviderSignIns({ ...(options.signInCommand ? { command: options.signInCommand } : {}),
      connect: async (provider, clientId) => {
        const client = { clientId, user: pairing.list().find(item => item.clientId === clientId)?.name ?? 'Paired client', transport: 'socket' as const }
        const state = await runtime.hostService.command({ type: 'connect', provider }, client)
        const status = state.host.providers?.find(item => item.id === provider)
        return status?.connection === 'connected' ? undefined : status?.error ?? state.error ?? 'It did not confirm the connection.'
      } })
    let listener: Awaited<ReturnType<typeof startSocketServer>> | undefined
    let phones: HostPhoneAccess | undefined
    try {
      await pairing.load()
      if (options.port !== undefined) {
        // Phone access opens its own loopback listener, on a port it remembers, for Tailscale Serve to carry; this one,
        // with the administrative routes, stays reachable only from this machine and through the desktop's SSH (ADR-0050).
        phones = startHostPhoneAccess({ directory, service: runtime.hostService, pairing, policy, settings, startup,
          ...(options.tailscale ? { tailscale: options.tailscale } : {}), ...(options.log ? { log: options.log } : {}) })
        listener = await startSocketServer({ service: runtime.hostService, pairing, port: options.port, signIns, clientUpdates: true, phones: phones.administration,
          ...(options.origins ? { origins: options.origins } : {}), ...(options.sottoVersion ? { sottoVersion: options.sottoVersion } : {}),
          mayAnswer: client => policy?.mayGrant(client).allowed ?? false,
          setAnswers: (clientId, allowed) => {
            if (!policy) throw new Error('Permission policies are unavailable on this host.')
            policy.setRemoteAnswers(clientId, allowed, 'The user allowed this paired device to answer permission requests on the host.')
          },
        })
        const { peers } = listener
        peersConnected = () => peers() > 0
        // Written beside it and moved into place, so a launch script reading it never finds it half written.
        const descriptorPath = join(directory, 'host-listener.json'), written = `${descriptorPath}.${process.pid}.tmp`
        await writeFile(written, JSON.stringify({ ...listener.descriptor, adminToken: listener.adminToken, ...(options.startedBy ? { startedBy: options.startedBy } : {}) }) + '\n', { encoding: 'utf8', mode: 0o600 })
        await chmod(written, 0o600)
        await rename(written, descriptorPath)
      }
    } catch (error) { signIns.close(); await phones?.close().catch(() => options.log?.('phone-access-close-failed')); await listener?.close(); await runtime.close(); throw error }
    // Started once the host is up; close drains a sweep in progress through the runtime, before its host closes.
    runtime.worktreeCleanup.start()
    let closing: Promise<void> | undefined
    return {
      service: runtime.hostService, credentials, pairing, descriptor: listener?.descriptor,
      close: (): Promise<void> => {
        closing ??= (async () => {
          signIns.close()
          // Phone access goes first: it takes Sotto's Serve setting away, so nothing on the tailnet points at a closed port.
          try { await phones?.close() } catch { options.log?.('phone-access-close-failed') }
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
    ...(env.SOTTO_HOST_STARTED_BY && STARTED_BY.has(env.SOTTO_HOST_STARTED_BY) ? { startedBy: env.SOTTO_HOST_STARTED_BY as HostStartedBy } : {}) }
}

/**
 * The code a host that did not start exits with. Another live host holding the data folder gets its own, which a start
 * at boot unit does not retry (ADR-0054); every other refusal is 1, which it does.
 */
export function hostStartExitCode(error: unknown): number {
  return error instanceof HostLockHeldError ? HOST_LOCK_HELD_EXIT_CODE : 1
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
    if (error instanceof HostLockError || error instanceof HostArgumentError || error instanceof HostKeyMigrationError) console.error(error.message)
    else console.error('Check the data folder and its original key file, then retry with the same --data and --key-file: host/index.js from an extracted archive, out/host/index.js from a checkout.')
    process.exitCode = hostStartExitCode(error)
  }
}

if (require.main === module) void runHeadlessCommandLine()
