import { registerQuitDrain, type SystemShutdownSource } from './quitDrain'

interface AsyncClose { close(): Promise<void> }
/** Startup fills these handles before starting each resource. */
export interface HostQuitHandles {
  localRuntime?: AsyncClose & { prepareForShutdown?(): Promise<void> }
  desktopHosts?: AsyncClose
  phoneAccess?: AsyncClose
  hostSetup?: AsyncClose
  hostSetupTools?: AsyncClose
  visualTools?: AsyncClose
  mediaTools?: AsyncClose
  pullRequestTools?: AsyncClose
  delegationTools?: AsyncClose
  providerJobs?: { close(): void }
  hostUpdates?: { dispose(): void }
  hostBoot?: { dispose(): void }
  hostPhones?: { close(): void }
  hostRouter?: { dispose(): void }
  stopPublishing?: () => void
  /** Releases every live cloud iPhone session (ADR-0047) before Sotto exits, so run.cloud is never left billing. */
  cloudIphone?: AsyncClose
}

export function registerHostQuitDrain(app: Parameters<typeof registerQuitDrain>[0], handles: HostQuitHandles, failed: () => void, phoneFailed: () => void, platform: NodeJS.Platform, powerMonitor: SystemShutdownSource): void {
  let publishingStopped = false
  const stopPublishing = (): void => {
    if (publishingStopped) return
    publishingStopped = true
    handles.stopPublishing?.()
  }
  let localClosing: Promise<void> | undefined, cloudClosing: Promise<void> | undefined
  const closeLocal = (): Promise<void> | undefined => localClosing ??= handles.localRuntime?.close()
  const closeCloud = (): Promise<void> | undefined => cloudClosing ??= handles.cloudIphone?.close()
  const prepare = (): void => {
    stopPublishing()
    // Stop providers and drain accepted writes without waiting for a sweep or phone cleanup.
    // The final local close still keeps stores alive until those users finish.
    const local = handles.localRuntime?.prepareForShutdown?.() ?? closeLocal()
    // Observe errors immediately; the final closes await these same results and report them.
    void local?.catch(() => undefined)
    void closeCloud()?.catch(() => undefined)
  }
  registerQuitDrain(app, async () => {
    stopPublishing()
    // Closing the local runtime drains a worktree cleanup sweep in progress before its host closes (ADR-0041).
    // Remove phone access before closing the host it serves (ADR-0033).
    await handles.phoneAccess?.close().catch(phoneFailed)
    // A setup running now ends as Stop setup would, before the hosts it checks and adds close.
    await handles.hostSetup?.close().catch(() => undefined)
    handles.providerJobs?.close()
    handles.hostUpdates?.dispose()
    handles.hostBoot?.dispose()
    handles.hostPhones?.close()
    const results = await Promise.allSettled([
      handles.desktopHosts?.close(), closeLocal(),
      handles.hostSetupTools?.close(), handles.visualTools?.close(), handles.mediaTools?.close(), handles.pullRequestTools?.close(), handles.delegationTools?.close(),
      closeCloud(),
    ])
    handles.hostRouter?.dispose()
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }, failed, platform === 'darwin' || platform === 'linux' ? { source: powerMonitor, platform, prepare } : undefined)
}
