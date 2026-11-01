/**
 * What a thread's usage visit throws while the thread's saved requests are still being read (#1937): Usage visits it again
 * once they are, rather than reading its ledger a second time.
 */
export class UsageReadPending extends Error {
  constructor() { super('The thread\'s usage is still being read.'); this.name = 'UsageReadPending' }
}
