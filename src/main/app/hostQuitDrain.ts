import { registerQuitDrain, type SystemShutdownSource } from './quitDrain'

interface AsyncClose { close(): Promise<void> }
/** Startup fills these handles before starting each resource. */
export interface HostQuitHandles {
  localRuntime?: AsyncClose
  desktopHosts?: AsyncClose
  personalChats?: AsyncClose
  phoneAccess?: AsyncClose
  hostSetup?: AsyncClose
  hostSetupTools?: AsyncClose
  visualTools?: AsyncClose
  providerJobs?: { close(): void }
  hostUpdates?: { dispose(): void }
  hostBoot?: { dispose(): void }
  hostPhones?: { close(): void }
  hostRouter?: { dispose(): void }
  stopPublishing?: () => void
  /** Releases every live cloud iPhone session (ADR-0047) before Sotto exits, so run.cloud is never left billing. */
  cloudIphone?: AsyncClose
}

export function registerHostQuitDrain(app: Parameters<typeof registerQuitDrain>[0], handles: HostQuitHandles, failed: () => void, phoneFailed: () => void, systemShutdown?: SystemShutdownSource): void {
  registerQuitDrain(app, async () => {
    handles.stopPublishing?.()
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
      handles.desktopHosts?.close(), handles.localRuntime?.close(),
      handles.personalChats?.close(), handles.hostSetupTools?.close(), handles.visualTools?.close(),
      handles.cloudIphone?.close(),
    ])
    handles.hostRouter?.dispose()
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }, failed, systemShutdown)
}
