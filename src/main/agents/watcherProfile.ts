import type { WatcherLaunchProfile } from './host'

/** A definitive refusal before sending, also suitable for a recovery notice. */
export class WatcherProfileRefusal extends Error {
  readonly code = 'READ_ONLY_PROFILE_UNAVAILABLE' as const
  readonly retryable = false
  constructor(reason: string) { super(reason); this.name = 'WatcherProfileRefusal' }
}

export function validateWatcherProfile(profile: WatcherLaunchProfile): void {
  let url: URL
  try { url = new URL(profile.server.url) }
  catch { throw new WatcherProfileRefusal('Watcher’s tool server could not be verified. Nothing was sent. Reopen Watcher to try again.') }
  if (profile.server.name !== 'sotto_threads' || profile.server.type !== 'http' || url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1' || url.username || url.password || !profile.toolNames.length
    || new Set(profile.toolNames).size !== profile.toolNames.length
    || profile.toolNames.some(name => !/^[a-z][a-z0-9_]*$/u.test(name))) {
    throw new WatcherProfileRefusal('Watcher’s tool server could not be verified. Nothing was sent. Reopen Watcher to try again.')
  }
}
