import type { UpdaterAdapter, UpdaterEvent } from './updateService'

/**
 * An updater for a development end-to-end run (`SOTTO_E2E_APP_UPDATE`), so a journey can see Update all with a Sotto
 * update waiting (ADR-0077). A check offers `version`, a download counts up to it and keeps nothing, and installing is
 * refused: the run never quits into an installer, and nothing reaches the network.
 */
export function e2eUpdater(version: string, stepMs = 150): UpdaterAdapter {
  let listener: (event: UpdaterEvent) => void = () => undefined
  const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, stepMs))
  return {
    subscribe(next): void { listener = next },
    async check(): Promise<void> {
      listener({ type: 'checking' })
      listener({ type: 'available', version })
    },
    async download(): Promise<void> {
      for (const percent of [20, 55, 90]) { listener({ type: 'progress', percent }); await pause() }
      listener({ type: 'downloaded', version })
    },
    quitAndInstall(): void { throw new Error('A test run does not install updates.') },
  }
}
