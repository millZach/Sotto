/**
 * What a thread's usage visit throws while the thread's saved requests are still being read (#1937): Usage visits it again
 * once they are, rather than reading its ledger a second time.
 */
export class UsageReadPending extends Error {
  constructor() { super('The thread\'s usage is still being read.'); this.name = 'UsageReadPending' }
}

/**
 * What a thread's usage visit throws when it has visited one chunk of the thread's rows and more are to come: Usage visits
 * it again in its next task, which goes on where this one stopped, so a long thread's rows never fill one task (#1937).
 */
export class UsageVisitUnfinished extends Error {
  constructor() { super('The thread\'s usage has more rows to visit.'); this.name = 'UsageVisitUnfinished' }
}
