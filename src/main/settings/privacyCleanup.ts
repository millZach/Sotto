/** Settings saves also retry privacy cleanup that failed on an earlier save. */
export async function cleanSettingsHistory(agentControl: { privacyChanged(): Promise<void> }, personalChats: { privacyChanged(): Promise<void> }, notify: () => Promise<void> = async () => undefined): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => agentControl.privacyChanged()),
    Promise.resolve().then(() => personalChats.privacyChanged()),
  ])
  // The saved settings already apply, even when a store must retry redaction.
  const notification = await Promise.allSettled([Promise.resolve().then(notify)])
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
  if (notification[0]?.status === 'rejected') throw notification[0].reason
}
