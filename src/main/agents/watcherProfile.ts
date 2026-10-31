import type { WatcherLaunchProfile } from './host'

/** A definitive refusal before sending, also suitable for a recovery notice. */
export class WatcherProfileRefusal extends Error {
  readonly code = 'READ_ONLY_PROFILE_UNAVAILABLE' as const
  readonly retryable = false
  constructor(reason: string) { super(reason); this.name = 'WatcherProfileRefusal' }
}
/**
 * The refusal an earlier Watcher conversation answers with: it is read only history, so a send to it is refused, and
 * nothing is wrong with its provider. Opening it to read is not a failure, so it never becomes the provider's error.
 */
export class WatcherHistoryRefusal extends WatcherProfileRefusal {
  constructor() { super('This earlier Watcher conversation is read only history. Open Watcher to continue.'); this.name = 'WatcherHistoryRefusal' }
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
